import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTier, nextTier, DelegationError } from '../src/delegate/tiers.ts';
import { CATALOG, blendedPrice } from '../src/cost/catalog.ts';
import { Semaphore } from '../src/util/semaphore.ts';
import { Deadline } from '../src/util/abort.ts';
import type { ProviderConfig } from '../src/provider/factory.ts';

function cfg(name: string, model: string): ProviderConfig {
  return { name, type: name === 'anthropic' ? 'anthropic' : 'openai', apiKey: 'k', model };
}

const TIER_ENV = ['BOARDROOM_TIER_CHEAP', 'BOARDROOM_TIER_MID', 'BOARDROOM_TIER_FRONTIER'];

describe('cross-vendor tier resolution', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(TIER_ENV.map(k => [k, process.env[k]]));
    for (const k of TIER_ENV) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // The point of the exercise: a tier is a price band, not a model alias.
  // With OpenAI credentialed, cheap is gpt-5-nano at $0.05/$0.40 rather than
  // haiku at $1.00/$5.00 — over 10x on identical work.
  it('picks the cheapest credentialed vendor for a tier, across vendors', () => {
    const configs = [cfg('anthropic', 'a'), cfg('google', 'g'), cfg('openai', 'o')];
    const r = resolveTier('cheap', configs);
    assert.equal(r.vendor, 'openai');
    assert.equal(r.model, 'gpt-5-nano');
  });

  it('falls to the next cheapest when the cheapest vendor has no credentials', () => {
    // OpenAI and DeepSeek own the two cheapest cheap-tier models; with neither
    // credentialed, Google's gemini-3.1-flash-lite at $0.5625 is next.
    const r = resolveTier('cheap', [cfg('google', 'g'), cfg('anthropic', 'a')]);
    assert.equal(r.vendor, 'google');
    assert.equal(r.model, 'gemini-3.1-flash-lite');
  });

  // Two models at an identical blended price must not be separated by their
  // order in the catalog literal. grok-4.5 and gemini-3.6-flash both blend to
  // $3.00; the declared tie-break is cheaper output first, which grok wins
  // ($6.00 against $7.50).
  it('breaks a blended-price tie by a declared rule, not by catalog order', () => {
    assert.equal(
      blendedPrice(CATALOG['grok-4.5']),
      blendedPrice(CATALOG['gemini-3.6-flash']),
      'the tie this test guards has stopped being a tie',
    );
    // grok-4.3 is cheaper still ($1.56) and would win outright, so exclude it
    // to put the two tied models directly against each other.
    const r = resolveTier('mid', [cfg('google', 'g'), cfg('xai', 'x')], {
      exclude: ['xai:grok-4.3'],
    });
    assert.equal(r.model, 'grok-4.5');
  });

  it('resolves cheap to Anthropic only when nothing cheaper is credentialed', () => {
    const r = resolveTier('cheap', [cfg('anthropic', 'claude-sonnet-5')]);
    assert.equal(r.vendor, 'anthropic');
    assert.equal(r.model, 'claude-haiku-4-5-20251001');
  });

  // A tier with no reachable vendor must say so, not silently substitute.
  it('downgrades and says so when a tier has no credentialed vendor', () => {
    const r = resolveTier('frontier', [cfg('deepseek', 'deepseek-v4-flash')]);
    assert.equal(r.downgradedFrom, 'frontier');
    assert.notEqual(r.tier, 'frontier');
  });

  it('honours an env override', () => {
    process.env.BOARDROOM_TIER_CHEAP = 'deepseek:deepseek-v4-flash';
    const r = resolveTier('cheap', [cfg('deepseek', 'x'), cfg('google', 'gemini-3.1-flash-lite')]);
    assert.equal(r.model, 'deepseek-v4-flash');
    assert.match(r.reason, /BOARDROOM_TIER_CHEAP/);
  });

  it('lets an explicit pin beat the env override', () => {
    process.env.BOARDROOM_TIER_CHEAP = 'deepseek:deepseek-v4-flash';
    const r = resolveTier('cheap', [cfg('deepseek', 'x'), cfg('google', 'y')], {}, 'google:gemini-3.1-flash-lite');
    assert.equal(r.vendor, 'google');
    assert.equal(r.reason, 'pinned by flag');
  });

  it('rejects a pin for a vendor with no credentials', () => {
    assert.throws(
      () => resolveTier('cheap', [cfg('google', 'y')], {}, 'deepseek:deepseek-v4-flash'),
      DelegationError,
    );
  });

  // Underpins cross-vendor verification: a model must never check its own work.
  it('excludes a specific vendor:model', () => {
    const configs = [cfg('google', 'g'), cfg('deepseek', 'd')];
    const first = resolveTier('cheap', configs);
    const second = resolveTier('cheap', configs, { exclude: [`${first.vendor}:${first.model}`] });
    assert.notEqual(`${second.vendor}:${second.model}`, `${first.vendor}:${first.model}`);
  });

  it('throws when nothing is credentialed at all', () => {
    assert.throws(() => resolveTier('cheap', []), DelegationError);
  });

  // The README quotes this exact resolution and these exact blended prices as
  // what `delegate stats` prints. Pinning them here means a catalog edit that
  // changes the advertised output cannot land without updating the docs.
  it('resolves the tiers the README advertises, at the prices it quotes', () => {
    const configs = [cfg('anthropic', 'a'), cfg('google', 'g')];
    const expected = [
      ['cheap', 'google', 'gemini-3.1-flash-lite', '0.56'],
      ['mid', 'google', 'gemini-3.6-flash', '3.00'],
      ['frontier', 'anthropic', 'claude-opus-5', '10.00'],
    ] as const;

    for (const [tier, vendor, model, blended] of expected) {
      const r = resolveTier(tier, configs);
      assert.equal(`${r.vendor}/${r.model}`, `${vendor}/${model}`, tier);
      assert.equal(blendedPrice(CATALOG[r.model]).toFixed(2), blended, `${tier} blended price`);
    }
  });

  it('walks the ladder in price order', () => {
    assert.equal(nextTier('cheap'), 'mid');
    assert.equal(nextTier('mid'), 'frontier');
    assert.equal(nextTier('frontier'), null);
  });
});

describe('Semaphore', () => {
  it('never exceeds its limit and still completes every task', async () => {
    const sem = new Semaphore(2);
    let peak = 0;
    let done = 0;

    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const release = await sem.acquire();
        peak = Math.max(peak, sem.inFlight);
        await new Promise(r => setTimeout(r, 5));
        done++;
        release();
      }),
    );

    assert.equal(peak, 2, `expected at most 2 in flight, saw ${peak}`);
    assert.equal(done, 8);
    assert.equal(sem.inFlight, 0);
  });

  it('ignores a double release, so a slot cannot be duplicated', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    assert.equal(sem.inFlight, 0);
  });

  it('rejects a nonsensical limit', () => {
    assert.throws(() => new Semaphore(0), RangeError);
  });
});

describe('Deadline', () => {
  it('aborts once the wall clock runs out', async () => {
    const d = new Deadline(20, 'test run');
    assert.equal(d.expired, false);
    await new Promise(r => setTimeout(r, 40));
    assert.equal(d.expired, true);
    assert.match(String(d.signal.reason?.message ?? d.signal.reason), /deadline/i);
    d.dispose();
  });

  it('does not fire once disposed', async () => {
    const d = new Deadline(20);
    d.dispose();
    await new Promise(r => setTimeout(r, 40));
    assert.equal(d.expired, false);
  });
});
