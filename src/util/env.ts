import { config } from 'dotenv';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Load BoardRoom's .env settings from trusted places only.
 *
 * dotenv's default reads `.env` from the current working directory. Running
 * `boardroom` inside a directory someone else controls (a cloned repo, a
 * shared folder, a downloaded archive) therefore let their .env choose the
 * backend and its address (BOARDROOM_BACKEND=ollama, OLLAMA_HOST=their
 * server), so every prompt, including the private standing context recalled
 * into it, went to them. The same file could also switch caps off, pin
 * delegation tiers, or declare every model free.
 *
 * Settings now come from, in order of precedence:
 *   1. the real environment (never overridden by any file);
 *   2. ~/.boardroom/.env, the per-user settings file;
 *   3. .env in BoardRoom's own package root, the location the README has
 *      always documented ("a .env file in the project root"). It sits next
 *      to the code being run, so it is exactly as trusted as that code.
 * A .env in any other working directory is ignored, with a one-line notice.
 *
 * On POSIX systems a file is also skipped, with a warning, if it is owned by
 * another user or writable by group or others: either way someone else could
 * have put settings in it.
 */

export interface EnvLoadReport {
  loaded: string[];
  skipped: Array<{ path: string; reason: string }>;
  /** A .env in the working directory that was not read. */
  ignored?: string;
}

export interface EnvLoadOptions {
  /** Directory of the running entry point; the package root is found from here. */
  binDir: string;
  cwd?: string;
  home?: string;
  /** Where settings are written. Defaults to process.env. */
  target?: NodeJS.ProcessEnv;
  /** Where notices go. Defaults to stderr, so stdout stays clean for --json. */
  warn?: (message: string) => void;
}

/** The nearest ancestor of `start` holding BoardRoom's package.json, or null. */
export function findPackageRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 6; i++) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf-8'))?.name === 'boardroom') return dir;
      } catch {
        // unreadable manifest: keep looking upward
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Why a settings file must not be trusted, or null if it may be read. */
export function untrustedReason(path: string): string | null {
  const getuid = process.getuid?.bind(process);
  if (!getuid) return null; // Windows: no POSIX ownership or mode bits to check
  const st = statSync(path);
  const uid = getuid();
  if (st.uid !== uid && st.uid !== 0) return `owned by uid ${st.uid}, not you (uid ${uid})`;
  if (st.mode & 0o022) return `writable by group or others (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

/** The settings files to read, highest precedence first. */
export function trustedEnvFiles(binDir: string, home: string): string[] {
  const files: string[] = [];
  if (home && isAbsolute(home)) files.push(join(home, '.boardroom', '.env'));
  const root = findPackageRoot(binDir);
  if (root) files.push(join(root, '.env'));
  return files;
}

export function loadTrustedEnv(opts: EnvLoadOptions): EnvLoadReport {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const home = opts.home ?? homedir();
  const target = opts.target ?? process.env;
  const warn = opts.warn ?? ((m: string) => console.error(m));
  const report: EnvLoadReport = { loaded: [], skipped: [] };

  const candidates = trustedEnvFiles(opts.binDir, home);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let reason: string | null;
    try {
      reason = untrustedReason(path);
    } catch (e: any) {
      reason = `could not be checked: ${e?.message || e}`;
    }
    if (reason) {
      report.skipped.push({ path, reason });
      warn(`BoardRoom: not loading ${path}: it is ${reason}. Fix with: chmod 600 "${path}"`);
      continue;
    }
    // Never overrides: the real environment, then earlier files, win.
    config({ path, processEnv: target, quiet: true, override: false });
    report.loaded.push(path);
  }

  const local = join(cwd, '.env');
  if (existsSync(local) && !candidates.includes(local)) {
    report.ignored = local;
    warn(
      `BoardRoom: ignoring ${local}. Settings are read only from the environment, ` +
        `~/.boardroom/.env, and BoardRoom's own install directory, so a directory you run it in ` +
        `cannot redirect your prompts. Move the settings to ~/.boardroom/.env.`,
    );
  }
  return report;
}
