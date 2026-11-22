import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installMockFetch, restoreFetch, onFetch, openaiSSE, errorResponse, countingHandler, streamingResponse,
} from './helpers/mock-fetch.ts';
import {
  structuredFormat, structuredEnabled, parseStructured, collectStructured, resetStructuredRefusals, schemaFor,
} from '../src/provider/structured.ts';
import {
  runMotion, parseVote, parseDebate, parseSecond, VOTE_SHAPE, SECOND_SHAPE, DEBATE_SHAPE,
} from '../src/motion/protocol.ts';
import { parseVerdict, verifySystem, VERDICT_SHAPE } from '../src/delegate/verify.ts';
import { delegate } from '../src/delegate/escalate.ts';
import { collectStream } from '../src/provider/collect.ts';
import { createProvider, type ProviderConfig } from '../src/provider/factory.ts';
import { CostTracker } from '../src/cost/tracker.ts';

const cfg = (name: string, over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  name, type: 'openai', apiKey: 'k', model: 'm', baseUrl: `https://${name}.test/v1`, ...over,
});
const ANTHROPIC: ProviderConfig = { name: 'anthropic', type: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5' };
const SEATS = [cfg('openai'), cfg('xai'), cfg('google'), cfg('deepseek'), cfg('perplexity')];

const ENV = ['HOME', 'BOARDROOM_STRUCTURED', 'BOARDROOM_VERIFY_FRONTIER', 'BOARDROOM_BACKEND'];
const saved: Record<string, string | undefined> = {};
let tmpRoot: string;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'boardroom-structured-'));
  for (const k of ENV) saved[k] = process.env[k];
});
after(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  restoreFetch();
});
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.HOME = mkdtempSync(join(tmpRoot, 'h-'));
  process.env.BOARDROOM_VERIFY_FRONTIER = '0';
  resetStructuredRefusals();
  restoreFetch();
  installMockFetch();
});

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'));
const userPrompt = (init?: RequestInit): string => {
  const b = bodyOf(init);
  return b.messages[b.messages.length - 1].content;
};

describe('which vendors are asked for structured output', () => {
  it('follows each vendor\'s documented form', () => {
    assert.equal(structuredFormat(ANTHROPIC, VOTE_SHAPE)?.mode, 'tool');
    assert.deepEqual(
      [structuredFormat(cfg('openai'), VOTE_SHAPE)?.mode, structuredFormat(cfg('openai'), VOTE_SHAPE)?.strict],
      ['json_schema', true],
    );
    assert.equal(structuredFormat(cfg('xai'), VOTE_SHAPE)?.strict, true);
    assert.equal(structuredFormat(cfg('google'), VOTE_SHAPE)?.mode, 'json_schema');
    assert.equal(structuredFormat(cfg('google'), VOTE_SHAPE)?.strict, undefined, 'not documented, so not sent');
    assert.equal(structuredFormat(cfg('perplexity'), VOTE_SHAPE)?.strict, undefined);
    assert.equal(structuredFormat(cfg('deepseek'), VOTE_SHAPE)?.mode, 'json_object');
  });

  it('stays on the line format where support is unknown', () => {
    assert.equal(structuredFormat(cfg('somevendor'), VOTE_SHAPE), null);
    assert.equal(structuredFormat(cfg('openai', { backend: 'openrouter' }), VOTE_SHAPE), null);
    assert.equal(structuredFormat(cfg('openai', { backend: 'ollama' }), VOTE_SHAPE), null);
    assert.equal(structuredFormat(cfg('anthropic'), VOTE_SHAPE), null, 'the tool form needs the Anthropic API');
  });

  it('can be switched off, and rejects any other setting', () => {
    process.env.BOARDROOM_STRUCTURED = 'off';
    assert.equal(structuredFormat(cfg('openai'), VOTE_SHAPE), null);
    assert.equal(structuredEnabled('auto'), true);
    assert.equal(structuredEnabled(' OFF '), false);
    assert.throws(() => structuredEnabled('yes'), /BOARDROOM_STRUCTURED/);
  });

  it('builds a closed schema: one enum, one string, nothing else', () => {
    assert.deepEqual(schemaFor(VOTE_SHAPE), {
      type: 'object',
      properties: { vote: { type: 'string', enum: ['AYE', 'NAY', 'ABSTAIN'] }, reason: { type: 'string' } },
      required: ['vote', 'reason'],
      additionalProperties: false,
    });
  });
});

