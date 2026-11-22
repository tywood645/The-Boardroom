import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { installMockFetch, restoreFetch, onFetch, openaiSSE, countingHandler } from './helpers/mock-fetch.ts';
import { openRouterId, parseOpenRouterIds, costOf, CATALOG } from '../src/cost/catalog.ts';
import { resolveTier, wireModel, hasNoTiers } from '../src/delegate/tiers.ts';
import { delegate } from '../src/delegate/escalate.ts';
import { delegateExitCode } from '../src/cli/delegate.ts';
import { verifyCatalog } from '../src/delegate/verify-catalog.ts';
import { readDelegations } from '../src/delegate/ledger.ts';
import { askExitCode } from '../src/cli.ts';
import type { ProviderConfig } from '../src/provider/factory.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEATS = ['anthropic', 'openai', 'deepseek', 'xai', 'google', 'perplexity'];

const openRouter = (): ProviderConfig[] =>
  SEATS.map(name => ({
    name, type: 'openai', apiKey: 'k', model: 'meta-llama/llama-3.1-8b-instruct',
    baseUrl: 'https://openrouter.ai/api/v1', backend: 'openrouter',
  }));

const LOCAL_MODELS: Record<string, string> = {
  anthropic: 'llama3.1', openai: 'qwen2.5', deepseek: 'deepseek-r1', xai: 'mistral', google: 'gemma2', perplexity: 'phi3',
};
const ollama = (single?: string): ProviderConfig[] =>
  SEATS.map(name => ({
    name, type: 'openai', apiKey: 'ollama', model: single ?? LOCAL_MODELS[name],
    baseUrl: 'http://localhost:11434/v1', backend: 'ollama',
  }));

const ENV = [
  'HOME', 'BOARDROOM_BACKEND', 'OPENROUTER_API_KEY', 'OLLAMA_HOST', 'BOARDROOM_OPENROUTER_IDS', 'BOARDROOM_MODEL_PRICES',
  'BOARDROOM_TIER_CHEAP', 'BOARDROOM_TIER_MID', 'BOARDROOM_TIER_FRONTIER', 'BOARDROOM_VERIFY_FRONTIER',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'PERPLEXITY_API_KEY',
];
let tmpRoot: string;
const saved: Record<string, string | undefined> = {};

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'boardroom-backends-'));
  for (const k of ENV) saved[k] = process.env[k];
});
after(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  restoreFetch();
});
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.HOME = mkdtempSync(join(tmpRoot, 'h-'));
  // Top-tier sampling is random by default; these tests need it off.
  process.env.BOARDROOM_VERIFY_FRONTIER = '0';
  restoreFetch();
  installMockFetch();
});

/** Models named in each request body, in order. */
function recordModels(reply: (body: string) => string) {
  const models: string[] = [];
  onFetch((_u: string, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    models.push(JSON.parse(body).model);
    return openaiSSE(reply(body));
  });
  return models;
}
const isCheck = (body: string) => body.includes('ANSWER TO CHECK');
const CONFIRM = 'VERDICT: CONFIRMED\nDEFECT: none';
const REFUTE = 'VERDICT: REFUTED\nDEFECT: it answers a different question';

describe('OpenRouter model IDs', () => {
  it('derives vendor/model, with xAI under its own namespace', () => {
    assert.equal(openRouterId('gpt-5-nano'), 'openai/gpt-5-nano');
    assert.equal(openRouterId('grok-4.5'), 'x-ai/grok-4.5');
    assert.equal(openRouterId('claude-opus-5'), 'anthropic/claude-opus-5');
    assert.equal(openRouterId('claude-haiku-4-5'), 'anthropic/claude-haiku-4-5-20251001', 'aliases resolve first');
    assert.equal(openRouterId('not-in-the-catalog'), null);
    for (const model of Object.keys(CATALOG)) assert.match(openRouterId(model)!, /^[a-z-]+\/.+$/);
  });

  it('takes a declared ID over the derived one, and still prices it from the catalog', () => {
    process.env.BOARDROOM_BACKEND = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.BOARDROOM_OPENROUTER_IDS = 'claude-haiku-4-5-20251001=anthropic/claude-haiku-4.5';
    assert.equal(openRouterId('claude-haiku-4-5-20251001'), 'anthropic/claude-haiku-4.5');
    assert.equal(costOf('anthropic/claude-haiku-4.5', 1e6, 1e6), costOf('claude-haiku-4-5-20251001', 1e6, 1e6));
    assert.equal(costOf('x-ai/grok-4.5', 1e6, 1e6), costOf('grok-4.5', 1e6, 1e6));
  });

  it('rejects a malformed declaration', () => {
    assert.throws(() => parseOpenRouterIds('gpt-5-nano=gpt-5-nano'), /BOARDROOM_OPENROUTER_IDS/);
    assert.throws(() => parseOpenRouterIds('just-a-model'), /BOARDROOM_OPENROUTER_IDS/);
    assert.equal(parseOpenRouterIds(' a=b/c , d=e/f ').size, 2);
  });
});

