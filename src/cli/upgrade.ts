import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Exec, ExecOutcome } from '../providers/provider-auth.js';
import { CliError } from './errors.js';

export const PACKAGE_NAME = '@perokit/pero';

/** How long asking the npm registry may take. */
const VIEW_TIMEOUT_MS = 60_000;

/** How long installing the package may take; it builds SQLite if it must. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * The npm that comes with the Node.js running Pero, so the package lands
 * where this `pero` is installed; `npm` on `PATH` when there is none.
 */
export function localNpm(node: string = process.execPath): string {
  const beside = join(dirname(node), 'npm');
  return existsSync(beside) ? beside : 'npm';
}

/** The version the `latest` dist-tag of `@perokit/pero` names. */
export async function latestVersion(npm: string, exec: Exec): Promise<string> {
  const outcome = await exec(
    npm,
    ['view', `${PACKAGE_NAME}@latest`, 'version'],
    {
      timeoutMs: VIEW_TIMEOUT_MS,
    },
  );
  const version = outcome.stdout.trim();
  if (outcome.code !== 0 || !parseVersion(version)) {
    const reason =
      outcome.code === 0
        ? `unexpected output from npm view: ${JSON.stringify(version)}`
        : failure(outcome);
    throw new CliError(
      `Could not find the latest version of ${PACKAGE_NAME}: ${reason}`,
    );
  }
  return version;
}

/**
 * Throws a `CliError` unless `packageRoot`, the running Pero, is the
 * package `npm install -g` replaces: a checkout or an `npm link` is
 * updated from Git instead.
 */
export async function requireGlobalInstall(
  npm: string,
  exec: Exec,
  packageRoot: string,
): Promise<void> {
  const outcome = await exec(npm, ['root', '-g'], {
    timeoutMs: VIEW_TIMEOUT_MS,
  });
  if (outcome.code !== 0) {
    throw new CliError(
      `Could not find npm's global packages: ${failure(outcome)}`,
    );
  }
  const installed = join(outcome.stdout.trim(), PACKAGE_NAME);
  if (!isSamePackage(installed, packageRoot)) {
    throw new CliError(
      `This pero runs from ${packageRoot}, not from npm's global packages (${installed}), so pero upgrade cannot replace it. ` +
        `Update a checkout with git pull, npm ci, and npm run build; or install Pero with npm install -g ${PACKAGE_NAME}.`,
    );
  }
}

/** Installs `version` of `@perokit/pero` globally. */
export async function installVersion(
  npm: string,
  exec: Exec,
  version: string,
): Promise<void> {
  const spec = `${PACKAGE_NAME}@${version}`;
  const outcome = await exec(npm, ['install', '-g', spec], {
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (outcome.code === 0) return;
  const output = failure(outcome);
  const hint = /EACCES|EPERM/.test(output)
    ? `\nnpm may not write to its global packages as this account. Install it as the account that can, such as with sudo npm install -g ${spec}, then run pero upgrade again to restart Pero.`
    : '';
  throw new CliError(`npm install -g ${spec} failed:\n${output}${hint}`);
}

/** The version in `packageRoot`'s `package.json`, read from disk now. */
export function versionOnDisk(packageRoot: string): string {
  return (
    JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
}

/**
 * Orders two `X.Y.Z` versions, with an optional prerelease suffix that
 * comes before the release itself: negative when `a` is older.
 */
export function compareVersions(a: string, b: string): number {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  if (!left || !right) throw new Error(`Not a version: ${left ? b : a}`);
  for (let i = 0; i < 3; i++) {
    const delta = left.release[i]! - right.release[i]!;
    if (delta !== 0) return delta;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

interface Version {
  release: [number, number, number];
  prerelease: string | null;
}

function parseVersion(version: string): Version | null {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version,
    );
  if (!match) return null;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

/** Semver precedence of two prerelease suffixes, such as `beta.2`. */
function comparePrerelease(a: string, b: string): number {
  const [left, right] = [a.split('.'), b.split('.')];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const [x, y] = [left[i], right[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Whether `installed` is `packageRoot` itself, not a link to it. */
function isSamePackage(installed: string, packageRoot: string): boolean {
  try {
    return (
      !lstatSync(installed).isSymbolicLink() &&
      realpathSync(installed) === realpathSync(packageRoot)
    );
  } catch {
    return false;
  }
}

/** What a failed command printed, or why it did not run. */
function failure(outcome: ExecOutcome): string {
  const output = (outcome.stderr ?? '').trim() || outcome.stdout.trim();
  if (output) return output;
  if (outcome.error?.killed) return 'it did not finish in time';
  return outcome.error?.message ?? `exited with code ${String(outcome.code)}`;
}
