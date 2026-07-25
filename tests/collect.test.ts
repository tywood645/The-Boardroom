import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installMockFetch,
  restoreFetch,
  onFetch,
  openaiSSE,
  openaiSSENoDone,
  openaiLine,
  anthropicSSE,
  streamingResponse,
  queue,
  countingHandler,
} from './helpers/mock-fetch.ts';
import { collectStream } from '../src/provider/collect.ts';
import { createProvider } from '../src/provider/factory.ts';
import { CostTracker } from '../src/cost/tracker.ts';
import { BudgetError } from '../src/util/error.ts';

const OPENAI_CFG = {
  name: 'openai',
  type: 'openai' as const,
  apiKey: 'test',
  model: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1',
};

const ANTHROPIC_CFG = {
  name: 'anthropic',
  type: 'anthropic' as const,
  apiKey: 'test',
  model: 'claude-sonnet-4-20250514',
};

const PARAMS = {
  system: 'be brief',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [],
  maxTokens: 64,
  model: 'gpt-4o',
};

describe('collectStream token accounting', () => {
  beforeEach(() => {
    restoreFetch();
    installMockFetch();
  });
  after(() => restoreFetch());

  // Regression for the bug where message_start carried input tokens but was
  // emitted on the first content delta, before the end-of-stream usage chunk
  // had been parsed. Every OpenAI-compatible vendor reported 0 input tokens,
  // so half of every call's cost went uncounted.
  it('reports input tokens carried on the end-of-stream usage chunk', async () => {
    onFetch(() => openaiSSE('hi there', { inputTokens: 137, outputTokens: 9 }));
    const r = await collectStream(createProvider(OPENAI_CFG), PARAMS);
    assert.equal(r.inputTokens, 137);
    assert.equal(r.outputTokens, 9);
    assert.equal(r.estimatedInput, false);
  });

  it('reports both token counts when [DONE] never arrives', async () => {
    onFetch(() => openaiSSENoDone('hi there', { inputTokens: 50, outputTokens: 7 }));
    const r = await collectStream(createProvider(OPENAI_CFG), PARAMS);
    assert.equal(r.inputTokens, 50);
    assert.equal(r.outputTokens, 7);
  });

  it('keeps message_start authoritative on the Anthropic path', async () => {
    onFetch(() => anthropicSSE('hi there', { inputTokens: 88, outputTokens: 4 }));
    const r = await collectStream(createProvider(ANTHROPIC_CFG), { ...PARAMS, model: ANTHROPIC_CFG.model });
    assert.equal(r.inputTokens, 88);
    assert.equal(r.outputTokens, 4);
  });

  it('falls back to an estimate when a vendor reports no usage at all', async () => {
    onFetch(() =>
      streamingResponse([openaiLine({ content: 'hi' }), 'data: [DONE]\n']),
    );
    const r = await collectStream(createProvider(OPENAI_CFG), PARAMS);
    assert.ok(r.inputTokens > 0, 'a silent vendor must not look free');
    assert.equal(r.estimatedInput, true);
  });

  it('computes cost at collection time, not at render time', async () => {
    onFetch(() => openaiSSE('hi', { inputTokens: 1000, outputTokens: 1000 }));
    const r = await collectStream(createProvider(OPENAI_CFG), PARAMS);
    // gpt-4o: (1000*2.50 + 1000*10.0)/1M
    assert.ok(Math.abs(r.cost - 0.0125) < 1e-9, `got ${r.cost}`);
  });
});

describe('collectStream retry safety', () => {
  beforeEach(() => {
    restoreFetch();
    installMockFetch();
  });
  after(() => restoreFetch());

  // The retry loop used to wrap the streaming body, so a failure after some
  // deltas had been yielded re-issued the whole request. Consumers accumulate
  // text outside the generator, so they ended up with attempt 1's prefix plus
  // all of attempt 2.
  it('does not re-issue a request whose body already produced content', async () => {
    const handler = countingHandler(
      queue([
        streamingResponse([openaiLine({ content: 'Hello' })], { errorAfter: 1 }),
        openaiSSE('Hello world'),
      ]),
    );
    onFetch(handler);

    await assert.rejects(() => collectStream(createProvider(OPENAI_CFG), PARAMS));
    assert.equal(handler.calls, 1, 'a partially consumed stream must not be retried');
  });

  it('still retries when the body fails before any content', async () => {
    const handler = countingHandler(
      queue([streamingResponse([], { errorAfter: 0 }), openaiSSE('Hello world')]),
    );
    onFetch(handler);

    const r = await collectStream(createProvider(OPENAI_CFG), PARAMS);
    assert.equal(r.text, 'Hello world');
    assert.equal(handler.calls, 2);
  });
});

describe('collectStream budget enforcement', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'boardroom-gate-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
    restoreFetch();
  });

  beforeEach(() => {
    restoreFetch();
    installMockFetch();
  });

  // The cap check used to run inside the render path, after every call had
  // already been made. A "blocked" alert could report an overrun but never
  // prevent one.
  it('blocks before any network call when the cap is already spent', async () => {
    const handler = countingHandler(() => openaiSSE('must not happen'));
    onFetch(handler);

    const tracker = new CostTracker({ sessionCap: 0.01 });
    tracker.recordUsage('claude-opus-4-20250514', 1000, 1000); // $0.09

    await assert.rejects(
      () => collectStream(createProvider(OPENAI_CFG), PARAMS, { tracker }),
      BudgetError,
    );
    assert.equal(handler.calls, 0, 'the gate must fire before dispatch');
  });

  it('blocks on the projected worst case, before a single token is spent', async () => {
    const handler = countingHandler(() => openaiSSE('must not happen'));
    onFetch(handler);

    // maxTokens 100000 of opus output is ~$7.50, well past a $0.50 cap, even
    // though nothing has been spent yet.
    const tracker = new CostTracker({ sessionCap: 0.5 });
    await assert.rejects(
      () =>
        collectStream(
          createProvider(ANTHROPIC_CFG),
          { ...PARAMS, model: 'claude-opus-4-20250514', maxTokens: 100_000 },
          { tracker },
        ),
      BudgetError,
    );
    assert.equal(handler.calls, 0);
    assert.equal(tracker.getSessionStats().cost, 0);
  });

  it('allows a call that fits inside the cap', async () => {
    onFetch(() => openaiSSE('fine', { inputTokens: 10, outputTokens: 5 }));
    const tracker = new CostTracker({ sessionCap: 5 });
    const r = await collectStream(createProvider(OPENAI_CFG), PARAMS, { tracker });
    assert.equal(r.text, 'fine');
    assert.ok(tracker.getSessionStats().cost > 0);
  });
});

describe('CostTracker write batching', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'boardroom-flush-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // usage.json used to be fully read, parsed, filtered and rewritten on every
  // single recordUsage call, with checkBudget reading it twice more on top.
  it('writes nothing until flush, then writes every entry once', () => {
    const usagePath = join(tmpDir, '.boardroom', 'usage.json');
    const tracker = new CostTracker();

    for (let i = 0; i < 20; i++) tracker.recordUsage('gpt-4o', 100, 50);
    assert.equal(existsSync(usagePath), false, 'recordUsage must not touch disk');

    tracker.flush();
    const parsed = JSON.parse(readFileSync(usagePath, 'utf-8'));
    assert.equal(parsed.entries.length, 20);
  });

  it('counts pending entries in daily spend before they are flushed', () => {
    const tracker = new CostTracker();
    tracker.recordUsage('gpt-4o', 1000, 1000);
    assert.ok(tracker.getDailySpend() > 0, 'caps must see spend that is not yet on disk');
  });
});
