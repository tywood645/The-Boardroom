import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installMockFetch,
  restoreFetch,
  onFetch,
  openaiSSE,
  openaiLine,
  streamingResponse,
  countingHandler,
  errorResponse,
  queue,
} from './helpers/mock-fetch.ts';
import { collectStream, estimateTokens } from '../src/provider/collect.ts';
import { createProvider } from '../src/provider/factory.ts';
import { CostTracker } from '../src/cost/tracker.ts';
import { costOf } from '../src/cost/catalog.ts';
import { BudgetError, DeadlineError } from '../src/util/error.ts';
import { Deadline } from '../src/util/abort.ts';
import { Semaphore } from '../src/util/semaphore.ts';
import { parsePositiveInt } from '../src/cli/args.ts';

const SOL = {
  name: 'openai',
  type: 'openai' as const,
  apiKey: 'test',
  model: 'gpt-5.6-sol',
  baseUrl: 'https://api.openai.com/v1',
};

function params(over: Record<string, unknown> = {}) {
  return {
    system: 'be brief',
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [],
    maxTokens: 1024,
    model: 'gpt-5.6-sol',
    ...over,
  };
}

function useTempHome() {
  let tmpDir: string;
  let origHome: string | undefined;
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'boardroom-budget-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });
  after(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
    restoreFetch();
  });
  beforeEach(() => {
    // A fresh HOME per test keeps one test's ledger out of the next one's caps.
    process.env.HOME = mkdtempSync(join(tmpDir, 'h-'));
    restoreFetch();
    installMockFetch();
  });
}

describe('R-001: concurrent calls cannot all pass one stale total', () => {
  useTempHome();

  it('keeps a six-way fan-out under the session cap', async () => {
    // Each call really spends ~$0.031 (1024 output tokens of gpt-5.6-sol).
    onFetch(() => openaiSSE('x', { inputTokens: 100, outputTokens: 1024 }));
    const tracker = new CostTracker({ sessionCap: 0.04 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        collectStream(createProvider(SOL), params(), { tracker, limiter: new Semaphore(6) }),
      ),
    );
    const spent = tracker.getSessionStats().cost;
    assert.ok(spent <= 0.04, `spent ${spent} against a 0.04 cap`);
    assert.ok(results.some(r => r.status === 'rejected' && r.reason instanceof BudgetError));
  });

  it('waits for in-flight calls to settle instead of refusing calls that will fit', async () => {
    // Worst case ~$0.031 each, so only three holds fit under $0.10 at once,
    // but each call actually costs a fraction of a cent: all six must run.
    onFetch(() => new Promise<Response>(r => setTimeout(() => r(openaiSSE('x', { inputTokens: 10, outputTokens: 5 })), 5)));
    const tracker = new CostTracker({ sessionCap: 0.1 });
    const limiter = new Semaphore(6);
    const out = await Promise.all(
      Array.from({ length: 6 }, () => collectStream(createProvider(SOL), params(), { tracker, limiter })),
    );
    assert.equal(out.length, 6);
    assert.ok(tracker.getSessionStats().cost < 0.1);
  });
});

