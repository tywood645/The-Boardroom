import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, priceFor, DEFAULT_PRICING, TIERS } from '../src/cost/catalog.ts';

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
