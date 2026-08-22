// Statistics for the premise check.
//
// The branch this replaces decided the premise with `delta >= 0.10` on a single
// 30-question run. On 30 questions a 10-point delta is three questions, which is
// well inside sampling noise, and one run supplies no variance estimate at all.
// A bare threshold cannot tell "multi-vendor genuinely diverges more" apart from
// "we ran it once and got three lucky questions".
//
// Two properties of the experiment determine the right test. The arms answer the
// SAME questions, so the observations are paired, and pairing is information a
// two-sample test throws away. Each observation is binary (the panel split, or
// it did not). Paired binary data is exactly McNemar's test, which looks only at
// the questions where the two arms disagreed, because the questions where both
// arms agreed carry no evidence either way.
//
// Everything here is a pure function over counts. No I/O, no network, no model.

/** A two-sided interval. */
export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Preferred over the textbook normal approximation because divergence rates can
 * legitimately land near 0 or 1, where the normal interval produces bounds
 * outside [0,1] and undercovers badly at small n. Wilson stays inside the unit
 * interval and behaves at the extremes.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { low: 0, high: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

/** Regularized incomplete gamma Q(s,x), via series and continued fraction. */
function gammaQ(s: number, x: number): number {
  if (x < 0 || s <= 0) return Number.NaN;
  if (x === 0) return 1;
  const lnGammaS = lnGamma(s);

  if (x < s + 1) {
    // Series expansion for P(s,x), then complement.
    let ap = s;
    let sum = 1 / s;
    let del = sum;
    for (let i = 0; i < 500; i++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + s * Math.log(x) - lnGammaS);
  }

  // Continued fraction for Q(s,x) directly (Lentz's method).
  const tiny = 1e-300;
  let b = x + 1 - s;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h * Math.exp(-x + s * Math.log(x) - lnGammaS);
}

/** Lanczos approximation to ln Γ(z). */
function lnGamma(z: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Upper-tail probability of a chi-square variate with 1 degree of freedom. */
export function chiSquareP(chi2: number, df = 1): number {
  if (!Number.isFinite(chi2) || chi2 <= 0) return 1;
  return gammaQ(df / 2, chi2 / 2);
}

/** Exact two-sided binomial p-value for b successes in (b+c) trials at p=0.5. */
export function exactBinomialP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  // Sum probabilities of outcomes at least as extreme as observed.
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(lnChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

function lnChoose(n: number, k: number): number {
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
}

export interface McNemarResult {
  /** Questions where the treatment arm diverged and the control did not. */
  treatmentOnly: number;
  /** Questions where the control arm diverged and the treatment did not. */
  controlOnly: number;
  /** Questions where both arms agreed; carry no evidence and are not tested. */
  concordant: number;
  /** treatmentOnly + controlOnly. The effective sample size of the test. */
  discordant: number;
  statistic: number;
  pValue: number;
  /** True when the exact binomial test was used instead of the chi-square. */
  exact: boolean;
}

/**
 * McNemar's test on paired binary outcomes.
 *
 * Only discordant pairs inform the test. With few of them the chi-square
 * approximation is unreliable, so below 25 the exact binomial is used instead.
 * Continuity correction is applied to the chi-square form.
 */
export function mcNemar(treatmentOnly: number, controlOnly: number, concordant = 0): McNemarResult {
  const discordant = treatmentOnly + controlOnly;
  if (discordant === 0) {
    return {
      treatmentOnly, controlOnly, concordant, discordant,
      statistic: 0, pValue: 1, exact: true,
    };
  }

  if (discordant < 25) {
    return {
      treatmentOnly, controlOnly, concordant, discordant,
      statistic: Math.min(treatmentOnly, controlOnly),
      pValue: exactBinomialP(treatmentOnly, controlOnly),
      exact: true,
    };
  }

  const diff = Math.abs(treatmentOnly - controlOnly) - 1; // continuity correction
  const statistic = (diff * diff) / discordant;
  return {
    treatmentOnly, controlOnly, concordant, discordant,
    statistic, pValue: chiSquareP(statistic), exact: false,
  };
}

/**
 * Confidence interval for the difference between two PAIRED proportions.
 *
 * The difference depends only on the discordant counts: delta = (b - c) / n,
 * where b and c are the two disagreeing cells. Its variance is
 * [(b + c) - (b - c)^2 / n] / n^2, which is the standard McNemar difference
 * interval and the interval that belongs next to a McNemar p-value.
 *
 * An earlier version of this function combined the two arms' Wilson bounds by
 * squaring and adding. That is Newcombe's method for INDEPENDENT proportions,
 * and using it here was wrong: it ignores the pairing, so on positively
 * correlated arms it is far too wide. It produced intervals that straddled zero
 * on data McNemar called significant, which is the visible symptom of throwing
 * away the pairing. Two methods reported side by side must not disagree about
 * whether an effect exists.
 */
export function pairedDeltaInterval(
  treatmentOnly: number,
  controlOnly: number,
  n: number,
  z = 1.96,
): Interval {
  if (n <= 0) return { low: 0, high: 0 };
  const b = treatmentOnly;
  const c = controlOnly;
  const delta = (b - c) / n;
  // Clamped because the bracket reaches exactly 0 when every pair is discordant
  // in one direction, and floating point can carry it just below.
  const variance = Math.max(0, (b + c) - ((b - c) ** 2) / n) / (n * n);
  const margin = z * Math.sqrt(variance);
  return {
    low: Math.max(-1, delta - margin),
    high: Math.min(1, delta + margin),
  };
}

/**
 * The verdict.
 *
 * Three outcomes, not two. Collapsing "we lack the evidence to tell" into
 * "refuted" would let a small or noisy run read as a disproof of the premise,
 * and collapsing it into "supported" would be worse. `inconclusive` is a real
 * answer and the tool says so.
 */
export type Verdict = 'supported' | 'refuted' | 'inconclusive';

export interface PremiseCheck {
  treatmentRate: number;
  controlRate: number;
  treatmentInterval: Interval;
  controlInterval: Interval;
  delta: number;
  deltaInterval: Interval;
  mcNemar: McNemarResult;
  verdict: Verdict;
  /** Plain-language statement of why the verdict came out that way. */
  rationale: string;
  /** The pre-registered practical significance floor, in rate points. */
  threshold: number;
  alpha: number;
}

export interface PremiseInput {
  /** Questions where treatment diverged. */
  treatmentDivergent: number;
  /** Questions where control diverged. */
  controlDivergent: number;
  /** Paired questions scored in BOTH arms. */
  pairedQuestions: number;
  /** Treatment diverged, control did not. */
  treatmentOnly: number;
  /** Control diverged, treatment did not. */
  controlOnly: number;
  /** Both arms agreed. */
  concordant: number;
  threshold?: number;
  alpha?: number;
}

/**
 * Decide the premise. Pre-registered before the funded run: the premise counts
 * as supported only when the effect is BOTH statistically distinguishable from
 * zero and practically meaningful. A significant but trivially small effect does
 * not vindicate seating six vendors, and a large point estimate on evidence too
 * thin to exclude zero does not either.
 */
export function checkPremise(input: PremiseInput): PremiseCheck {
  const threshold = input.threshold ?? 0.10;
  const alpha = input.alpha ?? 0.05;
  const n = input.pairedQuestions;

  const treatmentRate = n > 0 ? input.treatmentDivergent / n : 0;
  const controlRate = n > 0 ? input.controlDivergent / n : 0;
  const delta = treatmentRate - controlRate;

  const test = mcNemar(input.treatmentOnly, input.controlOnly, input.concordant);
  // Reads the discordant counts, not the arm totals: the paired difference is
  // determined by the questions where the arms disagreed.
  const deltaInterval = pairedDeltaInterval(input.treatmentOnly, input.controlOnly, n);

  const significant = test.pValue < alpha;
  const excludesZero = deltaInterval.low > 0;
  const meetsThreshold = delta >= threshold;

  let verdict: Verdict;
  let rationale: string;

  if (n === 0) {
    verdict = 'inconclusive';
    rationale = 'No questions were scored in both arms, so there is nothing to compare.';
  } else if (significant && excludesZero && meetsThreshold) {
    verdict = 'supported';
    rationale =
      `Multi-vendor diverged on ${fmtPct(treatmentRate)} of questions against ${fmtPct(controlRate)} ` +
      `for the single-vendor control (delta ${fmtPct(delta)}, 95% CI ${fmtPct(deltaInterval.low)} to ` +
      `${fmtPct(deltaInterval.high)}, McNemar p=${fmtP(test.pValue)}). The interval excludes zero and the ` +
      `effect clears the ${fmtPct(threshold)} practical floor.`;
  } else if (significant && deltaInterval.high < 0) {
    verdict = 'refuted';
    rationale =
      `The single-vendor control diverged MORE than the multi-vendor panel ` +
      `(delta ${fmtPct(delta)}, 95% CI ${fmtPct(deltaInterval.low)} to ${fmtPct(deltaInterval.high)}, ` +
      `McNemar p=${fmtP(test.pValue)}). The premise is contradicted, not merely unsupported.`;
  } else if (significant && excludesZero && !meetsThreshold) {
    verdict = 'inconclusive';
    rationale =
      `The effect is real but small: delta ${fmtPct(delta)} (95% CI ${fmtPct(deltaInterval.low)} to ` +
      `${fmtPct(deltaInterval.high)}, McNemar p=${fmtP(test.pValue)}) does not clear the ` +
      `${fmtPct(threshold)} practical floor. Six vendors diverge measurably more, but not by enough ` +
      `to justify the setup on this evidence.`;
  } else {
    verdict = 'inconclusive';
    rationale =
      `Delta is ${fmtPct(delta)} (95% CI ${fmtPct(deltaInterval.low)} to ${fmtPct(deltaInterval.high)}, ` +
      `McNemar p=${fmtP(test.pValue)}) across ${test.discordant} discordant of ${n} paired questions. ` +
      `The evidence does not distinguish the arms. This is a statement about the evidence, not a ` +
      `disproof of the premise.`;
  }

  return {
    treatmentRate, controlRate,
    treatmentInterval: wilsonInterval(input.treatmentDivergent, n),
    controlInterval: wilsonInterval(input.controlDivergent, n),
    delta, deltaInterval, mcNemar: test,
    verdict, rationale, threshold, alpha,
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtP(p: number): string {
  return p < 0.001 ? '<0.001' : p.toFixed(3);
}
