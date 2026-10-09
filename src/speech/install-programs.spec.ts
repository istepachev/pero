import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  display,
  type InstallEnvironment,
  type InstallPlan,
  installPlan,
  type MissingProgram,
  PIPER_TTS_VERSION,
  runInstall,
  WHISPER_CPP_VERSION,
} from './install-programs.js';
import { localPrograms } from './local-engine.js';

const TOOLS = '/ws/.pero/tools';
const SOURCE = `${TOOLS}/whisper.cpp-${WHISPER_CPP_VERSION}`;

const ALL: MissingProgram[] = [
  { key: 'ffmpeg', program: 'ffmpeg' },
  { key: 'whisper', program: 'whisper-cli' },
  { key: 'piper', program: 'piper' },
];

function environment(
  overrides: Partial<InstallEnvironment> = {},
): InstallEnvironment {
  return {
    manager: 'apt-get',
    root: false,
    sudo: true,
    has: (program) => program === 'python3',
    run: () => Promise.resolve(null),
    jobs: 4,
    ...overrides,
  };
}

/** Each task's summary, and its steps as the owner would type them. */
function commands(plan: InstallPlan | null): string[][] {
  return (plan?.tasks ?? []).map((task) => [
    task.summary,
    ...task.steps.map(display),
  ]);
}

describe('installPlan', () => {
  it('installs packages with sudo, builds whisper.cpp, and puts Piper in a venv', () => {
    const plan = installPlan(ALL, environment(), TOOLS, true);

    expect(plan?.manual).toEqual([]);
    expect(commands(plan)).toEqual([
      [
        'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg cmake g++ make python3-venv (sudo may ask for your password)',
        'sudo apt-get update',
        'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg cmake g++ make python3-venv',
      ],
      [
        `build whisper.cpp ${WHISPER_CPP_VERSION} in ${SOURCE} (a few minutes)`,
        `download https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz to ${TOOLS}`,
        `tar -xzf ${SOURCE}.tar.gz -C ${TOOLS}`,
        `cmake -S ${SOURCE} -B ${SOURCE}/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF`,
        `cmake --build ${SOURCE}/build --config Release --target whisper-cli -j 4`,
        `ln -sf ${SOURCE}/build/bin/whisper-cli ${TOOLS}/bin/whisper-cli`,
      ],
      [
        `install Piper ${PIPER_TTS_VERSION} in ${TOOLS}/piper`,
        `python3 -m venv ${TOOLS}/piper`,
        `${TOOLS}/piper/bin/pip install --disable-pip-version-check piper-tts==${PIPER_TTS_VERSION}`,
        `ln -sf ${TOOLS}/piper/bin/piper ${TOOLS}/bin/piper`,
      ],
    ]);
  });

  it('asks only for what is missing, and links under the configured name', () => {
    const plan = installPlan(
      [{ key: 'whisper', program: 'whisper' }],
      environment({ root: true, has: (program) => program !== 'cmake' }),
      TOOLS,
      true,
    );

    expect(commands(plan)[0]).toEqual([
      'env DEBIAN_FRONTEND=noninteractive apt-get install -y cmake',
      'apt-get update',
      'env DEBIAN_FRONTEND=noninteractive apt-get install -y cmake',
    ]);
    expect(commands(plan)[1]?.at(-1)).toBe(
      `ln -sf ${SOURCE}/build/bin/whisper-cli ${TOOLS}/bin/whisper`,
    );
    // ffmpeg alone needs no build.
    expect(
      installPlan(
        [{ key: 'ffmpeg', program: 'ffmpeg' }],
        environment(),
        TOOLS,
        true,
      )?.tasks,
    ).toHaveLength(1);
  });

  it("uses sudo -n without a terminal, and leaves root's commands to the owner without sudo", () => {
    const quiet = installPlan(ALL.slice(0, 1), environment(), TOOLS, false);
    expect(commands(quiet)).toEqual([
      [
        'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg',
        'sudo -n apt-get update',
        'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg',
      ],
    ]);

    const noSudo = installPlan(ALL, environment({ sudo: false }), TOOLS, true);
    expect(noSudo?.manual).toEqual([
      'apt-get update',
      'env DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg cmake g++ make python3-venv',
    ]);
    expect(noSudo?.tasks.map((task) => task.summary)).toEqual([
      expect.stringMatching(/^build whisper\.cpp/),
      expect.stringMatching(/^install Piper/),
    ]);
  });

  it("names each package manager's packages", () => {
    const has = () => false;
    const first = (manager: InstallEnvironment['manager']) =>
      commands(
        installPlan(
          ALL,
          environment({ manager, root: true, has }),
          TOOLS,
          true,
        ),
      )[0]!.slice(1);

    expect(first('brew')).toEqual(['brew install ffmpeg whisper-cpp python']);
    expect(first('dnf')).toEqual([
      'dnf install -y ffmpeg-free cmake gcc-c++ make python3',
    ]);
    expect(first('pacman')).toEqual([
      'pacman -S --needed --noconfirm ffmpeg cmake gcc make python',
    ]);
    expect(first('apk')).toEqual(['apk add ffmpeg cmake g++ make python3']);
    // brew has whisper-cpp, so there is nothing to build.
    expect(
      commands(
        installPlan(ALL, environment({ manager: 'brew', has }), TOOLS, true),
      ).map(([summary]) => summary),
    ).toEqual([
      'brew install ffmpeg whisper-cpp python',
      `install Piper ${PIPER_TTS_VERSION} in ${TOOLS}/piper`,
    ]);
  });

  it('has no plan without a package manager it knows, or nothing missing', () => {
    expect(installPlan(ALL, environment({ manager: null }), TOOLS, true)).toBe(
      null,
    );
    expect(installPlan([], environment(), TOOLS, true)).toBe(null);
  });
});

