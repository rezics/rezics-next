import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { probeJavaRuntime } from '../src/java-runtime.ts';

const posixTest = test.skipIf(process.platform === 'win32');
const tempRoot = join(import.meta.dir, '../../../.temp');
const directories: string[] = [];
const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'aarch64' : process.arch;

async function fixture(script: string, mode = 0o755) {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'java-runtime-'));
  directories.push(directory);
  const file = join(directory, 'java');
  await writeFile(file, `#!/bin/sh\n${script}\n`, { mode });
  return { directory, file };
}

function metadata(version: string, arch = architecture): string {
  return `printf 'Property settings:\\r\\n    java.version = ${version}\\r\\n    os.arch = ${arch}\\r\\n' >&2`;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

posixTest(
  'probes a canonical executable without Java environment overrides and reads modern and legacy versions',
  async () => {
    const modern = await fixture(
      `[ "$#" = 2 ] && [ "$1" = -XshowSettings:properties ] && [ "$2" = -version ] || exit 1\n[ -z "$JAVA_TOOL_OPTIONS" ] || exit 2\n${metadata('21.0.1+12')}`,
    );
    const shortcut = await fixture('');
    await rm(shortcut.file);
    await symlink(modern.file, shortcut.file);
    const previous = process.env.JAVA_TOOL_OPTIONS;
    process.env.JAVA_TOOL_OPTIONS = '-Dos.arch=ia32';
    try {
      expect(await probeJavaRuntime(shortcut.file, { requiredMajor: 21 })).toEqual({
        executable: await realpath(modern.file),
        major: 21,
        architecture: process.arch,
      });
    } finally {
      if (previous === undefined) delete process.env.JAVA_TOOL_OPTIONS;
      else process.env.JAVA_TOOL_OPTIONS = previous;
    }
    const legacy = await fixture(metadata('1.8.0_412'));
    expect((await probeJavaRuntime(legacy.file, { requiredMajor: 8 })).major).toBe(8);
  },
);

posixTest('rejects the wrong executable, missing properties, Java major and JVM architecture', async () => {
  const { directory, file } = await fixture(metadata('17.0.12'));
  const nonExecutable = await fixture(metadata('21.0.1'), 0o644);
  const missing = await fixture("printf 'nothing useful\\n'");
  const wrongArch = await fixture(metadata('21.0.1', process.arch === 'ia32' ? 'aarch64' : 'i686'));
  const wrongName = join(directory, 'different');
  await writeFile(wrongName, '#!/bin/sh\nexit 0', { mode: 0o755 });
  await expect(probeJavaRuntime('java')).rejects.toThrow('Choose a local Java');
  await expect(probeJavaRuntime(wrongName)).rejects.toThrow('Choose a local Java');
  await expect(probeJavaRuntime(nonExecutable.file)).rejects.toThrow('could not be opened');
  await expect(probeJavaRuntime(missing.file)).rejects.toThrow('did not report its version and architecture');
  await expect(probeJavaRuntime(file, { requiredMajor: 21 })).rejects.toThrow('requires Java 21');
  await expect(probeJavaRuntime(wrongArch.file)).rejects.toThrow(`Choose a Java runtime for ${process.arch}`);
});

posixTest('bounds output and time and waits for the cancelled probe process to exit', async () => {
  const large = await fixture("while :; do printf '%01024d\\n' 1; done");
  await expect(probeJavaRuntime(large.file)).rejects.toThrow('too much output');

  const stalled = await fixture('while :; do :; done');
  await expect(probeJavaRuntime(stalled.file, { timeoutMs: 60 })).rejects.toThrow('did not finish');

  const running = await fixture('printf "%s" "$$" > "${0%/*}/pid"\nwhile :; do :; done');
  const controller = new AbortController();
  const outcome = probeJavaRuntime(running.file, { signal: controller.signal, timeoutMs: 2_000 });
  const pidFile = join(running.directory, 'pid');
  const readPid = async () => Number(await readFile(pidFile, 'utf8').catch(() => ''));
  let pid = 0;
  for (let attempt = 0; attempt < 50 && !pid; attempt += 1) {
    pid = await readPid();
    if (!pid) await delay(10);
  }
  controller.abort(new Error('Cancelled test probe.'));
  await expect(outcome).rejects.toThrow('Cancelled test probe.');
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});
