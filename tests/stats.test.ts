// Statistics tests.
//
// These check the implementations against values computed independently
// (published Wilson intervals, closed-form binomial sums, known chi-square
// critical points) rather than against themselves. A statistics module that only
// agrees with its own output is not verified, and this one decides whether a
// public claim gets published.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  wilsonInterval, chiSquareP, exactBinomialP, mcNemar,
  pairedDeltaInterval, checkPremise,
} from '../src/eval/stats.js';

const close = (a: number, b: number, tol = 1e-3, msg?: string) =>
  assert.ok(Math.abs(a - b) < tol, msg ?? `expected ${a} within ${tol} of ${b}`);

describe('wilsonInterval', () => {
  it('matches the published interval for 10/20', () => {
    // Standard reference value for a 95% Wilson interval at p=0.5, n=20.
    const ci = wilsonInterval(10, 20);
    close(ci.low, 0.2993);
    close(ci.high, 0.7007);
  });

  it('matches the published interval for 0/10 and stays in the unit interval', () => {
    const ci = wilsonInterval(0, 10);
    close(ci.low, 0);
    close(ci.high, 0.2775);
    assert.ok(ci.low >= 0 && ci.high <= 1);
  });

  it('does not exceed 1 at full success, where the normal approximation would', () => {
    const ci = wilsonInterval(10, 10);
    assert.ok(ci.high <= 1, 'upper bound must stay within [0,1]');
    close(ci.low, 0.7225);
    close(ci.high, 1);
  });

  it('narrows as n grows at a fixed rate', () => {
    const small = wilsonInterval(15, 30);
    const large = wilsonInterval(150, 300);
    assert.ok(large.high - large.low < small.high - small.low);
  });

  it('returns a degenerate interval for n=0', () => {
    assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 0 });
  });
});

describe('chiSquareP', () => {
  it('reproduces known critical points at df=1', () => {
    close(chiSquareP(3.8415), 0.05, 1e-3);
    close(chiSquareP(6.635), 0.01, 1e-3);
    close(chiSquareP(2.706), 0.10, 1e-3);
  });

  it('is 1 at zero and decreasing', () => {
    assert.equal(chiSquareP(0), 1);
    assert.ok(chiSquareP(1) > chiSquareP(5));
  });
});

describe('exactBinomialP', () => {
  it('matches a hand-computed two-sided sum', () => {
    // b=2, c=10, n=12. Two-sided p = 2 * sum_{i<=2} C(12,i) / 2^12
    //                              = 2 * (1 + 12 + 66) / 4096 = 158/4096.
    close(exactBinomialP(2, 10), 158 / 4096, 1e-9);
  });

  it('is 1 for a perfectly even split', () => {
    close(exactBinomialP(5, 5), 1, 1e-9);
  });

  it('is 1 when there are no discordant pairs', () => {
    assert.equal(exactBinomialP(0, 0), 1);
  });

  it('never exceeds 1 for extreme splits', () => {
    assert.ok(exactBinomialP(0, 8) <= 1);
    close(exactBinomialP(0, 8), 2 / 256, 1e-9);
  });
});

describe('mcNemar', () => {
  it('uses the exact test when discordant pairs are few', () => {
    const r = mcNemar(10, 2, 18);
    assert.equal(r.exact, true, 'fewer than 25 discordant pairs must use the exact test');
    assert.equal(r.discordant, 12);
    close(r.pValue, 158 / 4096, 1e-9);
  });

  it('uses the corrected chi-square when discordant pairs are many', () => {
    const r = mcNemar(25, 10, 40);
    assert.equal(r.exact, false);
    // (|25-10| - 1)^2 / 35 = 196/35 = 5.6
    close(r.statistic, 5.6, 1e-9);
    assert.ok(r.pValue < 0.05);
  });

  it('reports p=1 when no pairs are discordant', () => {
    const r = mcNemar(0, 0, 30);
    assert.equal(r.pValue, 1);
    assert.equal(r.discordant, 0);
  });

  it('is symmetric in its two discordant counts', () => {
    assert.equal(mcNemar(3, 11).pValue, mcNemar(11, 3).pValue);
  });

  it('ignores concordant pairs when computing the statistic', () => {
    assert.equal(mcNemar(8, 3, 0).pValue, mcNemar(8, 3, 500).pValue);
  });
});

