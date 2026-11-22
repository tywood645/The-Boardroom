import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { BoardRoomError } from './error.js';

/**
 * ~/.boardroom, created 0o700 on first use. The one place the state directory
 * is resolved; it used to be worked out separately in four files.
 *
 * os.homedir() returns HOME verbatim, so with HOME set to an empty string the
 * old code resolved state to `./.boardroom` in whatever directory the command
 * ran from. In someone else's directory that means reading their planted
 * context.md into every prompt and writing the spend ledger where they can
 * edit it. A home directory that is not an absolute path is refused.
 */
export function boardroomDir(): string {
  const home = homedir();
  if (!home || !isAbsolute(home)) {
    throw new BoardRoomError(
      `Cannot locate a home directory for BoardRoom state (HOME is "${home}"). Set HOME to an absolute path.`,
      'NO_HOME',
    );
  }
  const dir = join(home, '.boardroom');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A subdirectory of ~/.boardroom, created 0o700 on first use. */
export function boardroomSubdir(name: string): string {
  const dir = join(boardroomDir(), name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
