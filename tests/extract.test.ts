import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CORPUS } from '../src/eval/corpus.js';
import { extractVote, splitSentences, normalize } from '../src/eval/extract.js';

const capital = CORPUS.find(q => q.id === 'cap-01')!;   // raise now | extend runway
const segment = CORPUS.find(q => q.id === 'gtm-04')!;   // smb | enterprise

describe('splitSentences', () => {
  it('splits ordinary prose', () => {
    assert.deepEqual(
      splitSentences(normalize('Raise now. The window is open. Do it.')),
      ['raise now.', 'the window is open.', 'do it.'],
    );
  });

  it('does not split on common abbreviations', () => {
    const out = splitSentences(normalize('Hire the vp sales, i.e. a real leader. Then scale.'));
    assert.equal(out.length, 2, `expected 2 sentences, got ${JSON.stringify(out)}`);
  });
});

describe('extractVote', () => {
  it('reads a clean recommendation from the first sentence', () => {
    const r = extractVote('Raise now. The market window is open and momentum compounds.', capital);
    assert.equal(r.status, 'matched');
    assert.equal(r.optionId, 'raise');
    assert.equal(r.window, 'first_sentence');
  });

  // The single most important test in the suite. The round-1 format REQUIRES a
  // closing counterargument, and that sentence names the rejected option. If
  // the extractor ever widens to the whole answer, nearly every question turns
  // ambiguous and the divergence rate becomes meaningless.
  it('ignores the mandated counterargument in the final sentence', () => {
    const answer = [
      'Raise now.',
      'Revenue is flat and a flat metric gets worse with age, not better.',
      'The strongest counterargument is that we could extend runway six months and raise on better numbers.',
    ].join(' ');

    const r = extractVote(answer, capital);
    assert.equal(r.status, 'matched');
    assert.equal(r.optionId, 'raise', 'counterargument must not flip or confuse the vote');
  });

  it('refuses when the first sentence names both options', () => {
    const r = extractVote('The real choice is between raise now and extend runway.', capital);
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.reason, 'multiple_options');
  });

  it('refuses on a negated option rather than inverting it', () => {
    const r = extractVote('We should not raise now.', capital);
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.reason, 'negated_only');
    assert.equal(r.optionId, undefined, 'a negated alias must never become a vote');
  });

  it('treats "X rather than Y" as a vote for X', () => {
    const r = extractVote('Raise now rather than extend runway.', capital);
    assert.equal(r.status, 'matched');
    assert.equal(r.optionId, 'raise');
  });

  it('widens to the second sentence when the first is throat-clearing', () => {
    const r = extractVote('This one is genuinely close. Extend runway and cut burn first.', capital);
    assert.equal(r.status, 'matched');
    assert.equal(r.optionId, 'extend');
    assert.equal(r.window, 'first_two_sentences');
  });

  it('respects token boundaries', () => {
    const r = extractVote('Our smbx segmentation is unclear.', segment);
    assert.equal(r.status, 'no_match', '"smbx" must not match the alias "smb"');
  });

  it('matches a real alias at a token boundary', () => {
    const r = extractVote('Target smb, then move up later.', segment);
    assert.equal(r.status, 'matched');
    assert.equal(r.optionId, 'smb');
  });

  it('returns no_match on an unrelated answer', () => {
    const r = extractVote('It depends entirely on what the board wants to optimise for.', capital);
    assert.equal(r.status, 'no_match');
  });

  it('handles empty and whitespace-only text', () => {
    assert.equal(extractVote('', capital).status, 'no_match');
    assert.equal(extractVote('   \n  ', capital).status, 'no_match');
  });

  it('is deterministic across repeated calls', () => {
    const answer = 'Extend runway. Cutting burn buys leverage for a better round.';
    const first = JSON.stringify(extractVote(answer, capital));
    for (let i = 0; i < 25; i++) {
      assert.equal(JSON.stringify(extractVote(answer, capital)), first);
    }
  });

  it('normalizes curly quotes and unicode dashes', () => {
    const r = extractVote('Don’t extend runway — raise now.', capital);
    // "extend runway" is negated by "don't"; "raise now" stands.
    assert.equal(r.status, 'matched');
    assert.equal(r.optionId, 'raise');
  });
});