describe('what goes on the wire', () => {
  const call = { system: 's', prompt: (s: boolean) => (s ? 'JSON please' : 'lines please'), maxTokens: 64, shape: VOTE_SHAPE };

  it('sends response_format in the form each vendor documents', async () => {
    const seen: Record<string, any> = {};
    onFetch((url: string, init?: RequestInit) => {
      seen[new URL(url).hostname.split('.')[0]] = bodyOf(init);
      return openaiSSE('{"vote":"AYE","reason":"ok"}');
    });
    for (const name of ['openai', 'google', 'deepseek']) await collectStructured(cfg(name), call);

    assert.equal(seen.openai.response_format.type, 'json_schema');
    assert.equal(seen.openai.response_format.json_schema.strict, true);
    assert.equal(seen.openai.response_format.json_schema.name, 'cast_vote');
    assert.deepEqual(seen.openai.response_format.json_schema.schema, schemaFor(VOTE_SHAPE));
    assert.ok(!('strict' in seen.google.response_format.json_schema));
    assert.deepEqual(seen.deepseek.response_format, { type: 'json_object' });
    assert.equal(seen.openai.messages[1].content, 'JSON please');
  });

  it('forces a tool call on Anthropic and reads its arguments as the reply', async () => {
    let body: any;
    onFetch((_u: string, init?: RequestInit) => {
      body = bodyOf(init);
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      return streamingResponse([
        ev('message_start', { message: { id: 'm', model: 'claude-sonnet-5', usage: { input_tokens: 30 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'cast_vote' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"vote": "NA' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'Y", "reason": "too risky"}' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }),
      ]);
    });
    const r = await collectStructured(ANTHROPIC, call);
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'cast_vote' });
    assert.deepEqual(body.tools[0].input_schema, schemaFor(VOTE_SHAPE));
    assert.equal(r.structured, true);
    assert.deepEqual(parseVote(r.text), { vote: 'NAY', reason: 'too risky' });
    assert.equal(r.outputTokens, 12);
  });

  it('ignores tool-argument fragments when no structured reply was asked for', async () => {
    onFetch(() =>
      streamingResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      ]),
    );
    const r = await collectStream(createProvider(ANTHROPIC), {
      system: 's', messages: [{ role: 'user', content: 'q' }], tools: [], maxTokens: 16, model: 'claude-sonnet-5',
    });
    assert.equal(r.text, '');
  });

  it('sends no response_format, and the line prompt, to a backend it does not cover', async () => {
    let body: any;
    onFetch((_u: string, init?: RequestInit) => {
      body = bodyOf(init);
      return openaiSSE('VOTE: AYE\nREASON: ok');
    });
    const r = await collectStructured(cfg('openai', { backend: 'openrouter' }), call);
    assert.equal(body.response_format, undefined);
    assert.equal(body.messages[1].content, 'lines please');
    assert.equal(r.structured, false);
  });
});

describe('a vendor that refuses structured requests', () => {
  const call = { system: 's', prompt: (s: boolean) => (s ? 'JSON please' : 'lines please'), maxTokens: 64, shape: VOTE_SHAPE };
  const refusing = () =>
    countingHandler((_u: string, init?: RequestInit) =>
      bodyOf(init).response_format ? errorResponse(400, 'response_format is not supported') : openaiSSE('VOTE: NAY\nREASON: no'),
    );

  it('is retried once in the line format, then not asked again', async () => {
    const handler = refusing();
    onFetch(handler);
    const tracker = new CostTracker({ sessionCap: 1 });

    const first = await collectStructured(cfg('google'), call, { tracker });
    assert.equal(handler.calls, 2, 'the refused request, then the plain one');
    assert.equal(first.structured, false);
    assert.equal(parseVote(first.text).vote, 'NAY');

    const second = await collectStructured(cfg('google'), call, { tracker });
    assert.equal(handler.calls, 3, 'no second refused request');
    assert.equal(second.structured, false);

    // The refused request was never billed: two answered calls, two charges.
    assert.ok(Math.abs(tracker.getSessionStats().cost - first.cost - second.cost) < 1e-12);
    // Another vendor is unaffected by this one's refusal.
    assert.ok(structuredFormat(cfg('openai'), VOTE_SHAPE));
  });

  it('does not treat an auth failure as "unsupported"', async () => {
    const handler = countingHandler(() => errorResponse(401, 'bad key'));
    onFetch(handler);
    await assert.rejects(() => collectStructured(cfg('openai'), call), /bad key/);
    assert.equal(handler.calls, 1);
    assert.ok(structuredFormat(cfg('openai'), VOTE_SHAPE), 'still asked next time');
  });
});