describe('delegate on the OpenRouter backend', () => {
  it('puts the OpenRouter ID on the wire and keeps the catalog ID in the result', () => {
    for (const tier of ['cheap', 'mid', 'frontier'] as const) {
      const r = resolveTier(tier, openRouter());
      assert.equal(r.config.model, openRouterId(r.model), tier);
      assert.ok(!r.model.includes('/'), 'the result names the catalog model');
      assert.equal(r.config.baseUrl, 'https://openrouter.ai/api/v1');
    }
  });

  it('maps a pinned catalog model, and passes a full ID through', () => {
    assert.equal(resolveTier('mid', openRouter(), {}, 'openai:gpt-5.6-sol').config.model, 'openai/gpt-5.6-sol');
    assert.equal(resolveTier('mid', openRouter(), {}, 'openai:qwen/qwen-max').config.model, 'qwen/qwen-max');
    assert.equal(wireModel('unknown-model', 'openrouter'), 'unknown-model');
  });

  it('leaves per-vendor keys untouched', () => {
    const keys: ProviderConfig[] = [{ name: 'openai', type: 'openai', apiKey: 'k', model: 'm', baseUrl: 'https://api.openai.com/v1' }];
    assert.equal(resolveTier('cheap', keys).config.model, 'gpt-5-nano');
    assert.equal(wireModel('gpt-5-nano', 'keys'), 'gpt-5-nano');
  });

  it('sends OpenRouter IDs for both the worker and the checker', async () => {
    const models = recordModels(body => (isCheck(body) ? CONFIRM : 'answer'));
    const d = await delegate('write a note', openRouter(), {}, { taskClass: 'draft', stats: new Map() });
    assert.equal(d.finalOutcome, 'confirmed');
    assert.equal(models.length, 2);
    for (const m of models) assert.match(m, /^[a-z-]+\/.+$/, `"${m}" is not an OpenRouter ID`);
    assert.notEqual(models[0], models[1]);
    const [record] = readDelegations();
    assert.ok(!record.model.includes('/'), 'the ledger keeps the catalog ID, so stats stay comparable across backends');
  });
});

describe('delegate on the Ollama backend', () => {
  it('resolves every tier to a configured local model', () => {
    assert.equal(hasNoTiers(ollama()), true);
    assert.equal(hasNoTiers(openRouter()), false);
    for (const tier of ['cheap', 'mid', 'frontier'] as const) {
      const r = resolveTier(tier, ollama());
      assert.equal(r.model, 'llama3.1');
      assert.equal(r.config.baseUrl, 'http://localhost:11434/v1');
      assert.equal(r.blended, 0);
    }
  });

  it('never picks the same model as checker, even under another seat', () => {
    const mixed = ollama().map(c => (c.name === 'openai' ? { ...c, model: 'llama3.1' } : c));
    const r = resolveTier('cheap', mixed, { exclude: ['anthropic:llama3.1'] });
    assert.equal(r.model, 'deepseek-r1');
    assert.throws(() => resolveTier('cheap', ollama('llama3.1'), { exclude: ['anthropic:llama3.1'] }), /No other local model/);
  });

  it('checks with a second local model and does not escalate on a refutation', async () => {
    const models = recordModels(body => (isCheck(body) ? REFUTE : 'answer'));
    const d = await delegate('write a note', ollama(), {}, { taskClass: 'draft', stats: new Map() });
    assert.deepEqual(models, ['llama3.1', 'qwen2.5']);
    assert.equal(d.attempts.length, 1, 'there is no tier to escalate to');
    assert.equal(d.answerOutcome, 'refuted');
    assert.equal(delegateExitCode(d), 2);
    assert.match(d.startWhy, /local backend/);
  });

  it('answers unverified when only one local model is configured', async () => {
    const models = recordModels(() => 'answer');
    const d = await delegate('write a note', ollama('llama3.3'), {}, { taskClass: 'draft', stats: new Map() });
    assert.deepEqual(models, ['llama3.3']);
    assert.equal(d.finalOutcome, 'unverified');
    assert.equal(delegateExitCode(d), 0);
  });
});

describe('--verify-catalog on gateway and local backends', () => {
  it('checks OpenRouter IDs against one fetch of its list', async () => {
    const all = Object.keys(CATALOG).map(m => openRouterId(m)!);
    const gone = openRouterId('gpt-5-nano')!;
    const handler = countingHandler(
      () => new Response(JSON.stringify({ data: [...all.filter(id => id !== gone), 'openai/some-new-model'].map(id => ({ id })) })),
    );
    onFetch(handler);
    const result = await verifyCatalog(openRouter());
    assert.equal(handler.calls, 1, 'six seats share one endpoint');
    assert.equal(result.ok, false);
    const openai = result.reports.find(r => r.vendor === 'openai')!;
    assert.deepEqual(openai.missing, ['gpt-5-nano (looked for openai/gpt-5-nano)']);
    assert.deepEqual(openai.uncatalogued, ['openai/some-new-model']);
    assert.ok(result.reports.filter(r => r.vendor !== 'openai').every(r => r.status === 'ok'));
  });

  it('passes once a wrong derived ID is declared', async () => {
    process.env.BOARDROOM_OPENROUTER_IDS = 'gpt-5-nano=openai/gpt-5-nano-2026';
    const all = Object.keys(CATALOG).map(m => openRouterId(m)!);
    onFetch(() => new Response(JSON.stringify({ data: all.map(id => ({ id })) })));
    assert.equal((await verifyCatalog(openRouter())).ok, true);
  });

  it('skips a local backend without asking it anything', async () => {
    const handler = countingHandler(() => new Response('{}'));
    onFetch(handler);
    const result = await verifyCatalog(ollama());
    assert.equal(handler.calls, 0);
    assert.equal(result.ok, true);
    assert.equal(result.incomplete, true);
    assert.ok(result.reports.every(r => r.status === 'skipped'));
  });
});

