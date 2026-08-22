// State-location tests.
//
// These exist because of a real defect. Every state module resolved its
// directory with os.homedir(), and every test redirected state by setting
// process.env.HOME. On POSIX that works, because homedir() consults $HOME. On
// Windows homedir() reads USERPROFILE and ignores $HOME entirely, so the
// redirect silently did nothing: the suite wrote into the developer's real
// ~/.boardroom, then asserted against an empty temp directory and failed there
// while passing everywhere else.
//
// The first test pins the resolution order. The second is the one that matters:
// it asserts no source file resolves the state directory on its own, which is
// what stops the bug from creeping back in one module at a time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boardroomHome, boardroomDir } from '../src/util/home.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('state location', () => {
  it('prefers BOARDROOM_HOME, then HOME, on every platform', () => {
    const origHome = process.env.HOME;
    const origExplicit = process.env.BOARDROOM_HOME;
    try {
      process.env.HOME = '/tmp/home-a';
      delete process.env.BOARDROOM_HOME;
      assert.equal(boardroomHome(), '/tmp/home-a');

      process.env.BOARDROOM_HOME = '/tmp/home-b';
      assert.equal(boardroomHome(), '/tmp/home-b', 'BOARDROOM_HOME wins over HOME');

      // The directory helper composes onto whichever home won.
      assert.equal(boardroomDir(), join('/tmp/home-b', '.boardroom'));
      assert.equal(boardroomDir('meetings'), join('/tmp/home-b', '.boardroom', 'meetings'));
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origExplicit === undefined) delete process.env.BOARDROOM_HOME;
      else process.env.BOARDROOM_HOME = origExplicit;
    }
  });

  it('is resolved in exactly one place', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(join('util', 'home.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      if (/homedir\s*\(/.test(text) || /['"`]\.boardroom['"`]/.test(text)) {
        offenders.push(file.slice(SRC.length + 1).replace(/\\/g, '/'));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these files resolve the state directory themselves instead of using util/home.ts: ${offenders.join(', ')}`,
    );
  });
});
