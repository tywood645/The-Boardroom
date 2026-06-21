import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installMockFetch, restoreFetch, onFetch, anthropicSSE, openaiSSE } from './helpers/mock-fetch.ts';

process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
process.env.OPENAI_API_KEY = 'test-key-openai';
process.env.XAI_API_KEY = 'test-key-xai';
process.env.GOOGLE_API_KEY = 'test-key-google';
process.env.DEEPSEEK_API_KEY = 'test-key-deepseek';
process.env.PERPLEXITY_API_KEY = 'test-key-perplexity';

import { askPanel, type Seat } from '../src/boardroom/panel.js';
import { detectProviders } from '../src/provider/factory.js';
import { roleForVendor, ROLES } from '../src/boardroom/roles.js';

describe('askPanel', () => {
  before(() => {
    installMockFetch();
    onFetch((url) => {
      if (url.includes('anthropic.com')) return anthropicSSE('CEO mock response');
      return openaiSSE('Advisor mock response');
    });
  });

  after(() => restoreFetch());

  it('runs all seats in parallel and returns answers', async () => {
    const configs = detectProviders();
    const seats: Seat[] = configs.map(c => {
      const role = roleForVendor(c.name)!;
      return { config: c, role: role.name, system: role.mindset };
    });

    const answers = await askPanel(seats, 'Should we raise a seed round?');
    assert.equal(answers.length, 6);

    for (const a of answers) {
      assert.ok(a.role, 'role should be set');
      assert.ok(a.text.length > 0, `${a.role} should have text`);
      assert.equal(a.error, undefined, `${a.role} should not error`);
    }
  });

  it('CEO seat gets anthropic and correct text', async () => {
    const configs = detectProviders();
    const ceoConfig = configs.find(c => c.name === 'anthropic')!;
    const seats: Seat[] = [{ config: ceoConfig, role: 'CEO', system: ROLES.CEO.mindset }];

    const answers = await askPanel(seats, 'Test');
    assert.equal(answers.length, 1);
    assert.equal(answers[0].role, 'CEO');
    assert.equal(answers[0].text, 'CEO mock response');
  });
});

describe('Role assignments', () => {
  it('all 6 vendors have a default role', () => {
    for (const vendor of ['anthropic', 'openai', 'deepseek', 'xai', 'google', 'perplexity']) {
      const role = roleForVendor(vendor);
      assert.ok(role, `${vendor} should have a default role`);
    }
  });

  it('Devil role exists (standing rule)', () => {
    assert.ok(ROLES.DEVIL);
    assert.equal(ROLES.DEVIL.name, 'Devil');
  });
});
