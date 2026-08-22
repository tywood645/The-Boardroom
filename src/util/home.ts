// Where BoardRoom keeps its state.
//
// `os.homedir()` is not overridable in a test, and it is not overridable in the
// same way across platforms: on POSIX it consults $HOME first, but on Windows
// it reads USERPROFILE and ignores $HOME entirely. Tests that redirect state by
// setting process.env.HOME therefore silently kept writing to the real home
// directory on Windows, asserted against an empty temp dir, and failed there
// while passing on Linux and macOS.
//
// Reading $HOME first on every platform fixes both halves of that: the tests
// redirect correctly everywhere, and a run never writes outside the directory
// the caller nominated. BOARDROOM_HOME takes precedence for callers that want
// to relocate only BoardRoom's state without moving $HOME.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** The home directory BoardRoom resolves its state against. */
export function boardroomHome(): string {
  const explicit = process.env.BOARDROOM_HOME;
  if (explicit) return explicit;
  const home = process.env.HOME;
  if (home) return home;
  return homedir();
}

/** The `.boardroom` state directory, or a path inside it. */
export function boardroomDir(...segments: string[]): string {
  return join(boardroomHome(), '.boardroom', ...segments);
}
