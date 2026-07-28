import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installMockFetch, restoreFetch, onFetch, anthropicSSE, openaiSSE, errorResponse } from './helpers/mock-fetch.ts';

process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
process.env.OPENAI_API_KEY = 'test-key-openai';
process.env.XAI_API_KEY = 'test-key-xai';
process.env.GOOGLE_API_KEY = 'test-key-google';
process.env.DEEPSEEK_API_KEY = 'test-key-deepseek';
process.env.PERPLEXITY_API_KEY = 'test-key-perplexity';

import { detectProviders, createProvider } from '../src/provider/factory.js';

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