describe('R-002: concurrent processes share one ledger', () => {
  useTempHome();

  it('neither tracker loses the other\'s spend, and the cap sees both', () => {
    const a = new CostTracker({ dailyCap: 1 });
    const b = new CostTracker({ dailyCap: 1 });
    a.getDailySpend();
    b.getDailySpend(); // both load history before either records
    a.recordUsage('gpt-5.6-sol', 0, 20000); // $0.60
    b.recordUsage('gpt-5.6-sol', 0, 20000); // $0.60

    const c = new CostTracker({ dailyCap: 1 });
    assert.ok(Math.abs(c.getDailySpend() - 1.2) < 1e-9, `got ${c.getDailySpend()}`);
    assert.ok(Math.abs(a.getDailySpend() - 1.2) < 1e-9, 'a sees b without restarting');
    assert.equal(c.reserve('gpt-5.6-sol', 0, 1000).alert?.type, 'blocked');
  });

  it('counts another process\'s open hold against the daily cap', () => {
    const a = new CostTracker({ dailyCap: 1 });
    const b = new CostTracker({ dailyCap: 1 });
    const r = a.reserve('gpt-5.6-sol', 0, 30000); // $0.90 held, not yet spent
    assert.ok(r.hold);
    assert.equal(b.reserve('gpt-5.6-sol', 0, 10000).alert?.type, 'blocked');
    a.release(r.hold!);
    assert.ok(b.reserve('gpt-5.6-sol', 0, 10000).hold, 'a released hold stops counting');
  });

  it('ignores negative and non-finite ledger lines', () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, '.boardroom', 'usage'), { recursive: true });
    const month = new Date().toISOString().slice(0, 7);
    const ts = new Date().toISOString();
    appendFileSync(
      join(home, '.boardroom', 'usage', `${month}.jsonl`),
      JSON.stringify({ t: 'use', ts, src: 'evil', model: 'm', in: 0, out: 0, cost: -60000 }) + '\n' +
        '{"t":"use","ts":"' + ts + '","src":"evil","model":"m","in":0,"out":0,"cost":1e999}\n' +
        JSON.stringify({ t: 'use', ts, src: 'ok', model: 'm', in: 1, out: 1, cost: 0.25 }) + '\n',
    );
    writeFileSync(join(home, '.boardroom', 'usage.json'), JSON.stringify({ entries: [{ timestamp: ts, cost: -5 }] }));
    assert.equal(new CostTracker().getDailySpend(), 0.25);
  });
});

describe('R-003: a stream with no usage chunk is not free', () => {
  useTempHome();

  it('charges an upper-bound output estimate and says so', async () => {
    const big = 'word '.repeat(4000); // 20,000 bytes
    onFetch(() => streamingResponse([openaiLine({ content: big }, 'gpt-5.6-sol'), 'data: [DONE]\n']));
    const tracker = new CostTracker();
    const r = await collectStream(createProvider(SOL), params({ maxTokens: 300 }), { tracker });
    assert.equal(r.estimatedOutput, true);
    assert.equal(r.outputTokens, 300, 'capped at maxTokens, which the vendor enforces');
    assert.ok(r.cost >= costOf('gpt-5.6-sol', 0, 300));
  });

  it('trusts a reported output count of zero', async () => {
    onFetch(() => openaiSSE('', { inputTokens: 10, outputTokens: 0 }));
    const r = await collectStream(createProvider(SOL), params());
    assert.equal(r.outputTokens, 0);
    assert.equal(r.estimatedOutput, false);
  });
});

describe('R-004: failed calls are charged, refused calls are not', () => {
  useTempHome();

  it('charges a stream that fails after content', async () => {
    onFetch(() => streamingResponse([openaiLine({ content: 'partial '.repeat(100) })], { errorAfter: 1 }));
    const tracker = new CostTracker();
    await assert.rejects(() => collectStream(createProvider(SOL), params(), { tracker }), /socket hang up/);
    const s = tracker.getSessionStats();
    assert.ok(s.inputTokens > 0 && s.outputTokens > 0 && s.cost > 0, JSON.stringify(s));
    assert.ok(new CostTracker().getDailySpend() > 0, 'and it is on disk for the next run');
  });

  it('charges a call cut off by the deadline', async () => {
    onFetch(() =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(new TextEncoder().encode(openaiLine({ content: 'partial' }))); },
          pull() { return new Promise<void>(() => {}); },
        }),
        { status: 200 },
      ),
    );
    const keepAlive = setInterval(() => {}, 5);
    const deadline = new Deadline(40, 'test');
    const tracker = new CostTracker();
    try {
      await assert.rejects(
        () => collectStream(createProvider(SOL), params(), { tracker, signal: deadline.signal }),
        DeadlineError,
      );
    } finally {
      deadline.dispose();
      clearInterval(keepAlive);
    }
    assert.ok(tracker.getSessionStats().cost > 0);
  });

  it('releases the hold without charge when the vendor rejects the request', async () => {
    onFetch(() => errorResponse(400, 'bad request'));
    const tracker = new CostTracker({ sessionCap: 0.04 });
    await assert.rejects(() => collectStream(createProvider(SOL), params(), { tracker }));
    assert.equal(tracker.getSessionStats().cost, 0);
    // The released hold must not linger: a call needing the whole cap still fits.
    restoreFetch();
    installMockFetch();
    onFetch(() => openaiSSE('ok', { inputTokens: 10, outputTokens: 5 }));
    await collectStream(createProvider(SOL), params(), { tracker });
  });

  it('charges the input of an attempt abandoned before content and retried', async () => {
    onFetch(
      queue([
        () => streamingResponse([openaiLine({ role: 'assistant' })], { errorAfter: 1 }),
        () => openaiSSE('ok', { inputTokens: 10, outputTokens: 5 }),
      ]),
    );
    const p = params();
    const r = await collectStream(createProvider(SOL), p);
    assert.equal(r.inputTokens, 10 + estimateTokens(p), 'the retry and the dropped attempt');
  });
});