describe('pairedDeltaInterval', () => {
  // Takes DISCORDANT counts (b, c), not arm totals: the paired difference is
  // (b - c) / n and depends only on the questions where the arms disagreed.
  it('brackets the observed delta', () => {
    const ci = pairedDeltaInterval(20, 2, 30);
    const delta = (20 - 2) / 30;
    assert.ok(ci.low < delta && ci.high > delta);
  });

  it('includes zero when the discordant pairs are balanced', () => {
    const ci = pairedDeltaInterval(6, 6, 30);
    assert.ok(ci.low < 0 && ci.high > 0);
  });

  it('is zero-width when no pairs are discordant', () => {
    const ci = pairedDeltaInterval(0, 0, 30);
    close(ci.low, 0, 1e-12);
    close(ci.high, 0, 1e-12);
  });

  it('agrees with McNemar about whether zero is excluded', () => {
    // The two must not contradict each other. Using an independent-samples
    // interval here (the original bug) breaks exactly this property, because it
    // discards the pairing and reports a much wider interval.
    const cases: Array<[number, number, number]> = [
      [45, 25, 300], [20, 2, 30], [6, 6, 30], [2, 10, 40], [30, 12, 100],
    ];
    for (const [b, c, n] of cases) {
      const ci = pairedDeltaInterval(b, c, n);
      const p = mcNemar(b, c, n - b - c).pValue;
      const ciExcludesZero = ci.low > 0 || ci.high < 0;
      assert.equal(
        ciExcludesZero, p < 0.05,
        `b=${b} c=${c} n=${n}: CI [${ci.low.toFixed(4)}, ${ci.high.toFixed(4)}] and p=${p.toFixed(4)} disagree`,
      );
    }
  });
});

describe('checkPremise', () => {
  it('supports the premise only on a large, significant effect', () => {
    // 26/30 vs 8/30, with a lopsided discordant split.
    const r = checkPremise({
      treatmentDivergent: 26, controlDivergent: 8, pairedQuestions: 30,
      treatmentOnly: 20, controlOnly: 2, concordant: 8,
    });
    assert.equal(r.verdict, 'supported');
    assert.ok(r.deltaInterval.low > 0, 'a supported verdict requires the CI to exclude zero');
    assert.ok(r.mcNemar.pValue < 0.05);
    assert.match(r.rationale, /clears the/);
  });

  it('calls a thin single run inconclusive rather than supported', () => {
    // Exactly the case the old `delta >= 0.10` rule would have called supported:
    // a 13-point gap that the evidence cannot separate from zero.
    const r = checkPremise({
      treatmentDivergent: 17, controlDivergent: 13, pairedQuestions: 30,
      treatmentOnly: 6, controlOnly: 2, concordant: 22,
    });
    assert.ok(r.delta >= 0.10, 'this run clears the old bare threshold');
    assert.equal(r.verdict, 'inconclusive', 'but the evidence does not distinguish the arms');
    assert.match(r.rationale, /statement about the evidence/);
  });

  it('separates a real but trivially small effect from a supporting one', () => {
    const r = checkPremise({
      treatmentDivergent: 160, controlDivergent: 140, pairedQuestions: 300,
      treatmentOnly: 45, controlOnly: 25, concordant: 230,
    });
    assert.ok(r.mcNemar.pValue < 0.05, 'the effect is statistically detectable');
    assert.ok(r.delta < 0.10, 'but below the practical floor');
    assert.equal(r.verdict, 'inconclusive');
    assert.match(r.rationale, /does not clear/);
  });

  it('refutes the premise when the control diverges more', () => {
    const r = checkPremise({
      treatmentDivergent: 6, controlDivergent: 24, pairedQuestions: 30,
      treatmentOnly: 2, controlOnly: 20, concordant: 8,
    });
    assert.equal(r.verdict, 'refuted');
    assert.ok(r.deltaInterval.high < 0);
    assert.match(r.rationale, /contradicted/);
  });

  it('is inconclusive when nothing scored', () => {
    const r = checkPremise({
      treatmentDivergent: 0, controlDivergent: 0, pairedQuestions: 0,
      treatmentOnly: 0, controlOnly: 0, concordant: 0,
    });
    assert.equal(r.verdict, 'inconclusive');
    assert.match(r.rationale, /nothing to compare/);
  });

  it('honours a caller-supplied threshold', () => {
    const input = {
      treatmentDivergent: 26, controlDivergent: 8, pairedQuestions: 30,
      treatmentOnly: 20, controlOnly: 2, concordant: 8,
    };
    assert.equal(checkPremise({ ...input, threshold: 0.90 }).verdict, 'inconclusive');
    assert.equal(checkPremise({ ...input, threshold: 0.10 }).verdict, 'supported');
  });
});
