import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG,
  priceFor,
  DEFAULT_PRICING,
  TIERS,
  canonicalModel,
} from '../src/cost/catalog.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/**
 * These turn "enforcement, not prose" into a property the build checks.
 *
 * The budget gate lives inside collectStream. That only means anything if
 * collectStream is the sole route to a provider — a new call site that drains
 * a stream directly would silently skip the gate.
 */
describe('enforcement invariants', () => {
  it('only collect.ts consumes a provider stream', () => {
    const providerDir = join(repoRoot, 'src', 'provider');
    const callers = walkTs(join(repoRoot, 'src'))
      .filter(f => readFileSync(f, 'utf-8').includes('.createMessage('))
      // The provider clients define createMessage; they are not callers.
      .filter(f => !f.startsWith(providerDir) || f.endsWith('collect.ts'))
      .map(f => relative(repoRoot, f).replace(/\\/g, '/'))
      .sort();

    assert.deepEqual(
      callers,
      ['src/provider/collect.ts'],
      'every provider call must go through collectStream so the budget gate cannot be bypassed',
    );
  });

  it('prices every catalog model from the table, never the fallback', () => {
    for (const [model, spec] of Object.entries(CATALOG)) {
      const p = priceFor(model);
      assert.equal(p.input, spec.input, `${model} input price`);
      assert.equal(p.output, spec.output, `${model} output price`);
    }
  });

  it('warns rather than silently mispricing an unknown model', () => {
    const p = priceFor('some-model-that-does-not-exist');
    assert.deepEqual(p, DEFAULT_PRICING);
  });

  // Anthropic accepts a dated ID and an undated alias for the same model. A
  // config naming the alias must not fall through to DEFAULT_PRICING — for
  // Haiku that is a 3x overcharge on every call it records.
  it('prices an undated alias exactly like its dated entry', () => {
    for (const alias of ['claude-haiku-4-5']) {
      const dated = canonicalModel(alias);
      const spec = CATALOG[dated];
      assert.ok(spec, `alias "${alias}" points at "${dated}", which is not in the catalog`);
      assert.deepEqual(priceFor(alias), { input: spec.input, output: spec.output }, alias);
    }

    // Haiku is the case that motivated this, and the only one of the three that
    // can witness a fallthrough: its real rate differs from DEFAULT_PRICING, so
    // resolving the alias is the difference between $1/$5 and a silent 3x
    // overcharge. Both Sonnet rates coincide with the fallback exactly.
    assert.notDeepEqual(priceFor('claude-haiku-4-5'), DEFAULT_PRICING);
  });

  // Retired models fail outright rather than costing the wrong amount, so a
  // retired row is worse than a mispriced one: resolveTier picks from this
  // table, and would hand back a model no request can reach.
  //
  // This is the catalog's most common failure by far. Every ID below was in
  // the table while already dead, across four vendors -- and because
  // resolveTier ranks by price, a cheap dead model wins its tier outright.
  // Sonnet 4 and Opus 4 were six weeks past retirement, gemini-2.0-flash two
  // months, grok-3 ten weeks; deepseek-chat had been dead four days.
  it('lists no model that has been retired from the API', () => {
    const retired = [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'deepseek-chat',
      'grok-3',
      'grok-3-mini',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-haiku-20241022',
      'claude-3-haiku-20240307',
      'claude-3-opus-20240229',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
    ];
    for (const model of retired) {
      assert.ok(!CATALOG[model], `"${model}" is retired; requests to it fail`);
      assert.equal(canonicalModel(model), model, `an alias still resolves to retired "${model}"`);
    }
  });

  it('has at least one model in every tier', () => {
    for (const tier of TIERS) {
      const inTier = Object.values(CATALOG).filter(s => s.tier === tier);
      assert.ok(inTier.length > 0, `tier "${tier}" is empty`);
    }
  });

  it('spreads the cheap tier across more than one vendor', () => {
    const vendors = new Set(
      Object.values(CATALOG).filter(s => s.tier === 'cheap').map(s => s.vendor),
    );
    assert.ok(
      vendors.size > 1,
      'cross-vendor tiering is the point; a single-vendor cheap tier is just an alias',
    );
  });
});