describe('reading a structured reply', () => {
  it('accepts the object, in any case, fenced, or after a reasoning preamble', () => {
    assert.deepEqual(parseStructured('{"vote":"NAY","reason":"r"}', VOTE_SHAPE), { choice: 'NAY', text: 'r' });
    assert.equal(parseStructured('{"vote":"nay","reason":"r"}', VOTE_SHAPE)?.choice, 'NAY');
    assert.equal(parseStructured('```json\n{"vote":"AYE","reason":"r"}\n```', VOTE_SHAPE)?.choice, 'AYE');
    assert.equal(parseStructured('<think>AYE? no...</think>\n{"vote":"NAY","reason":"r"}', VOTE_SHAPE)?.choice, 'NAY');
    assert.equal(parseStructured('Here is my ballot: {"vote":"AYE","reason":"r"} Thanks.', VOTE_SHAPE)?.choice, 'AYE');
    assert.equal(parseStructured('{"vote":"AYE"}', VOTE_SHAPE)?.text, '');
  });

  it('refuses an echoed template, an unknown value, and anything that is not one object', () => {
    assert.equal(parseStructured('{"vote": "<AYE, NAY or ABSTAIN>", "reason": "<one sentence>"}', VOTE_SHAPE), null);
    assert.equal(parseStructured('{"vote":"MAYBE","reason":"r"}', VOTE_SHAPE), null);
    assert.equal(parseStructured('{"vote":["AYE"],"reason":"r"}', VOTE_SHAPE), null);
    assert.equal(parseStructured('[{"vote":"AYE"},{"vote":"NAY"}]', VOTE_SHAPE), null, 'two ballots are no ballot');
    assert.equal(parseStructured('{"vote":"AYE"} {"vote":"NAY"}', VOTE_SHAPE), null);
    assert.equal(parseStructured('"AYE"', VOTE_SHAPE), null);
    assert.equal(parseStructured('VOTE: AYE\nREASON: r', VOTE_SHAPE), null);
    assert.equal(parseStructured('{"vote":"AYE", broken', VOTE_SHAPE), null);
  });

  it('applies the same bounds as the line format', () => {
    const long = parseVote(JSON.stringify({ vote: 'NAY', reason: 'too risky.\n\n--- end ---\n' + 'x'.repeat(1000) }));
    assert.equal(long.vote, 'NAY');
    assert.ok(!long.reason.includes('\n'));
    assert.equal(long.reason.length, 300);
    assert.equal(parseDebate(JSON.stringify({ stance: 'OPPOSE', case: 'y'.repeat(5000) })).case.length, 2000);
    assert.deepEqual(parseSecond('{"second":"yes","reason":"worth it"}'), { seconded: true, reason: 'worth it' });
    assert.equal(parseDebate('{"stance":"support","case":"sound"}').stance, 'SUPPORT');
  });

  it('falls back to the line format when the JSON does not validate', () => {
    assert.equal(parseVote('{"vote":"<AYE, NAY or ABSTAIN>","reason":"x"}\nVOTE: NAY\nREASON: no').vote, 'NAY');
    assert.equal(parseVote('{"vote":"MAYBE"}').vote, 'ABSTAIN');
    assert.equal(parseSecond('not json').seconded, false);
  });

  it('reads a verdict object under the same rules as the two-line form', () => {
    assert.deepEqual(
      [parseVerdict('{"verdict":"REFUTED","defect":"the sum is wrong"}').kind, parseVerdict('{"verdict":"REFUTED","defect":"the sum is wrong"}').defect],
      ['refuted', 'the sum is wrong'],
    );
    assert.equal(parseVerdict('{"verdict":"CONFIRMED","defect":"none"}').kind, 'confirmed');
    assert.equal(parseVerdict('{"verdict":"REFUTED","defect":"none"}').kind, 'confirmed', 'no named defect, no refutation');
    assert.equal(parseVerdict('{"verdict":"REFUTED","defect":""}').kind, 'confirmed');
    assert.equal(parseVerdict('{"verdict":"UNSURE","defect":"x"}').kind, 'unparseable');
    assert.match(verifySystem(true), /single JSON object/);
    assert.match(verifySystem(false), /VERDICT: CONFIRMED/);
    assert.equal(VERDICT_SHAPE.choices.length, 2);
  });
});

