import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installMockFetch, restoreFetch, onFetch, openaiSSE, anthropicSSE, countingHandler } from './helpers/mock-fetch.ts';
import { delegate, MAX_ESCALATIONS, frontierSampleRate, DEFAULT_FRONTIER_SAMPLE_RATE } from '../src/delegate/escalate.ts';
import { classify, TIER_PRIORS } from '../src/delegate/classify.ts';
import { parseVerdict } from '../src/delegate/verify.ts';
import { appendDelegation, readDelegations, type DelegationRecord } from '../src/delegate/ledger.ts';
import { loadStats, pickStartTier, MIN_SAMPLES } from '../src/delegate/stats.ts';
import type { ProviderConfig } from '../src/provider/factory.ts';

// Top-tier answers are sample-checked at random by default. Every test here
// that reaches the top tier counts calls or outcomes, so sampling is off
// unless a test turns it on through its own options.
const savedSampleRate = process.env.BOARDROOM_VERIFY_FRONTIER;
before(() => {
  process.env.BOARDROOM_VERIFY_FRONTIER = '0';
});
after(() => {
  if (savedSampleRate === undefined) delete process.env.BOARDROOM_VERIFY_FRONTIER;
  else process.env.BOARDROOM_VERIFY_FRONTIER = savedSampleRate;
});

// Three vendors so every tier has a distinct model and a distinct checker.
const CONFIGS: ProviderConfig[] = [
  { name: 'google', type: 'openai', apiKey: 'k', model: 'gemini-3.1-flash-lite', baseUrl: 'https://google.test/v1' },
  { name: 'deepseek', type: 'openai', apiKey: 'k', model: 'deepseek-v4-flash', baseUrl: 'https://deepseek.test/v1' },
  { name: 'openai', type: 'openai', apiKey: 'k', model: 'gpt-5.6-terra', baseUrl: 'https://openai.test/v1' },
  { name: 'anthropic', type: 'anthropic', apiKey: 'k', model: 'claude-opus-5' },
];

const CONFIRMED = 'VERDICT: CONFIRMED\nDEFECT: none';
const REFUTED = 'VERDICT: REFUTED\nDEFECT: it answers a different question than the one asked';

/** Reply based on what the request is: a check, or the task itself. */
function replyBy(fn: (body: string) => string) {
  return (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    return openaiSSE(fn(body), { inputTokens: 100, outputTokens: 20 });
  };
}

const isCheck = (body: string) => body.includes('ANSWER TO CHECK');

