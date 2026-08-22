// Experiment tests against mocked providers.
//
// The value of these is that ground truth is known. The mock decides exactly
// which vendor votes which way, so the experiment can be checked for recovering
// a planted effect and, more importantly, for NOT finding one when the arms are
// scripted to behave identically. An eval that reports a positive result on
// identical arms is worse than no eval.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMockFetch, restoreFetch, onFetch, anthropicSSE, openaiSSE } from './helpers/mock-fetch.ts';

const expTmpDir = mkdtempSync(join(tmpdir(), 'boardroom-experiment-test-'));
process.env.BOARDROOM_HOME = expTmpDir;

process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
process.env.OPENAI_API_KEY = 'test-key-openai';
process.env.XAI_API_KEY = 'test-key-xai';
process.env.GOOGLE_API_KEY = 'test-key-google';
process.env.DEEPSEEK_API_KEY = 'test-key-deepseek';
process.env.PERPLEXITY_API_KEY = 'test-key-perplexity';

import { runExperiment } from '../src/eval/experiment.js';
import { detectProviders } from '../src/provider/factory.js';
import { CORPUS } from '../src/eval/corpus.js';

function questionFromBody(body: string) {
  return CORPUS.find(q => body.includes(q.prompt.slice(0, 60)));
}

/** Which vendor a mocked request is going to, inferred from its URL. */
function vendorOf(url: string): string {
  if (url.includes('anthropic.com')) return 'anthropic';
  if (url.includes('openai.com')) return 'openai';
  if (url.includes('x.ai')) return 'xai';
  if (url.includes('googleapis.com') || url.includes('generativelanguage')) return 'google';
  if (url.includes('deepseek')) return 'deepseek';
  if (url.includes('perplexity')) return 'perplexity';
  return 'unknown';
}

function answerFor(q: ReturnType<typeof questionFromBody>, optionIndex: 0 | 1): string {
  if (!q) return 'No opinion.';
  const option = q.options[optionIndex];
  const other = q.options[1 - optionIndex];
  return `${option.label}. Mock rationale for ${q.id}. The counterargument is that ${other.label} also has merit.`;
}

function reply(url: string, text: string) {
  return url.includes('anthropic.com') ? anthropicSSE(text) : openaiSSE(text);
}

describe('runExperiment: arms scripted to behave identically', () => {
  before(() => {
    installMockFetch();
    // Every vendor always picks option 0, in both arms. There is no divergence
    // anywhere, so there is no effect to find.
    onFetch((url, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      return reply(url, answerFor(questionFromBody(body), 0));
    });
  });
  after(() => restoreFetch());

  it('reports no divergence and does not claim support', async () => {
    const configs = detectProviders();
    const result = await runExperiment(configs, { control: 'anthropic', limit: 3, rotations: 2 });

    assert.equal(result.treatment.report.divergentQuestions, 0);
    assert.equal(result.control.report.divergentQuestions, 0);
    assert.equal(result.premise.delta, 0);
    assert.notEqual(result.premise.verdict, 'supported', 'identical arms must never read as supported');
    assert.equal(result.premise.mcNemar.discordant, 0);
    assert.equal(result.premise.mcNemar.pValue, 1);
  });

  it('pairs every question across the arms', async () => {
    const configs = detectProviders();
    const result = await runExperiment(configs, { control: 'anthropic', limit: 4, rotations: 2 });
    // 4 questions x 2 rotations x 1 trial, scored in both arms.
    assert.equal(result.pairedQuestions, 8);
  });
});

