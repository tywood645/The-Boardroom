import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installMockFetch, restoreFetch, onFetch } from './helpers/mock-fetch.ts';
import { verifyCatalog } from '../src/delegate/verify-catalog.ts';
import type { ProviderConfig } from '../src/provider/factory.ts';

const GOOGLE: ProviderConfig = {
  name: 'google',
  type: 'openai',
  apiKey: 'k',
  model: 'gemini-3.6-flash',
  baseUrl: 'https://generativelanguage.test/v1beta/openai',
};

const ANTHROPIC: ProviderConfig = {
  name: 'anthropic',
  type: 'anthropic',
  apiKey: 'k',
  model: 'claude-sonnet-5',
};

function models(ids: string[], extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ object: 'list', data: ids.map(id => ({ id })), ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function reportFor(reports: Awaited<ReturnType<typeof verifyCatalog>>['reports'], vendor: string) {
  const r = reports.find(x => x.vendor === vendor);
  assert.ok(r, `no report for ${vendor}`);
  return r;
}

describe('verify-catalog', () => {
  beforeEach(() => {
    restoreFetch();
    installMockFetch();
  });
  after(() => restoreFetch());

  it('passes when the vendor still serves every catalog model', async () => {
    onFetch(() => models(['gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-4.0-something']));

    const result = await verifyCatalog([GOOGLE]);
    const google = reportFor(result.reports, 'google');
    assert.equal(google.status, 'ok');
    assert.deepEqual(google.missing, []);
    assert.equal(google.confirmed.length, 2);
    assert.equal(result.ok, true);
  });

  // The failure this command exists for. Every dead entry found by hand in this
  // repo — gemini-2.0-flash, deepseek-chat, grok-3, claude-sonnet-4 — looked
  // exactly like this: absent from the vendor's own list, present in ours.
  it('fails when the vendor no longer lists a catalog model', async () => {
    onFetch(() => models(['gemini-3.6-flash']));

    const result = await verifyCatalog([GOOGLE]);
    const google = reportFor(result.reports, 'google');
    assert.equal(google.status, 'stale');
    assert.deepEqual(google.missing, ['gemini-3.1-flash-lite']);
    assert.equal(result.ok, false, 'a stale catalog must drive a non-zero exit');
  });

  // Google's own API returns `models/<id>` while its OpenAI-compatible layer
  // takes the bare ID. Comparing raw strings would report every Google model
  // as gone.
  it('matches Google ids whether or not they carry the models/ prefix', async () => {
    onFetch(() => models(['models/gemini-3.6-flash', 'models/gemini-3.1-flash-lite']));

    const result = await verifyCatalog([GOOGLE]);
    assert.equal(reportFor(result.reports, 'google').status, 'ok');
  });

  // Anthropic accepts a dated ID and an undated alias for the same model; the
  // catalog keys the dated one.
  it('matches an Anthropic model listed under its undated alias', async () => {
    onFetch(() =>
      models(['claude-opus-5', 'claude-fable-5', 'claude-sonnet-5', 'claude-haiku-4-5']),
    );

    const result = await verifyCatalog([ANTHROPIC]);
    const anthropic = reportFor(result.reports, 'anthropic');
    assert.deepEqual(anthropic.missing, [], 'the alias names the same model as the dated id');
    assert.equal(anthropic.status, 'ok');
  });

  it('follows pagination rather than reporting later pages as missing', async () => {
    let call = 0;
    onFetch(() => {
      call++;
      return call === 1
        ? models(['claude-opus-5', 'claude-fable-5'], { has_more: true, last_id: 'claude-fable-5' })
        : models(['claude-sonnet-5', 'claude-haiku-4-5-20251001'], { has_more: false });
    });

    const result = await verifyCatalog([ANTHROPIC]);
    assert.equal(call, 2, 'has_more must be followed');
    assert.equal(reportFor(result.reports, 'anthropic').status, 'ok');
  });

  // Not being able to ask is not evidence that the catalog is wrong, so it
  // must not fail a release — but it does mean the pass was not complete.
  it('reports a vendor it cannot reach without failing the run', async () => {
    onFetch(() => new Response('nope', { status: 404, statusText: 'Not Found' }));

    const result = await verifyCatalog([GOOGLE]);
    const google = reportFor(result.reports, 'google');
    assert.equal(google.status, 'unreachable');
    assert.match(google.detail ?? '', /404/);
    assert.equal(result.ok, true, 'an unaskable vendor is not a stale catalog');
    assert.equal(result.incomplete, true, 'but the pass cannot be called complete');
  });

  it('treats an unexpected response shape as unreachable, not as an empty vendor', async () => {
    onFetch(() => new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await verifyCatalog([GOOGLE]);
    const google = reportFor(result.reports, 'google');
    assert.equal(google.status, 'unreachable', 'a body we cannot parse must not read as "serves nothing"');
    assert.deepEqual(google.missing, []);
    assert.equal(result.ok, true);
  });

  it('skips vendors with no credentials instead of failing them', async () => {
    onFetch(() => models(['gemini-3.6-flash', 'gemini-3.1-flash-lite']));

    const result = await verifyCatalog([GOOGLE]);
    for (const vendor of ['openai', 'xai', 'deepseek', 'perplexity']) {
      assert.equal(reportFor(result.reports, vendor).status, 'skipped', vendor);
    }
    assert.equal(result.ok, true);
    assert.equal(result.incomplete, true);
  });

  // This is the half that catches "still sold, but four generations behind" —
  // the gpt-4o case, which no liveness check would ever flag.
  it('surfaces models the vendor serves that the catalog does not carry', async () => {
    onFetch(() => models(['gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-9.9-unreleased']));

    const result = await verifyCatalog([GOOGLE]);
    assert.deepEqual(reportFor(result.reports, 'google').uncatalogued, ['gemini-9.9-unreleased']);
  });
});
