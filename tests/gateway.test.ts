// Gateway backend tests.
//
// The gateway backend is what makes "any model can be any board member" true:
// a seat is a name plus a model string against one OpenAI-compatible endpoint,
// so a board can mix vendors, or seat several models from one vendor, without
// touching roles.ts. These tests cover the parsing rules and the interaction
// with rotation, which is where an arbitrary seat count could go wrong.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { detectProviders } from '../src/provider/factory.js';
import { rotationAssignment, buildRotatedSeats, isLatinSquare, fullRotationCount } from '../src/eval/rotation.js';

const GATEWAY_VARS = [
  'BOARDROOM_BACKEND', 'BOARDROOM_GATEWAY_URL', 'BOARDROOM_GATEWAY_KEY', 'BOARDROOM_GATEWAY_SEATS',
];
const VENDOR_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
  'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'PERPLEXITY_API_KEY',
  'OPENROUTER_API_KEY', 'OLLAMA_HOST',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of [...GATEWAY_VARS, ...VENDOR_KEYS]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function configureGateway(seats: string): void {
  process.env.BOARDROOM_BACKEND = 'gateway';
  process.env.BOARDROOM_GATEWAY_URL = 'http://gateway.invalid:8080/v1';
  process.env.BOARDROOM_GATEWAY_KEY = 'test-key';
  process.env.BOARDROOM_GATEWAY_SEATS = seats;
}

describe('gateway backend', () => {
  it('seats each name with its own model against one endpoint', () => {
    configureGateway('claude=board-claude,grok=board-grok,glm=board-glm');
    const configs = detectProviders();
    assert.equal(configs.length, 3);
    assert.deepEqual(configs.map(c => c.name), ['claude', 'grok', 'glm']);
    assert.deepEqual(configs.map(c => c.model), ['board-claude', 'board-grok', 'board-glm']);
    assert.ok(configs.every(c => c.baseUrl === 'http://gateway.invalid:8080/v1'));
    assert.ok(configs.every(c => c.type === 'openai'));
  });

  it('allows several seats backed by the same vendor', () => {
    // The point of the feature: nothing requires one vendor per seat.
    configureGateway('ceo=claude-opus-5,cfo=claude-sonnet-5,cto=claude-haiku-4-5');
    const configs = detectProviders();
    assert.equal(configs.length, 3);
    assert.equal(new Set(configs.map(c => c.model)).size, 3);
  });

  it('splits on the first = only, so a model string may contain one', () => {
    configureGateway('seat=vendor/model=v2');
    const [config] = detectProviders();
    assert.equal(config.name, 'seat');
    assert.equal(config.model, 'vendor/model=v2');
  });

  it('tolerates whitespace and trailing separators', () => {
    configureGateway(' a = model-a , b = model-b , ');
    const configs = detectProviders();
    assert.deepEqual(configs.map(c => c.name), ['a', 'b']);
    assert.deepEqual(configs.map(c => c.model), ['model-a', 'model-b']);
  });

  it('honours a per-seat model override', () => {
    configureGateway('claude=board-claude');
    process.env.BOARDROOM_CLAUDE_MODEL = 'something-else';
    try {
      assert.equal(detectProviders()[0].model, 'something-else');
    } finally {
      delete process.env.BOARDROOM_CLAUDE_MODEL;
    }
  });

  it('returns nothing when unconfigured, rather than a half-built board', () => {
    process.env.BOARDROOM_BACKEND = 'gateway';
    assert.deepEqual(detectProviders(), []);
    process.env.BOARDROOM_GATEWAY_URL = 'http://gateway.invalid/v1';
    assert.deepEqual(detectProviders(), [], 'a URL with no seats is not a board');
  });

  it('is selected by auto when a seat list is present', () => {
    delete process.env.BOARDROOM_BACKEND;
    process.env.BOARDROOM_GATEWAY_URL = 'http://gateway.invalid/v1';
    process.env.BOARDROOM_GATEWAY_SEATS = 'x=model-x,y=model-y';
    const configs = detectProviders();
    assert.deepEqual(configs.map(c => c.name), ['x', 'y']);
  });

  it('does not hijack auto when no seat list is set', () => {
    delete process.env.BOARDROOM_BACKEND;
    process.env.OPENROUTER_API_KEY = 'or-key';
    const configs = detectProviders();
    assert.ok(configs.every(c => c.baseUrl?.includes('openrouter')), 'should fall through to OpenRouter');
  });
});

describe('gateway boards rotate correctly', () => {
  it('forms a Latin square over an arbitrary seat count', () => {
    // Rotation must not assume exactly six vendors: a gateway board can name
    // any number of seats, and an unbalanced sweep silently re-confounds vendor
    // with role.
    for (const n of [2, 3, 4, 5, 6]) {
      const names = Array.from({ length: n }, (_, i) => `seat${i}`);
      const k = fullRotationCount(n);
      const sweep = Array.from({ length: k }, (_, r) => rotationAssignment(names, r));
      assert.ok(isLatinSquare(sweep), `${n} seats must balance over ${k} rotations`);
    }
  });

  it('assigns real role prompts to gateway seats', () => {
    configureGateway('claude=board-claude,grok=board-grok,glm=board-glm');
    const configs = detectProviders();
    const seats = buildRotatedSeats(configs, 'BASE::', 0);
    assert.equal(seats.length, 3);
    assert.equal(new Set(seats.map(s => s.role)).size, 3, 'each seat gets a distinct role');
    assert.ok(seats.every(s => s.system.startsWith('BASE::') && s.system.length > 8));
  });

  it('moves every gateway seat through every role across the sweep', () => {
    configureGateway('a=m1,b=m2,c=m3');
    const configs = detectProviders();
    const names = configs.map(c => c.name);
    const k = fullRotationCount(names.length);
    const rolesSeen = new Map<string, Set<string>>(names.map(n => [n, new Set<string>()]));
    for (let r = 0; r < k; r++) {
      for (const seat of buildRotatedSeats(configs, 'B', r)) {
        rolesSeen.get(seat.config.name)!.add(seat.role);
      }
    }
    for (const [name, roles] of rolesSeen) {
      assert.equal(roles.size, k, `${name} should have held ${k} distinct roles`);
    }
  });
});
