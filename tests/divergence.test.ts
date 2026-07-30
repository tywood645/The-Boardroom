import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CORPUS } from '../src/eval/corpus.js';
import { scoreQuestion, buildReport, compareToControl, type Vote } from '../src/eval/divergence.js';

const q = CORPUS.find(x => x.id === 'cap-01')!;   // raise | extend

function vote(panelist: string, role: string, optionId?: string, opts: Partial<Vote> = {}): Vote {
  if (opts.error) {
    return { panelist, role, extract: { status: 'no_match' }, error: opts.error };
  }
  if (!optionId) {
    return { panelist, role, extract: { status: 'ambiguous', reason: 'multiple_options' } };
  }
  return { panelist, role, extract: { status: 'matched', optionId } };
}

describe('scoreQuestion', () => {
  it('marks a unanimous panel as not divergent', () => {
    const s = scoreQuestion(q, [
      vote('a', 'CEO', 'raise'),
      vote('b', 'COO', 'raise'),
      vote('c', 'CFO', 'raise'),
    ]);
    assert.equal(s.parsedCount, 3);
    assert.equal(s.scored, true);
    assert.equal(s.divergent, false);
    assert.equal(s.minorityShare, 0);
  });

  it('marks a split panel as divergent with the right minority share', () => {
    const s = scoreQuestion(q, [
      vote('a', 'CEO', 'raise'),
      vote('b', 'COO', 'raise'),
      vote('c', 'CFO', 'raise'),
      vote('d', 'CTO', 'extend'),
    ]);
    assert.equal(s.divergent, true);
    assert.equal(s.topCount, 3);
    assert.deepEqual(s.topOptionIds, ['raise']);
    assert.equal(s.minorityShare, 0.25);
  });

  it('records both option ids when the panel ties', () => {
    const s = scoreQuestion(q, [
      vote('a', 'CEO', 'raise'),
      vote('b', 'COO', 'extend'),
    ]);
    assert.equal(s.divergent, true);
    assert.equal(s.topCount, 1);
    assert.equal(s.topOptionIds.length, 2, 'a tie has two top options');
    assert.equal(s.minorityShare, 0.5);
  });

  it('does not score a question with fewer than 2 parsed votes', () => {
    const s = scoreQuestion(q, [
      vote('a', 'CEO', 'raise'),
      vote('b', 'COO'),                      // ambiguous
      vote('c', 'CFO', undefined, { error: 'timeout' }),
    ]);
    assert.equal(s.parsedCount, 1);
    assert.equal(s.scored, false);
    assert.equal(s.divergent, false, 'an unscored question is never counted as divergent');
  });

  it('excludes provider errors from the tally', () => {
    const s = scoreQuestion(q, [
      vote('a', 'CEO', 'raise'),
      vote('b', 'COO', 'raise'),
      vote('c', 'CFO', undefined, { error: '429 rate limited' }),
    ]);
    assert.equal(s.parsedCount, 2);
    assert.equal(s.tally.raise, 2);
  });
});

describe('buildReport', () => {
  const scores = [
    scoreQuestion(q, [
      vote('anthropic', 'CEO', 'raise'),
      vote('openai', 'COO', 'raise'),
      vote('perplexity', 'Devil', 'extend'),
    ]),
    scoreQuestion(q, [
      vote('anthropic', 'CEO', 'extend'),
      vote('openai', 'COO', 'extend'),
      vote('perplexity', 'Devil', 'extend'),
    ]),
    scoreQuestion(q, [
      vote('anthropic', 'CEO', 'raise'),
      vote('openai', 'COO'),                                     // ambiguous
      vote('perplexity', 'Devil', undefined, { error: 'boom' }), // error
    ]),
  ];

  const report = buildReport('test panel', 3, scores);

  it('computes parse rate over every vote cast', () => {
    assert.equal(report.totalVotes, 9);
    assert.equal(report.parsedVotes, 7);
    assert.equal(report.ambiguousVotes, 1);
    assert.equal(report.errorVotes, 1);
    assert.ok(Math.abs(report.parseRate - 7 / 9) < 1e-9);
  });

  it('only counts questions with enough parsed votes', () => {
    assert.equal(report.questionCount, 3);
    assert.equal(report.scoredQuestions, 2, 'the third question had 1 parsed vote');
    assert.equal(report.divergentQuestions, 1);
    assert.equal(report.divergenceRate, 0.5);
  });

  it('attributes contrarian votes to the right vendor', () => {
    const devil = report.perVendor.find(v => v.panelist === 'perplexity')!;
    const ceo = report.perVendor.find(v => v.panelist === 'anthropic')!;
    assert.equal(devil.minority, 1, 'Devil was alone on question 1');
    assert.equal(ceo.minority, 0);
    assert.ok(devil.contrarianRate > ceo.contrarianRate);
  });

  it('counts unscored questions toward parse failures but not participation', () => {
    const openai = report.perVendor.find(v => v.panelist === 'openai')!;
    assert.equal(openai.parseFailures, 1);
    assert.equal(openai.participated, 2, 'the unscored question must not count as participation');
  });

  it('never reports a divergence rate above 1 or below 0', () => {
    assert.ok(report.divergenceRate >= 0 && report.divergenceRate <= 1);
    assert.ok(report.meanMinorityShare >= 0 && report.meanMinorityShare <= 1);
  });
});

describe('compareToControl (the falsification test)', () => {
  const strong = buildReport('multi', 6, [
    scoreQuestion(q, [vote('a', 'CEO', 'raise'), vote('b', 'COO', 'extend')]),
    scoreQuestion(q, [vote('a', 'CEO', 'raise'), vote('b', 'COO', 'extend')]),
  ]);
  const flat = buildReport('control', 6, [
    scoreQuestion(q, [vote('a', 'CEO', 'raise'), vote('b', 'COO', 'raise')]),
    scoreQuestion(q, [vote('a', 'CEO', 'raise'), vote('b', 'COO', 'raise')]),
  ]);

  it('supports the premise when multi-vendor diverges more', () => {
    const cmp = compareToControl(strong, flat);
    assert.equal(cmp.delta, 1);
    assert.equal(cmp.premiseSupported, true);
  });

  it('REFUTES the premise when the control diverges just as much', () => {
    const cmp = compareToControl(flat, flat);
    assert.equal(cmp.delta, 0);
    assert.equal(cmp.premiseSupported, false, 'equal divergence must not be read as support');
  });

  it('refutes the premise when the control diverges more', () => {
    const cmp = compareToControl(flat, strong);
    assert.ok(cmp.delta < 0);
    assert.equal(cmp.premiseSupported, false);
  });
});