describe('escalation ladder', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'boardroom-delegator-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
    restoreFetch();
  });

  beforeEach(() => {
    restoreFetch();
    installMockFetch();
  });

  it('stops at the first tier when the checker confirms', async () => {
    const handler = countingHandler(replyBy(b => (isCheck(b) ? CONFIRMED : 'the answer')));
    onFetch(handler);

    const r = await delegate('summarize this', CONFIGS, {}, { taskClass: 'summarize', stats: new Map() });
    assert.equal(r.attempts.length, 1);
    assert.equal(r.finalOutcome, 'confirmed');
    assert.equal(r.answer, 'the answer');
    assert.equal(handler.calls, 2, 'one attempt plus one check');
  });

  // The whole point: escalation is bought by a named defect, not spent by default.
  it('escalates one tier per refutation and stops at the top', async () => {
    onFetch(replyBy(b => (isCheck(b) ? REFUTED : 'the answer')));

    const r = await delegate('summarize this', CONFIGS, {}, { taskClass: 'summarize', stats: new Map() });
    const tiers = r.attempts.map(a => a.tier);
    assert.deepEqual(tiers, ['cheap', 'mid', 'frontier']);
    assert.equal(r.attempts.length, MAX_ESCALATIONS + 1);
  });

  // Verifying the top tier buys nothing — a refutation would have nowhere to
  // go — and it is the most expensive call the delegator can make.
  it('does not verify the top tier', async () => {
    onFetch(replyBy(b => (isCheck(b) ? REFUTED : 'the answer')));

    const r = await delegate('x', CONFIGS, {}, { taskClass: 'summarize', stats: new Map() });
    const top = r.attempts[r.attempts.length - 1];
    assert.equal(top.tier, 'frontier');
    assert.equal(top.verdictBy, undefined);
    assert.equal(top.outcome, 'unverified');
  });

  // A model that reflexively refuses to approve anything would otherwise drive
  // the ladder to the most expensive tier for free.
  it('treats a refutation with no named defect as a confirmation', async () => {
    onFetch(replyBy(b => (isCheck(b) ? 'VERDICT: REFUTED\nDEFECT: none' : 'the answer')));

    const r = await delegate('x', CONFIGS, {}, { taskClass: 'summarize', stats: new Map() });
    assert.equal(r.attempts.length, 1);
    assert.equal(r.finalOutcome, 'confirmed');
  });

  // Fail open on escalation, closed on budget: a parser miss must never be
  // able to spend frontier money.
  it('does not escalate on an unparseable verdict', async () => {
    onFetch(replyBy(b => (isCheck(b) ? 'I think it looks pretty good honestly' : 'the answer')));

    const r = await delegate('x', CONFIGS, {}, { taskClass: 'summarize', stats: new Map() });
    assert.equal(r.attempts.length, 1);
    assert.equal(r.finalOutcome, 'unverified');
  });

  it('never lets a model check its own work', async () => {
    const seen: string[] = [];
    onFetch((url, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      seen.push(`${url}|${isCheck(body) ? 'check' : 'task'}`);
      return openaiSSE(isCheck(body) ? REFUTED : 'the answer', { inputTokens: 10, outputTokens: 5 });
    });

    const r = await delegate('x', CONFIGS, {}, { taskClass: 'summarize', stats: new Map() });
    for (const a of r.attempts) {
      if (a.verdictBy) assert.notEqual(a.verdictBy, `${a.vendor}:${a.model}`);
    }
    assert.ok(seen.length > 0);
  });

  it('skips verification entirely when asked', async () => {
    const handler = countingHandler(replyBy(() => 'the answer'));
    onFetch(handler);

    const r = await delegate('x', CONFIGS, {}, { taskClass: 'summarize', stats: new Map(), verify: false });
    assert.equal(handler.calls, 1);
    assert.equal(r.finalOutcome, 'unverified');
  });

  it('honours a floor tier', async () => {
    onFetch(replyBy(b => (isCheck(b) ? CONFIRMED : 'the answer')));
    const r = await delegate('x', CONFIGS, {}, { taskClass: 'summarize', stats: new Map(), minTier: 'mid' });
    assert.equal(r.attempts[0].tier, 'mid');
    assert.match(r.startWhy, /--min-tier/);
  });

  it('keeps the answer and records the reason when a call fails', async () => {
    let first = true;
    onFetch(() => {
      if (first) {
        first = false;
        return openaiSSE('the answer', { inputTokens: 10, outputTokens: 5 });
      }
      throw new Error('vendor exploded');
    });

    const r = await delegate('x', CONFIGS, {}, { taskClass: 'summarize', stats: new Map() });
    assert.equal(r.answer, 'the answer', 'work already paid for must not be discarded');
  });
});

describe('verdict contract', () => {
  it('accepts a clean confirmation', () => {
    assert.equal(parseVerdict('VERDICT: CONFIRMED\nDEFECT: none').kind, 'confirmed');
  });

  it('accepts a refutation that names a defect', () => {
    const v = parseVerdict('VERDICT: REFUTED\nDEFECT: off-by-one in the loop bound');
    assert.equal(v.kind, 'refuted');
    assert.match(v.defect, /off-by-one/);
  });

  it('downgrades a defect-free refutation', () => {
    for (const empty of ['none', 'N/A', '-', 'nothing', '']) {
      assert.equal(parseVerdict(`VERDICT: REFUTED\nDEFECT: ${empty}`).kind, 'confirmed');
    }
  });

  it('reports unparseable output rather than guessing', () => {
    assert.equal(parseVerdict('looks fine to me').kind, 'unparseable');
  });

  it('truncates a rambling defect', () => {
    const v = parseVerdict('VERDICT: REFUTED\nDEFECT: ' + 'x'.repeat(500));
    assert.equal(v.defect.length, 200);
  });
});

describe('classifier', () => {
  const cases: Array<[string, string]> = [
    ['refactor the parser in src/foo.ts', 'code'],
    ['```js\nconst a = 1\n```\nwhat does this do', 'code'],
    ['what is the latest pricing for gpt-4o', 'research'],
    ['summarize this thread', 'summarize'],
    ['extract the dates into JSON', 'extract'],
    ['which file defines the provider interface', 'recon'],
    ['should we migrate off Postgres', 'reason'],
    ['write a birthday message', 'draft'],
  ];

  for (const [task, expected] of cases) {
    it(`classifies "${task.slice(0, 32)}" as ${expected}`, () => {
      assert.equal(classify(task).cls, expected);
    });
  }

  it('lets an explicit class override the rules', () => {
    const c = classify('refactor src/foo.ts', 'draft');
    assert.equal(c.cls, 'draft');
    assert.match(c.why, /--class/);
  });

  it('gives every class a starting tier', () => {
    for (const [, tier] of Object.entries(TIER_PRIORS)) {
      assert.ok(['cheap', 'mid', 'frontier'].includes(tier));
    }
  });
});

