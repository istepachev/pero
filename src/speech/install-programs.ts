import { spawn } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { LocalPrograms } from './local-engine.js';
import { findProgram } from './run-program.js';
import { downloadModel } from './speech-setup.js';

// Shared by the CLI and its tests. Keep this free of Nest and TypeORM imports.

/** The whisper.cpp release Pero builds when no package manager has it. */
export const WHISPER_CPP_VERSION = '1.9.5';
/** The Piper release Pero installs in its own Python environment. */
export const PIPER_TTS_VERSION = '1.8.0';

/** The package managers Pero installs the local engine's programs with. */
export const PACKAGE_MANAGERS = [
  'brew',
  'apt-get',
  'dnf',
  'pacman',
  'apk',
] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** A program the `local` engine runs that isn't installed. */
export interface MissingProgram {
  /** Its key in `speech.programs`. */
  key: keyof LocalPrograms;
  /** As `config.yaml` names it. */
  program: string;
}

/**
 * Runs `program` with `args` on this terminal, its output and questions
 * (such as sudo's password) the owner's. Resolves to why it failed, or
 * null when it succeeded.
 */
export type RunInTerminal = (
  program: string,
  args: readonly string[],
) => Promise<string | null>;

/** What this machine offers for installing programs; tests replace it. */
export interface InstallEnvironment {
  /** The package manager found, null for none Pero knows. */
  manager: PackageManager | null;
  /** Whether Pero runs as root, so it needs no sudo. */
  root: boolean;
  /** Whether sudo is installed. */
  sudo: boolean;
  /** Whether `program` is on `PATH`. */
  has: (program: string) => boolean;
  run: RunInTerminal;
  /** How many jobs a build runs at once. */
  jobs: number;
  /** Downloads go through this. */
  fetch?: typeof fetch;
}

/** One command, download, or link an install task runs. */
export type InstallStep =
  | { kind: 'run'; program: string; args: string[] }
  | { kind: 'download'; url: string; name: string; folder: string }
  /** Puts `target` at `path`, replacing what is there. */
  | { kind: 'link'; target: string; path: string };

/** Something Pero installs, and the steps that do it. */
export interface InstallTask {
  /** What it does, for the owner. */
  summary: string;
  steps: InstallStep[];
}

/** How Pero would install the programs missing. */
export interface InstallPlan {
  tasks: InstallTask[];
  /** Commands the owner must run as root themselves, as Pero can't. */
  manual: string[];
}

/** This machine, as found on `PATH` now. */
export function localInstallEnvironment(
  fetchFile?: typeof fetch,
): InstallEnvironment {
  const has = (program: string) => findProgram(program) !== null;
  return {
    manager: PACKAGE_MANAGERS.find(has) ?? null,
    root: process.getuid?.() === 0,
    sudo: has('sudo'),
    has,
    run: runInTerminal,
    jobs: availableParallelism(),
    ...(fetchFile === undefined ? {} : { fetch: fetchFile }),
  };
}

/** The packages each manager installs a need from. */
const PACKAGES: Record<
  Exclude<PackageManager, 'brew'>,
  {
    ffmpeg: string;
    cmake: string;
    compiler: string;
    make: string;
    python: string;
  }
> = {
  'apt-get': {
    ffmpeg: 'ffmpeg',
    cmake: 'cmake',
    compiler: 'g++',
    make: 'make',
    python: 'python3',
  },
  dnf: {
    ffmpeg: 'ffmpeg-free',
    cmake: 'cmake',
    compiler: 'gcc-c++',
    make: 'make',
    python: 'python3',
  },
  pacman: {
    ffmpeg: 'ffmpeg',
    cmake: 'cmake',
    compiler: 'gcc',
    make: 'make',
    python: 'python',
  },
  apk: {
    ffmpeg: 'ffmpeg',
    cmake: 'cmake',
    compiler: 'g++',
    make: 'make',
    python: 'python3',
  },
};

