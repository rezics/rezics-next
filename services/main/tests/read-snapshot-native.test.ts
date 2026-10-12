import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';

/** Native Jena tests run with the repository's pinned Maven/JDK, through the
 * image-input owner QA slot. The optional corpus probe never starts a service,
 * mounts the stopped backup read-only, and opens only its own /tmp copy. */
test('native retained-read counterexamples and optional qualified-corpus cost probe', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const artifacts = join(root, '.temp', `read-snapshot-${randomUUID()}`);
  const context = join(artifacts, 'build');
  mkdirSync(join(context, 'tmp'), { recursive: true });
  const module = join(root, 'infra/jena/command-module');
  cpSync(join(module, 'pom.xml'), join(context, 'pom.xml'));
  cpSync(join(module, 'src/main'), join(context, 'src/main'), { recursive: true });
  const tests = 'src/test/java/com/rezics/jena';
  mkdirSync(join(context, tests), { recursive: true });
  for (const name of ['ReadSnapshotTest', 'ReadSnapshotProbe']) {
    cpSync(join(module, tests, `${name}.java`), join(context, tests, `${name}.java`));
  }
  const image = /^FROM (\S+) AS module$/m.exec(
    readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'),
  )?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const cache = join(root, '.temp/read-snapshot-maven-cache');
  mkdirSync(cache, { recursive: true });
  const env = loadDockerEnvironment();
  const activeContainers = new Set<string>();
  async function run(args: string[], label: string, timeoutMs = 165_000) {
    const child = Bun.spawn(['docker', ...args], { cwd: root, env,
      stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    writeFileSync(join(artifacts, `${label}.log`), `${stdout}\n${stderr}`);
    expect(code, `${label}: ${join(artifacts, `${label}.log`)}`).toBe(0);
    return stdout;
  }
  async function container(args: string[], label: string, timeoutMs?: number) {
    const name = `read-snapshot-${randomUUID()}`;
    activeContainers.add(name);
    const output = await run(['run', '--rm', '--name', name, ...args], label, timeoutMs);
    activeContainers.delete(name);
    return output;
  }
  try {
    // A focused Maven selection keeps unrelated native owner suites out of this proof.
    // Keep these two counterexamples in a fresh JVM with TDB2 on writable disk.
    const output = await container(['--user', `${process.getuid!()}:${process.getgid!()}`,
      '--memory', '1g', '--cpus', '2', '--volume', `${context}:/build`,
      '--volume', `${cache}:/maven-cache`, '--env', 'MAVEN_CONFIG=/maven-cache',
      '--env', 'MAVEN_OPTS=-Xmx128m',
      '--env', 'JAVA_TOOL_OPTIONS=-XX:+UseSerialGC -XX:ActiveProcessorCount=2 -Djava.io.tmpdir=/build/tmp',
      '--workdir', '/build', image, 'mvn', '-B', '-ntp', '-Dmaven.repo.local=/maven-cache',
      '-DargLine=-Xmx384m', '-Dtest=ReadSnapshotTest', 'test',
      ...(process.env.REZICS_READ_SNAPSHOT_PROBE === '1'
        ? ['dependency:build-classpath', '-Dmdep.outputFile=/build/classpath'] : [])], 'module-tests');
    expect(output).toContain('Tests run: 2, Failures: 0, Errors: 0, Skipped: 0');
    if (process.env.REZICS_READ_SNAPSHOT_PROBE === '1') {
      const volume = 'rezics-fixture-fx-medium-c9f6e4fdcb52_fuseki_data';
      // Fail before opening even the copy if a writer has the fixture mounted.
      const running = await run(['ps', '--filter', `volume=${volume}`, '--format', '{{.ID}}'], 'backup-readiness');
      expect(running.trim()).toBe('');
      await run(['volume', 'inspect', volume, '--format', '{{.Name}}'], 'backup-exists');
      const measurements: unknown[] = [];
      const modes = process.env.REZICS_READ_SNAPSHOT_MODES?.split(',') ?? ['0', '1', '8', '32', '300', 'memory', 'named'];
      expect(modes.every(mode => ['0', '1', '8', '32', '300', 'memory', 'named'].includes(mode))).toBe(true);
      for (const mode of modes) {
        const output = await container(['--network', 'none', '--volume', `${context}:/build`,
          '--volume', `${cache}:/maven-cache:ro`, '--workdir', '/build',
          '--memory', '4g', '--cpus', '2', '--mount', `type=volume,src=${volume},dst=/fixture,readonly`,
          image, 'sh', '-c',
          'exec java -Xms256m -Xmx2g -cp "target/test-classes:target/classes:$(cat classpath)" '
            + 'com.rezics.jena.ReadSnapshotProbe /fixture/rezics/tdb2 /tmp/probe "$1"',
          'probe', mode], `probe-${mode}`, 600_000);
        const records = output.split('\n').filter(line => line.startsWith('READ_SNAPSHOT_PROBE '))
          .map(line => JSON.parse(line.slice('READ_SNAPSHOT_PROBE '.length)) as Record<string, unknown>);
        expect(records).toHaveLength(2);
        measurements.push(...records.map(record => ({ mode, ...record })));
        writeFileSync(join(artifacts, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
      }
    }
  } finally {
    for (const name of activeContainers) {
      await Bun.spawn(['docker', 'rm', '-f', name], { env, stdout: 'ignore', stderr: 'ignore', timeout: 10_000 }).exited;
    }
    console.log(`Native retained-read evidence: ${artifacts}`);
  }
}, process.env.REZICS_READ_SNAPSHOT_PROBE === '1' ? 1_200_000 : 175_000);