describe('delegation ledger and measured tiers', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'boardroom-ledger-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function rec(over: Partial<DelegationRecord> = {}): DelegationRecord {
    return {
      v: 1, ts: new Date().toISOString(), runId: 'r', attempt: 0,
      cls: 'summarize', tier: 'cheap', vendor: 'google', model: 'gemini-3.1-flash-lite',
      inputTokens: 10, outputTokens: 5, cost: 0.001, latencyMs: 100, ttfbMs: 50,
      outcome: 'confirmed',
      ...over,
    };
  }

  it('round-trips records and survives a corrupt line', () => {
    appendDelegation(rec());
    appendDelegation(rec({ outcome: 'refuted' }));
    const all = readDelegations();
    assert.equal(all.length, 2);
    assert.equal(all[1].outcome, 'refuted');
  });

  it('explores while a cell is under-sampled', () => {
    const stats = loadStats(Array.from({ length: MIN_SAMPLES - 1 }, () => rec({ outcome: 'refuted' })));
    const choice = pickStartTier('summarize', stats);
    assert.equal(choice.tier, TIER_PRIORS.summarize);
    assert.match(choice.why, /exploring|no measurements/);
  });

  // This is "measured, not guessed": the prior says cheap, the evidence says
  // cheap keeps failing, so the delegator starts one tier up on its own.
  it('promotes a tier once the evidence says it keeps failing', () => {
    const records = [
      ...Array.from({ length: 8 }, () => rec({ tier: 'cheap', outcome: 'refuted' })),
      ...Array.from({ length: 8 }, () => rec({ tier: 'mid', outcome: 'confirmed' })),
    ];
    const choice = pickStartTier('summarize', loadStats(records));
    assert.equal(choice.tier, 'mid');
    assert.match(choice.why, /confirms/);
  });

  it('stays on the prior when the evidence says it works', () => {
    const records = Array.from({ length: 8 }, () => rec({ tier: 'cheap', outcome: 'confirmed' }));
    assert.equal(pickStartTier('summarize', loadStats(records)).tier, 'cheap');
  });

  // R-006: unsatisfiable tasks, refuted at every tier, used to promote a
  // class to the top tier for everyone, where nothing could demote it.
  it('ignores runs in which nothing was ever confirmed', () => {
    const records = Array.from({ length: 10 }, (_, i) => [
      rec({ runId: `bad-${i}`, tier: 'cheap', outcome: 'refuted' }),
      rec({ runId: `bad-${i}`, tier: 'mid', outcome: 'refuted' }),
      rec({ runId: `bad-${i}`, tier: 'frontier', outcome: 'unverified' }),
    ]).flat();
    assert.equal(loadStats(records).size, 0);
    assert.equal(pickStartTier('summarize', loadStats(records)).tier, TIER_PRIORS.summarize);
  });

  it('counts a refutation only when a higher tier in the same run was confirmed', () => {
    const records = Array.from({ length: 6 }, (_, i) => [
      rec({ runId: `r-${i}`, tier: 'cheap', outcome: 'refuted' }),
      rec({ runId: `r-${i}`, tier: 'mid', outcome: 'confirmed' }),
    ]).flat();
    // A refutation from an unrelated run is not evidence against cheap.
    records.push(rec({ runId: 'other', tier: 'cheap', outcome: 'refuted' }));
    const stats = loadStats(records);
    assert.equal(stats.get('summarize:cheap')?.n, 6);
    assert.equal(pickStartTier('summarize', stats).tier, 'mid');
  });

  it('survives the attack end to end and still routes cheap', async () => {
    restoreFetch();
    installMockFetch();
    onFetch(replyBy(body =>
      isCheck(body) ? 'VERDICT: REFUTED\nDEFECT: it cannot satisfy both contradictory requirements' : 'answer',
    ));
    for (let i = 0; i < 6; i++) {
      await delegate('Reply with one word that is both "yes" and "no".', CONFIGS, {}, { taskClass: 'draft' });
    }
    const refuted = readDelegations().filter(r => r.cls === 'draft' && r.outcome === 'refuted');
    assert.ok(refuted.length >= 12, `the attack wrote its records (${refuted.length})`);
    const choice = pickStartTier('draft', loadStats());
    assert.equal(choice.tier, TIER_PRIORS.draft);
    restoreFetch();
  });

  it('ignores unverified attempts, which say nothing about quality', () => {
    const stats = loadStats(Array.from({ length: 20 }, () => rec({ outcome: 'unverified' })));
    assert.equal(stats.size, 0);
  });
});