describe('BR-009: reservation is an upper bound on input tokens', () => {
  useTempHome();

  it('blocks token-dense input that chars/4 would have under-reserved', async () => {
    const handler = countingHandler(() => openaiSSE('must not happen'));
    onFetch(handler);
    const dense = '龘'.repeat(20000); // 20,000 chars, 60,000 UTF-8 bytes
    const p = params({ model: 'gpt-5.6-terra', maxTokens: 1, messages: [{ role: 'user', content: dense }] });
    assert.ok(estimateTokens(p) >= 60000);
    const tracker = new CostTracker({ sessionCap: 0.02 });
    await assert.rejects(
      () => collectStream(createProvider({ ...SOL, model: 'gpt-5.6-terra' }), p, { tracker }),
      BudgetError,
    );
    assert.equal(handler.calls, 0);
  });
});

describe('BR-010: provider usage values are validated', () => {
  useTempHome();

  for (const [label, usage] of [
    ['negative', { prompt_tokens: -1_000_000_000, completion_tokens: -1_000_000_000 }],
    ['non-numeric', { prompt_tokens: 'lots', completion_tokens: { n: 1 } }],
    ['fractional', { prompt_tokens: 1.5, completion_tokens: 2.5 }],
    ['implausible', { prompt_tokens: 1e12, completion_tokens: 1e12 }],
  ] as const) {
    it(`replaces ${label} counts with conservative estimates`, async () => {
      onFetch(() =>
        streamingResponse([
          openaiLine({ content: 'hi' }, 'gpt-5.6-sol'),
          `data: ${JSON.stringify({ choices: [], usage })}\n`,
          'data: [DONE]\n',
        ]),
      );
      const tracker = new CostTracker();
      const p = params();
      const r = await collectStream(createProvider(SOL), p, { tracker });
      assert.equal(r.estimatedInput, true);
      assert.equal(r.estimatedOutput, true);
      assert.equal(r.inputTokens, estimateTokens(p));
      assert.ok(r.cost > 0);
      assert.ok(tracker.getDailySpend() > 0);
    });
  }
});

describe('R-007: unbounded or NaN limits fail closed', () => {
  useTempHome();

  it('rejects a NaN maxTokens before any request', async () => {
    const handler = countingHandler(() => openaiSSE('must not happen'));
    onFetch(handler);
    for (const maxTokens of [NaN, -1, 0, 1.5]) {
      await assert.rejects(() => collectStream(createProvider(SOL), params({ maxTokens })), /maxTokens/);
    }
    assert.equal(handler.calls, 0);
  });

  it('blocks a non-finite projected cost even with no cap configured', () => {
    assert.equal(new CostTracker().reserve('gpt-5.6-sol', 0, NaN).alert?.type, 'blocked');
  });

  it('parses only strict positive integers on the CLI', () => {
    assert.equal(parsePositiveInt('1024'), 1024);
    for (const bad of ['abc', '', '0', '-1', '1e3', '12abc', '1.5', undefined]) {
      assert.equal(parsePositiveInt(bad), null, String(bad));
    }
  });
});