/**
 * How to install `missing` with `environment`, into `tools`: the package
 * manager's packages, as root unless it is brew; whisper.cpp built from
 * source when brew can't install it; Piper in a Python environment of
 * its own. What Pero builds itself is linked into `tools/bin`, where the
 * `local` engine looks first. Null when there is no package manager Pero
 * knows. Without a terminal (`interactive` false), sudo mustn't ask for
 * a password.
 */
export function installPlan(
  missing: readonly MissingProgram[],
  environment: InstallEnvironment,
  tools: string,
  interactive: boolean,
): InstallPlan | null {
  const { manager, has } = environment;
  if (manager === null || missing.length === 0) return null;
  const needs = new Set(missing.map(({ key }) => key));
  const name = (key: keyof LocalPrograms) =>
    basename(missing.find((program) => program.key === key)!.program);
  const tasks: InstallTask[] = [];
  const manual: string[] = [];

  if (manager === 'brew') {
    const packages = [
      ...(needs.has('ffmpeg') ? ['ffmpeg'] : []),
      ...(needs.has('whisper') ? ['whisper-cpp'] : []),
      ...(needs.has('piper') && !has('python3') ? ['python'] : []),
    ];
    if (packages.length > 0) {
      const step = run('brew', ['install', ...packages]);
      tasks.push({ summary: display(step), steps: [step] });
    }
  } else {
    const names = PACKAGES[manager];
    const packages = [
      ...(needs.has('ffmpeg') ? [names.ffmpeg] : []),
      ...(needs.has('whisper')
        ? [
            ...(has('cmake') ? [] : [names.cmake]),
            ...(has('c++') || has('g++') ? [] : [names.compiler]),
            ...(has('make') ? [] : [names.make]),
          ]
        : []),
      ...(needs.has('piper')
        ? [
            ...(has('python3') ? [] : [names.python]),
            // Debian leaves venv out of python3.
            ...(manager === 'apt-get' ? ['python3-venv'] : []),
          ]
        : []),
    ];
    if (packages.length > 0) {
      const commands = systemInstall(manager, [...new Set(packages)]);
      const prefix = environment.root
        ? []
        : environment.sudo
          ? interactive
            ? ['sudo']
            : ['sudo', '-n']
          : null;
      if (prefix === null) {
        manual.push(...commands.map((command) => command.join(' ')));
      } else {
        const steps = commands.map((command) => {
          const [program, ...args] = [...prefix, ...command];
          return run(program!, args);
        });
        const last = steps.at(-1)!;
        tasks.push({
          summary:
            display(last) +
            (prefix.length > 0 && interactive
              ? ' (sudo may ask for your password)'
              : ''),
          steps,
        });
      }
    }
  }

  if (needs.has('whisper') && manager !== 'brew') {
    tasks.push(buildWhisper(tools, environment.jobs, name('whisper')));
  }
  if (needs.has('piper')) {
    tasks.push(installPiper(tools, name('piper')));
  }
  return { tasks, manual };
}

/** The commands that install `packages` with `manager`, as root. */
function systemInstall(
  manager: Exclude<PackageManager, 'brew'>,
  packages: string[],
): string[][] {
  switch (manager) {
    case 'apt-get':
      return [
        ['apt-get', 'update'],
        [
          'env',
          'DEBIAN_FRONTEND=noninteractive',
          'apt-get',
          'install',
          '-y',
          ...packages,
        ],
      ];
    case 'dnf':
      return [['dnf', 'install', '-y', ...packages]];
    case 'pacman':
      return [['pacman', '-S', '--needed', '--noconfirm', ...packages]];
    case 'apk':
      return [['apk', 'add', ...packages]];
  }
}

/**
 * whisper.cpp's whisper-cli, built from its release's source in `tools`
 * and linked into `tools/bin` as `program`.
 */