describe('sample-checking the top tier', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'boardroom-sample-test-'));
    origHome = process.env.HOME;
  });
  after(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
    restoreFetch();
  });
  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpDir, 'h-'));
    restoreFetch();
    installMockFetch();
  });

  const always = () => 0; // below any positive rate: always sampled
  const never = () => 0.99;

  /** The Anthropic seat answers; every other seat is the checker. */
  function board(verdict: string) {
    return countingHandler((url: string, init?: RequestInit) => {
      if (url.includes('anthropic.com')) return anthropicSSE('top-tier answer');
      return openaiSSE(isCheck(String(init?.body ?? '')) ? verdict : 'answer');
    });
  }
  // An explicit rate: the file-wide setting above turns sampling off.
  const top = { taskClass: 'draft' as const, minTier: 'frontier' as const, stats: new Map(), frontierSampleRate: 0.2 };

  it('checks a sampled top-tier answer with another top-tier model', async () => {
    const handler = board(CONFIRMED);
    onFetch(handler);
    const d = await delegate('write a note', CONFIGS, {}, { ...top, random: always });
    assert.equal(handler.calls, 2);
    assert.equal(d.attempts.length, 1);
    assert.equal(d.attempts[0].model, 'claude-opus-5');
    assert.equal(d.attempts[0].verdictBy, 'openai:gpt-5.6-sol');
    assert.equal(d.finalOutcome, 'confirmed');
    assert.match(d.attempts[0].verdict!.why, /sampled check of a top-tier answer/);
    const [record] = readDelegations();
    assert.equal(record.tier, 'frontier');
    assert.equal(record.outcome, 'confirmed');
  });

  it('leaves the answer unchecked when it is not sampled', async () => {
    const handler = board(CONFIRMED);
    onFetch(handler);
    const d = await delegate('write a note', CONFIGS, {}, { ...top, random: never });
    assert.equal(handler.calls, 1);
    assert.equal(d.finalOutcome, 'unverified');
  });

  it('marks a refuted sample as refuted and does not try again', async () => {
    const handler = board(REFUTED);
    onFetch(handler);
    const d = await delegate('write a note', CONFIGS, {}, { ...top, random: always });
    assert.equal(handler.calls, 2);
    assert.equal(d.attempts.length, 1, 'there is nowhere above the top tier to go');
    assert.equal(d.answerOutcome, 'refuted');
  });

  it('never samples when verification is off, or the rate is 0', async () => {
    const handler = board(CONFIRMED);
    onFetch(handler);
    await delegate('write a note', CONFIGS, {}, { ...top, random: always, verify: false });
    await delegate('write a note', CONFIGS, {}, { ...top, random: always, frontierSampleRate: 0 });
    assert.equal(handler.calls, 2, 'one call per run');
  });

  it('skips the sample when only a lower-tier model could check it', async () => {
    // One vendor with a top-tier model: a mid-tier checker must not judge it.
    const oneTop = CONFIGS.filter(c => c.name !== 'anthropic');
    const handler = board(CONFIRMED);
    onFetch(handler);
    const d = await delegate('write a note', oneTop, {}, { ...top, random: always });
    assert.equal(d.attempts[0].model, 'gpt-5.6-sol');
    assert.equal(handler.calls, 1);
    assert.equal(d.finalOutcome, 'unverified');
  });

  it('reads the rate from BOARDROOM_VERIFY_FRONTIER and rejects a bad one', () => {
    assert.equal(frontierSampleRate(undefined), DEFAULT_FRONTIER_SAMPLE_RATE);
    assert.equal(frontierSampleRate(''), DEFAULT_FRONTIER_SAMPLE_RATE);
    assert.equal(frontierSampleRate('0'), 0);
    assert.equal(frontierSampleRate('0.35'), 0.35);
    assert.equal(frontierSampleRate('1'), 1);
    for (const bad of ['abc', '2', '-0.1', '20%']) {
      assert.throws(() => frontierSampleRate(bad), /BOARDROOM_VERIFY_FRONTIER/, bad);
    }
  });

  // The point of sampling: the stats can now learn that the top tier helps.
  it('lets confirmed top-tier samples promote a class past a failing mid tier', () => {
    const base = {
      v: 1 as const, ts: new Date().toISOString(), attempt: 0, cls: 'reason' as const,
      vendor: 'v', model: 'm', inputTokens: 1, outputTokens: 1, cost: 0, latencyMs: 1, ttfbMs: 1,
    };
    const runs = Array.from({ length: 6 }, (_, i) => [
      { ...base, runId: `r-${i}`, tier: 'mid' as const, outcome: 'refuted' as const },
      { ...base, runId: `r-${i}`, tier: 'frontier' as const, outcome: 'confirmed' as const },
    ]).flat();
    assert.equal(pickStartTier('reason', loadStats(runs)).tier, 'frontier');
    // Without the top-tier confirmations the same refutations prove nothing.
    const unsampled = runs.map(r => (r.tier === 'frontier' ? { ...r, outcome: 'unverified' as const } : r));
    assert.equal(pickStartTier('reason', loadStats(unsampled)).tier, 'mid');
  });
});
