import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMockFetch, restoreFetch, onFetch, anthropicSSE, openaiSSE, errorResponse } from './helpers/mock-fetch.ts';

// A runEval call with no ctx builds its own CostTracker and flushes it, which
// writes usage.json into the state directory. Without this redirect the eval
// tests write into the developer's real ~/.boardroom.
const evalTmpDir = mkdtempSync(join(tmpdir(), 'boardroom-eval-test-'));
process.env.BOARDROOM_HOME = evalTmpDir;

process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
process.env.OPENAI_API_KEY = 'test-key-openai';
process.env.XAI_API_KEY = 'test-key-xai';
process.env.GOOGLE_API_KEY = 'test-key-google';
process.env.DEEPSEEK_API_KEY = 'test-key-deepseek';
process.env.PERPLEXITY_API_KEY = 'test-key-perplexity';

import { runEval, buildControlSeats } from '../src/eval/run.js';
import { detectProviders } from '../src/provider/factory.js';
import { CORPUS, selectQuestions } from '../src/eval/corpus.js';
import { ROUND1_BASE } from '../src/boardroom/protocol.js';

/** Find which corpus question a mocked request is asking about. */
function questionFromBody(body: string) {
  return CORPUS.find(q => body.includes(q.prompt.slice(0, 60)));
}

/**
 * Scripted panel. Even-indexed questions get a unanimous board; odd-indexed
 * questions get Anthropic dissenting alone. Over the first 4 questions that is
 * exactly 2 divergent of 4.
 */
function scriptedAnswer(url: string, body: string): string {
  const q = questionFromBody(body);
  if (!q) return 'No opinion.';
  const index = CORPUS.indexOf(q);
  const isAnthropic = url.includes('anthropic.com');
  const dissent = index % 2 === 1 && isAnthropic;
  const option = dissent ? q.options[1] : q.options[0];
  return `${option.label}. Mock rationale for the ${q.id} decision. The counterargument is that ${q.options[1].label} also has merit.`;
}

describe('runEval end to end (mocked providers)', () => {
  before(() => {
    installMockFetch();
    onFetch((url, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const text = scriptedAnswer(url, body);
      return url.includes('anthropic.com') ? anthropicSSE(text) : openaiSSE(text);
    });
  });

  after(() => restoreFetch());

  it('scores a full multi-vendor run and reports divergence', async () => {
    const configs = detectProviders();
    const { report, costUsd } = await runEval(configs, { limit: 4 });

    assert.equal(report.questionCount, 4);
    assert.equal(report.panelSize, 6);
    assert.equal(report.totalVotes, 24);

    // Every scripted answer leads with a valid label, so nothing should drop.
    assert.equal(report.parsedVotes, 24, 'a compliant panel must parse at 100%');
    assert.equal(report.parseRate, 1);
    assert.equal(report.errorVotes, 0);

    assert.equal(report.scoredQuestions, 4);
    assert.equal(report.divergentQuestions, 2, 'questions 1 and 3 were scripted to split');
    assert.equal(report.divergenceRate, 0.5);
    assert.ok(costUsd >= 0);
  });

  it('attributes the scripted dissent to Anthropic', async () => {
    const configs = detectProviders();
    const { report } = await runEval(configs, { limit: 4 });

    const anthropic = report.perVendor.find(v => v.panelist === 'anthropic')!;
    assert.equal(anthropic.minority, 2, 'Anthropic dissented alone on 2 of 4');

    for (const v of report.perVendor.filter(v => v.panelist !== 'anthropic')) {
      assert.equal(v.minority, 0, `${v.panelist} should never be in the minority here`);
    }
  });

  it('the counterargument sentence never contaminates the vote', async () => {
    // Every scripted answer closes by naming options[1]. If the extractor
    // widened past the first sentence, the unanimous questions would turn
    // ambiguous and divergence would be unmeasurable.
    const configs = detectProviders();
    const { report } = await runEval(configs, { limit: 4 });
    assert.equal(report.ambiguousVotes, 0);
  });

  it('runs a single-vendor control over the same corpus', async () => {
    const configs = detectProviders();
    const { report } = await runEval(configs, { limit: 4, control: 'anthropic' });

    assert.equal(report.panelSize, 6, 'control still seats six roles');
    assert.ok(report.label.includes('single-vendor'));
    // One vendor answering every seat identically cannot split.
    assert.equal(report.divergentQuestions, 0);
    assert.equal(report.divergenceRate, 0);
  });

  it('rejects an unavailable control vendor', async () => {
    const configs = detectProviders();
    await assert.rejects(
      () => runEval(configs, { limit: 1, control: 'not-a-vendor' }),
      /not available/,
    );
  });

  it('honours category selection', async () => {
    const configs = detectProviders();
    const { report } = await runEval(configs, { category: 'gtm', limit: 3 });
    assert.equal(report.questionCount, 3);
    for (const s of report.perQuestion) {
      assert.equal(s.category, 'gtm');
    }
  });
});

describe('buildControlSeats', () => {
  it('seats all six roles on one provider', () => {
    const config = detectProviders().find(c => c.name === 'anthropic')!;
    const seats = buildControlSeats(config, ROUND1_BASE);

    assert.equal(seats.length, 6);
    assert.equal(new Set(seats.map(s => s.role)).size, 6, 'six distinct roles');
    for (const s of seats) {
      assert.equal(s.config.name, 'anthropic');
      assert.ok(s.system.startsWith(ROUND1_BASE), 'control seats keep the round-1 contract');
    }
  });
});

describe('provider failures during an eval', () => {
  before(() => {
    installMockFetch();
    onFetch((url, init) => {
      if (url.includes('anthropic.com')) return errorResponse(500, 'upstream boom');
      const body = typeof init?.body === 'string' ? init.body : '';
      return openaiSSE(scriptedAnswer(url, body));
    });
  });

  after(() => restoreFetch());

  it('drops the failed seat and still scores the rest', async () => {
    const configs = detectProviders();
    const { report } = await runEval(configs, { limit: 2 });

    assert.ok(report.errorVotes > 0, 'the failing vendor should register errors');
    assert.equal(report.scoredQuestions, 2, 'five healthy seats are still enough to score');

    const anthropic = report.perVendor.find(v => v.panelist === 'anthropic')!;
    assert.equal(anthropic.participated, 0, 'an erroring vendor never counts as participating');
    assert.ok(report.parseRate < 1);
  });
});

describe('selectQuestions', () => {
  it('returns the whole corpus by default', () => {
    assert.equal(selectQuestions().length, 30);
  });

  it('filters and limits', () => {
    assert.equal(selectQuestions('capital').length, 8);
    assert.equal(selectQuestions('capital', 3).length, 3);
    assert.equal(selectQuestions(undefined, 5).length, 5);
  });

  after(() => {
    delete process.env.BOARDROOM_HOME;
    rmSync(evalTmpDir, { recursive: true, force: true });
  });
});