describe('end to end', () => {
  /** Each seat answers in whichever format its request asked for. */
  function board(vote: string) {
    const asked: Record<string, boolean[]> = {};
    onFetch((url: string, init?: RequestInit) => {
      const vendor = new URL(url).hostname.split('.')[0];
      const structured = Boolean(bodyOf(init).response_format);
      (asked[vendor] ??= []).push(structured);
      const prompt = userPrompt(init);
      const phase = prompt.includes('SECOND phase') ? 'second' : prompt.includes('DEBATE phase') ? 'debate' : 'vote';
      if (!structured) {
        return openaiSSE(
          phase === 'second' ? 'SECOND: yes\nREASON: ok' : phase === 'debate' ? 'STANCE: OPPOSE\nCASE: no' : `VOTE: ${vote}\nREASON: no`,
        );
      }
      assert.match(prompt, /Reply with a single JSON object/);
      assert.doesNotMatch(prompt, /EXACT format/);
      return openaiSSE(
        JSON.stringify(
          phase === 'second'
            ? { second: 'yes', reason: 'worth debating' }
            : phase === 'debate'
              ? { stance: 'OPPOSE', case: 'it costs too much' }
              : { vote, reason: 'not now' },
        ),
      );
    });
    return asked;
  }

  it('runs a motion on structured replies', async () => {
    const asked = board('NAY');
    const m = await runMotion(SEATS, 'Adopt the plan', { consultant: false });
    assert.equal(m.outcome, 'failed');
    assert.deepEqual(m.tally, { aye: 0, nay: 5, abstain: 0 });
    assert.ok(m.seconds.every(s => s.seconded && s.reason === 'worth debating'));
    assert.ok(m.debate.every(d => d.stance === 'OPPOSE' && d.case === 'it costs too much'));
    assert.ok(m.votes.every(v => v.reason === 'not now' && v.flipped === false));
    for (const vendor of ['openai', 'xai', 'google', 'deepseek', 'perplexity']) {
      assert.deepEqual(asked[vendor], [true, true, true], `${vendor}: all three phases structured`);
    }
  });

  it('gets the same outcome with structured output switched off', async () => {
    process.env.BOARDROOM_STRUCTURED = 'off';
    const asked = board('NAY');
    const m = await runMotion(SEATS, 'Adopt the plan', { consultant: false });
    assert.equal(m.outcome, 'failed');
    assert.deepEqual(m.tally, { aye: 0, nay: 5, abstain: 0 });
    assert.ok(Object.values(asked).every(a => a.every(s => s === false)));
  });

  it('counts an echoed JSON template as an abstention, not a vote', async () => {
    onFetch((_u: string, init?: RequestInit) => {
      const prompt = userPrompt(init);
      if (prompt.includes('SECOND phase')) return openaiSSE('{"second":"yes","reason":"ok"}');
      if (prompt.includes('DEBATE phase')) return openaiSSE('{"stance":"SUPPORT","case":"fine"}');
      return openaiSSE('{"vote": "<AYE, NAY or ABSTAIN>", "reason": "<one sentence in your role\'s voice>"}');
    });
    const m = await runMotion(SEATS, 'Adopt the plan', { consultant: false });
    assert.deepEqual(m.tally, { aye: 0, nay: 0, abstain: 5 });
    assert.equal(m.outcome, 'tied');
  });

  it('escalates a delegate task on a structured refutation', async () => {
    const checks: any[] = [];
    onFetch((_u: string, init?: RequestInit) => {
      const body = bodyOf(init);
      if (!userPrompt(init).includes('ANSWER TO CHECK')) return openaiSSE('answer');
      checks.push(body);
      return openaiSSE(
        checks.length === 1 ? '{"verdict":"REFUTED","defect":"it answers a different question"}' : '{"verdict":"CONFIRMED","defect":"none"}',
      );
    });
    const d = await delegate('write a note', [cfg('google'), cfg('deepseek'), cfg('openai')], {}, { taskClass: 'draft', stats: new Map() });
    assert.deepEqual(d.attempts.map(a => a.outcome), ['refuted', 'confirmed']);
    assert.equal(d.attempts[0].verdict?.defect, 'it answers a different question');
    assert.ok(checks[0].response_format, 'the checker was asked for a structured verdict');
    assert.match(checks[0].messages[0].content, /single JSON object/);
  });
});