describe('ask and motion: exit codes and --json', () => {
  let server: Server;
  let port: number;
  let failing = false;

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        if (failing) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('rejected');
          return;
        }
        const text = body.includes('SECOND phase')
          ? 'SECOND: yes\\nREASON: worth debating'
          : body.includes('DEBATE phase')
            ? 'STANCE: SUPPORT\\nCASE: it is sound'
            : body.includes('FINAL VOTE')
              ? 'VOTE: AYE\\nREASON: agreed'
              : 'Ship it.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: {"choices":[{"index":0,"delta":{"content":"${text}"}}]}\n`);
        res.write('data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5}}\n');
        res.end('data: [DONE]\n');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>(resolve => server.close(() => resolve())));
  beforeEach(() => {
    failing = false;
  });

  /** Run the real CLI. Async, so the stub server in this process can answer it. */
  function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string; home: string }> {
    const home = mkdtempSync(join(tmpRoot, 'cli-'));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
    const child = spawn(process.execPath, ['--import', tsx, join(REPO, 'bin', 'boardroom.ts'), ...args], {
      cwd: home,
      // Explicit, so a developer's own .env or shell keys cannot reach a paid vendor.
      env: {
        PATH: process.env.PATH, HOME: home, NO_PROXY: '127.0.0.1',
        BOARDROOM_BACKEND: 'ollama', OLLAMA_HOST: `http://127.0.0.1:${port}`,
        BOARDROOM_SESSION_CAP: 'none', BOARDROOM_DAILY_CAP: 'none', BOARDROOM_WEEKLY_CAP: 'none',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    return new Promise(resolve => child.on('close', status => resolve({ status, stdout, stderr, home })));
  }

  it('askExitCode is 0 only when some advisor answered', () => {
    assert.equal(askExitCode({ round1: [{ text: 'x' }, { text: '', error: 'boom' }] }), 0);
    assert.equal(askExitCode({ round1: [{ text: '', error: 'boom' }] }), 1);
    assert.equal(askExitCode({ round1: [{ text: '' }] }), 1);
    assert.equal(askExitCode({ round1: [] }), 1);
  });

  it('ask --json prints one JSON document on stdout and progress on stderr', async () => {
    const run = await cli(['ask', '--json', '--no-recall', '--no-consultant', 'Should we ship?']);
    const result = JSON.parse(run.stdout);
    assert.equal(result.question, 'Should we ship?');
    assert.equal(result.round1.length, 6);
    assert.equal(result.round1[0].text, 'Ship it.');
    assert.match(run.stderr, /Convening 6 advisors/);
    assert.equal(run.status, 0);
  });

  it('ask without --json still renders for people, on stdout', async () => {
    const run = await cli(['ask', '--no-recall', '--no-consultant', 'Should we ship?']);
    assert.match(run.stdout, /Convening 6 advisors/);
    assert.match(run.stdout, /=== BOARDROOM ===/);
    assert.equal(run.status, 0);
  });

  it('ask exits 1 when every advisor failed, with or without --json', async () => {
    failing = true;
    const plain = await cli(['ask', '--no-recall', '--no-consultant', 'Should we ship?']);
    assert.equal(plain.status, 1);
    assert.match(plain.stdout, /FAILED/);
    const json = await cli(['ask', '--json', '--no-recall', '--no-consultant', 'Should we ship?']);
    assert.equal(json.status, 1);
    assert.equal(JSON.parse(json.stdout).round1.every((a: { error?: string }) => a.error), true);
  });

  it('motion --json prints the full result and still records the decision', async () => {
    const run = await cli(['motion', '--json', '--no-recall', '--no-consultant', 'Adopt the plan']);
    const result = JSON.parse(run.stdout);
    assert.equal(result.outcome, 'passed');
    assert.deepEqual(result.tally, { aye: 6, nay: 0, abstain: 0 });
    assert.ok(existsSync(result.minutesPath), 'minutes are written either way');
    assert.ok(existsSync(join(run.home, '.boardroom', 'state.json')));
    assert.match(run.stderr, /Motion phases/);
    assert.equal(run.status, 0);
  });

  it('rejects a --rounds value that only starts with a digit', async () => {
    const run = await cli(['ask', '--rounds', '2abc', 'q']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--rounds must be 1 or 2/);
  });
});