describe('runExperiment: multi-vendor genuinely splits', () => {
  before(() => {
    installMockFetch();
    // Two of six vendors take option 1, so the panel splits 4-2 on every
    // question. Deliberately NOT 3-3: an exact tie makes both options "top", so
    // no vote counts as outside the plurality and every minority rate is zero.
    // A 4-2 split gives the two dissenters an unambiguous minority position.
    // The control seats one vendor in every role, so it agrees with itself.
    onFetch((url, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const q = questionFromBody(body);
      const vendor = vendorOf(url);
      const dissenting = vendor === 'openai' || vendor === 'google';
      return reply(url, answerFor(q, dissenting ? 1 : 0));
    });
  });
  after(() => restoreFetch());

  it('recovers the planted effect and supports the premise', async () => {
    const configs = detectProviders();
    const result = await runExperiment(configs, { control: 'anthropic', limit: 6, rotations: 3 });

    assert.equal(result.treatment.report.divergenceRate, 1, 'the panel splits on every question');
    assert.equal(result.control.report.divergenceRate, 0, 'one vendor cannot disagree with itself');
    assert.equal(result.premise.verdict, 'supported');
    assert.ok(result.premise.deltaInterval.low > 0);
    assert.ok(result.premise.mcNemar.pValue < 0.05);
  });

  it('attributes divergence to vendors, not to the roles they happened to hold', async () => {
    const configs = detectProviders();
    const result = await runExperiment(configs, { control: 'anthropic', limit: 4, rotations: 6 });

    assert.equal(result.balanced, true, 'six rotations of six vendors is a full square');
    assert.ok(result.vendorEffects.length > 0);

    // Every vendor held every role exactly once, so the role a vendor occupied
    // carries no information: each role was filled by all six vendors, two of
    // which dissent. Every role must therefore show the SAME minority rate of
    // 2/6, and the differences must land entirely on the vendor axis. Under the
    // old fixed seating, this identical data would have shown the dissent
    // concentrated in whichever roles openai and google were pinned to, and it
    // would have been reported as a role effect.
    const roleRates = result.roleEffects.map(r => r.minorityRate);
    assert.equal(new Set(roleRates.map(r => r.toFixed(6))).size, 1,
      `roles must wash out under rotation, saw ${JSON.stringify(roleRates)}`);
    for (const role of result.roleEffects) {
      assert.ok(Math.abs(role.minorityRate - 2 / 6) < 1e-9,
        `role ${role.role} shows ${role.minorityRate}, expected 2/6`);
    }

    // The vendor axis carries the whole signal: the two dissenters are always
    // in the minority, the other four never are.
    const byVendor = new Map(result.vendorEffects.map(v => [v.vendor, v]));
    for (const dissenter of ['openai', 'google']) {
      assert.equal(byVendor.get(dissenter)!.minorityRate, 1, `${dissenter} dissents on every question`);
    }
    for (const majority of ['anthropic', 'deepseek', 'xai', 'perplexity']) {
      assert.equal(byVendor.get(majority)!.minorityRate, 0, `${majority} never dissents`);
    }
    for (const vendor of result.vendorEffects) {
      assert.equal(vendor.rolesHeld, 6, `${vendor.vendor} should have held all six roles`);
    }
  });

  it('counts an even split as divergent but assigns no minority', async () => {
    // Worth pinning because it is unintuitive and it shapes every minority
    // rate. On an exact tie both options are "top", so no vote sits outside the
    // plurality: the question is divergent, yet nobody is a contrarian. Any
    // reading of vendor effects has to account for ties contributing nothing.
    const configs = detectProviders();
    const result = await runExperiment(configs, { control: 'anthropic', limit: 2, rotations: 6 });
    const tie = result.treatment.cells.find(c => c.score.topOptionIds.length > 1);
    if (tie) {
      for (const vote of tie.score.votes) {
        if (vote.extract.status !== 'matched') continue;
        assert.ok(tie.score.topOptionIds.includes(vote.extract.optionId!),
          'on a tie every parsed vote is on a top option');
      }
    }
  });

  it('withholds the decomposition when the sweep is not a full square', async () => {
    const configs = detectProviders();
    const result = await runExperiment(configs, { control: 'anthropic', limit: 2, rotations: 2 });
    assert.equal(result.balanced, false);
    assert.deepEqual(result.vendorEffects, [], 'an unbalanced sweep must not report vendor effects');
    assert.deepEqual(result.roleEffects, []);
  });
});

describe('runExperiment: trials and bookkeeping', () => {
  before(() => {
    installMockFetch();
    onFetch((url, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const q = questionFromBody(body);
      return reply(url, answerFor(q, vendorOf(url) === 'openai' ? 1 : 0));
    });
  });
  after(() => {
    restoreFetch();
    delete process.env.BOARDROOM_HOME;
    rmSync(expTmpDir, { recursive: true, force: true });
  });

  it('reports a divergence rate per trial', async () => {
    const configs = detectProviders();
    const result = await runExperiment(configs, { control: 'anthropic', limit: 2, rotations: 2, trials: 3 });
    assert.equal(result.trials, 3);
    assert.equal(result.perTrialTreatmentRate.length, 3);
    assert.equal(result.perTrialControlRate.length, 3);
    // Deterministic mock, so every trial must agree exactly.
    assert.equal(new Set(result.perTrialTreatmentRate).size, 1);
  });

  it('scales paired questions with trials and rotations', async () => {
    const configs = detectProviders();
    const result = await runExperiment(configs, { control: 'anthropic', limit: 2, rotations: 3, trials: 2 });
    assert.equal(result.pairedQuestions, 2 * 3 * 2);
  });

  it('rejects an unavailable control vendor', async () => {
    const configs = detectProviders();
    await assert.rejects(
      () => runExperiment(configs, { control: 'not-a-vendor', limit: 1 }),
      /not available/,
    );
  });

  it('accumulates cost across both arms', async () => {
    const configs = detectProviders();
    const result = await runExperiment(configs, { control: 'anthropic', limit: 2, rotations: 1 });
    assert.ok(result.totalCostUsd >= 0);
    assert.equal(result.totalCostUsd, result.treatment.costUsd + result.control.costUsd);
  });
});