describe('runInstall and localPrograms', () => {
  let workspace: string;
  let tools: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pero-install-programs-'));
    tools = join(workspace, '.pero', 'tools');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** An executable stub at `path`. */
  function stub(path: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o755);
  }

  it('runs each step, downloads, and links what it built into tools/bin', async () => {
    const run = vi.fn<InstallEnvironment['run']>((program, args) => {
      if (program === 'cmake' && args[0] === '--build') {
        stub(join(args[1]!, 'bin', 'whisper-cli'));
      }
      if (program.endsWith('/pip')) stub(join(program, '..', 'piper'));
      return Promise.resolve(null);
    });
    const fetchFile = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('source')),
    );
    const env = environment({ root: true, run, fetch: fetchFile });
    const plan = installPlan(ALL.slice(1), env, tools, true)!;
    const printed: string[] = [];

    await expect(
      runInstall(plan, env, (text) => printed.push(text)),
    ).resolves.toBeNull();

    expect(printed).toEqual(
      plan.tasks.map((task) => `Installing: ${task.summary}`),
    );
    expect(run.mock.calls.map(([program]) => program)).toEqual([
      'apt-get',
      'env',
      'tar',
      'cmake',
      'cmake',
      'python3',
      join(tools, 'piper', 'bin', 'pip'),
    ]);
    expect(
      readFileSync(
        join(tools, `whisper.cpp-${WHISPER_CPP_VERSION}.tar.gz`),
        'utf8',
      ),
    ).toBe('source');
    expect(readlinkSync(join(tools, 'bin', 'piper'))).toBe(
      join(tools, 'piper', 'bin', 'piper'),
    );

    const programs = localPrograms(
      { ffmpeg: 'pero-no-such-ffmpeg', whisper: 'whisper-cli', piper: 'piper' },
      workspace,
    );
    expect(programs).toEqual({
      ffmpeg: 'pero-no-such-ffmpeg',
      whisper: join(tools, 'bin', 'whisper-cli'),
      piper: join(tools, 'bin', 'piper'),
    });
  });

  it('stops at the first step that fails, saying which and why', async () => {
    const run = vi.fn<InstallEnvironment['run']>(() =>
      Promise.resolve('exited with 100'),
    );
    const env = environment({ run });
    const plan = installPlan(ALL, env, tools, true)!;

    await expect(runInstall(plan, env, () => undefined)).resolves.toBe(
      'sudo apt-get update failed: exited with 100',
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(tools)).toBe(false);
  });
});
