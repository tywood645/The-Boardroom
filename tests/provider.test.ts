import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installMockFetch, restoreFetch, onFetch, anthropicSSE, openaiSSE, errorResponse } from './helpers/mock-fetch.ts';

process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
process.env.OPENAI_API_KEY = 'test-key-openai';
process.env.XAI_API_KEY = 'test-key-xai';
process.env.GOOGLE_API_KEY = 'test-key-google';
process.env.DEEPSEEK_API_KEY = 'test-key-deepseek';
process.env.PERPLEXITY_API_KEY = 'test-key-perplexity';

import { detectProviders, createProvider, seatModelEnv } from '../src/provider/factory.js';

describe('Provider factory', () => {
  it('detects all 6 providers', () => {
    const names = detectProviders().map(p => p.name);
    assert.deepEqual(names, ['anthropic', 'openai', 'xai', 'google', 'deepseek', 'perplexity']);
  });
});

describe('Anthropic streaming', () => {
  before(() => installMockFetch());
  after(() => restoreFetch());

  it('yields text from SSE', async () => {
    onFetch(() => anthropicSSE('BoardRoom CEO advice'));

    const p = createProvider({ name: 'anthropic', type: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5' });
    let text = '';
    for await (const ev of p.createMessage({
      system: 'test', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 100, model: 'claude-sonnet-5',
    })) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') text += ev.delta.text;
    }
    assert.equal(text, 'BoardRoom CEO advice');
  });
});

describe('OpenAI-compat streaming', () => {
  before(() => installMockFetch());
  after(() => restoreFetch());

  it('yields text from SSE', async () => {
    onFetch(() => openaiSSE('COO operations advice'));

    const p = createProvider({
      name: 'openai', type: 'openai', apiKey: 'k', model: 'gpt-5.6-terra', baseUrl: 'https://api.openai.com/v1',
    });
    let text = '';
    for await (const ev of p.createMessage({
      system: 'test', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 100, model: 'gpt-5.6-terra',
    })) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') text += ev.delta.text;
    }
    assert.equal(text, 'COO operations advice');
  });
});

// Every seat used to be hardcoded except Anthropic's, so a stale default could
// only be worked around by editing source. The catalog will go out of date
// again; being able to name any model without a code change is the thing that
// makes that survivable.
describe('per-seat model overrides', () => {
  const VENDORS = ['anthropic', 'openai', 'xai', 'google', 'deepseek', 'perplexity'];
  const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'PERPLEXITY_API_KEY'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    const names = [...KEYS, 'BOARDROOM_BACKEND', ...VENDORS.map(seatModelEnv)];
    saved = Object.fromEntries(names.map(k => [k, process.env[k]]));
    process.env.BOARDROOM_BACKEND = 'keys';
    for (const k of KEYS) process.env[k] = 'test-key';
    for (const v of VENDORS) delete process.env[seatModelEnv(v)];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('seats all six vendors by default', () => {
    assert.deepEqual(detectProviders().map(p => p.name).sort(), [...VENDORS].sort());
  });

  it('lets every seat name any model, not just the Anthropic one', () => {
    for (const vendor of VENDORS) process.env[seatModelEnv(vendor)] = `custom-${vendor}-model`;

    for (const p of detectProviders()) {
      assert.equal(p.model, `custom-${p.name}-model`, `${p.name} ignored ${seatModelEnv(p.name)}`);
    }
  });

  it('falls back to the seat default when no override is set', () => {
    process.env[seatModelEnv('google')] = 'gemini-experimental-whatever';
    const byName = new Map(detectProviders().map(p => [p.name, p.model]));
    assert.equal(byName.get('google'), 'gemini-experimental-whatever');
    assert.equal(byName.get('openai'), 'gpt-5.6-terra');
  });
});
