import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CORPUS, CATEGORIES, forcedChoiceSuffix } from '../src/eval/corpus.js';
import { normalize, extractVote } from '../src/eval/extract.js';

describe('eval corpus integrity', () => {
  it('has 30 questions with unique ids', () => {
    assert.equal(CORPUS.length, 30);
    const ids = new Set(CORPUS.map(q => q.id));
    assert.equal(ids.size, 30, 'question ids must be unique');
  });

  it('covers every declared category', () => {
    for (const c of CATEGORIES) {
      assert.ok(CORPUS.some(q => q.category === c), `no questions in category ${c}`);
    }
  });

  it('every question is a forced binary with distinct option ids', () => {
    for (const q of CORPUS) {
      assert.equal(q.options.length, 2, `${q.id} must have exactly 2 options`);
      assert.notEqual(q.options[0].id, q.options[1].id, `${q.id} option ids must differ`);
      for (const o of q.options) {
        assert.ok(o.aliases.length > 0, `${q.id}/${o.id} needs at least one alias`);
      }
    }
  });

  it('aliases are already normalized (lowercase, single-spaced)', () => {
    for (const q of CORPUS) {
      for (const o of q.options) {
        for (const alias of o.aliases) {
          assert.equal(alias, normalize(alias), `${q.id}/${o.id}: alias "${alias}" is not normalized`);
        }
      }
    }
  });

  // Corpus rule 1. A cross-option substring makes one option's alias fire on
  // the other option's phrasing, which silently corrupts every number the
  // eval produces. This is the test that keeps the measurement honest.
  it('no alias of one option is a substring of an alias of the other', () => {
    for (const q of CORPUS) {
      const [a, b] = q.options;
      for (const x of a.aliases) {
        for (const y of b.aliases) {
          assert.ok(
            !x.includes(y) && !y.includes(x),
            `${q.id}: aliases "${x}" (${a.id}) and "${y}" (${b.id}) overlap`,
          );
        }
      }
    }
  });

  // The instruction tells advisors to answer using an option's label wording.
  // If a label is not itself extractable, a perfectly compliant advisor goes
  // unscored and the parse rate silently degrades. This caught pro-06, whose
  // labels had drifted out of their own alias lists.
  it('every option label is extractable as a vote for that option', () => {
    for (const q of CORPUS) {
      for (const o of q.options) {
        const r = extractVote(o.label, q);
        assert.equal(r.status, 'matched', `${q.id}: label "${o.label}" does not extract`);
        assert.equal(r.optionId, o.id, `${q.id}: label "${o.label}" extracted as ${r.optionId}`);
      }
    }
  });

  it('forced-choice suffix names both option labels', () => {
    for (const q of CORPUS) {
      const suffix = forcedChoiceSuffix(q);
      assert.ok(suffix.includes(q.options[0].label), `${q.id} suffix missing option A label`);
      assert.ok(suffix.includes(q.options[1].label), `${q.id} suffix missing option B label`);
    }
  });
});