function buildWhisper(
  tools: string,
  jobs: number,
  program: string,
): InstallTask {
  const name = `whisper.cpp-${WHISPER_CPP_VERSION}`;
  const source = join(tools, name);
  const build = join(source, 'build');
  return {
    summary: `build whisper.cpp ${WHISPER_CPP_VERSION} in ${source} (a few minutes)`,
    steps: [
      {
        kind: 'download',
        url: `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz`,
        name: `${name}.tar.gz`,
        folder: tools,
      },
      run('tar', ['-xzf', join(tools, `${name}.tar.gz`), '-C', tools]),
      run('cmake', [
        '-S',
        source,
        '-B',
        build,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DWHISPER_BUILD_TESTS=OFF',
        '-DWHISPER_BUILD_SERVER=OFF',
      ]),
      run('cmake', [
        '--build',
        build,
        '--config',
        'Release',
        '--target',
        'whisper-cli',
        '-j',
        String(Math.max(1, jobs)),
      ]),
      {
        kind: 'link',
        target: join(build, 'bin', 'whisper-cli'),
        path: join(tools, 'bin', program),
      },
    ],
  };
}

/** Piper, in a Python environment of its own in `tools`, linked as `program`. */
function installPiper(tools: string, program: string): InstallTask {
  const venv = join(tools, 'piper');
  return {
    summary: `install Piper ${PIPER_TTS_VERSION} in ${venv}`,
    steps: [
      run('python3', ['-m', 'venv', venv]),
      run(join(venv, 'bin', 'pip'), [
        'install',
        '--disable-pip-version-check',
        `piper-tts==${PIPER_TTS_VERSION}`,
      ]),
      {
        kind: 'link',
        target: join(venv, 'bin', 'piper'),
        path: join(tools, 'bin', program),
      },
    ],
  };
}

function run(program: string, args: string[]): InstallStep {
  return { kind: 'run', program, args };
}

/** `step` as the owner would type it. */
export function display(step: InstallStep): string {
  if (step.kind === 'download') {
    return `download ${step.url} to ${step.folder}`;
  }
  if (step.kind === 'link') {
    return `ln -sf ${step.target} ${step.path}`;
  }
  return [step.program, ...step.args]
    .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part}'`))
    .join(' ');
}

/**
 * Runs `plan`'s tasks in order, saying what each does, and stops at the
 * first step that fails. Resolves to that step and why it failed, or null
 * when every task succeeded.
 */
export async function runInstall(
  plan: InstallPlan,
  environment: InstallEnvironment,
  print: (text: string) => void,
): Promise<string | null> {
  for (const task of plan.tasks) {
    print(`Installing: ${task.summary}`);
    for (const step of task.steps) {
      const problem = await runStep(step, environment);
      if (problem !== null) return `${display(step)} failed: ${problem}`;
    }
  }
  return null;
}

async function runStep(
  step: InstallStep,
  environment: InstallEnvironment,
): Promise<string | null> {
  if (step.kind === 'run') {
    return environment.run(step.program, step.args);
  }
  try {
    if (step.kind === 'download') {
      await downloadModel(
        { name: step.name, url: step.url, sizeMb: 0 },
        step.folder,
        environment.fetch,
      );
    } else {
      await mkdir(dirname(step.path), { recursive: true });
      await rm(step.path, { force: true });
      await symlink(step.target, step.path);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Runs a program on this terminal, never through a shell. */
export const runInTerminal: RunInTerminal = (program, args) =>
  new Promise((resolve) => {
    const child = spawn(program, args, { stdio: 'inherit' });
    child.once('error', (error: NodeJS.ErrnoException) => {
      resolve(
        error.code === 'ENOENT' ? `${program} isn't installed` : error.message,
      );
    });
    child.once('close', (code, signal) => {
      resolve(
        code === 0
          ? null
          : signal === null
            ? `exited with ${code}`
            : `stopped by ${signal}`,
      );
    });
  });
