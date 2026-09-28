import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';

/** Native Jena tests run with the repository's pinned Maven/JDK, through the
 * ordinary goalctl QA slot. The optional corpus probe never starts a service,
 * mounts the stopped backup read-only, and opens only its own /tmp copy. */
test('G336 native retained-read counterexamples and optional qualified-corpus cost probe', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const artifacts = join(root, '.temp', `read-snapshot-${randomUUID()}`);
  const context = join(artifacts, 'build');
  mkdirSync(context, { recursive: true });
  const module = join(root, 'infra/jena/command-module');
  cpSync(join(module, 'pom.xml'), join(context, 'pom.xml'));
  cpSync(join(module, 'src'), join(context, 'src'), { recursive: true });
  const base = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8').split('\n')[0]!
    .replace(/ AS module$/, '');
  writeFileSync(join(context, 'Dockerfile'), `${base}
WORKDIR /build
COPY pom.xml .
RUN mvn -B -ntp dependency:go-offline
COPY src src
RUN mvn -B -ntp package
RUN mvn -B -ntp dependency:build-classpath -Dmdep.outputFile=/build/classpath
`);
  const env = loadDockerEnvironment();
  const image = `rezics/read-snapshot-probe:${randomUUID()}`;
  const activeContainers = new Set<string>();
  async function run(args: string[], label: string, timeoutMs = 600_000) {
    const child = Bun.spawn(['docker', ...args], { cwd: root, env,
      stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    writeFileSync(join(artifacts, `${label}.log`), `${stdout}\n${stderr}`);
    expect(code, `${label}: ${join(artifacts, `${label}.log`)}`).toBe(0);
    return stdout;
  }
  try {
    await run(['build', '--tag', image, context], 'module-tests');
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
        const name = `read-snapshot-${randomUUID()}`;
        activeContainers.add(name);
        const output = await run(['run', '--rm', '--name', name, '--network', 'none',
          '--memory', '4g', '--cpus', '2', '--mount', `type=volume,src=${volume},dst=/fixture,readonly`,
          image, 'sh', '-c',
          'exec java -Xms256m -Xmx2g -cp "target/test-classes:target/classes:$(cat classpath)" '
            + 'com.rezics.jena.ReadSnapshotProbe /fixture/rezics/tdb2 /tmp/probe "$1"',
          'probe', mode], `probe-${mode}`);
        activeContainers.delete(name);
        const records = output.split('\n').filter(line => line.startsWith('READ_SNAPSHOT_PROBE '))
          .map(line => JSON.parse(line.slice('READ_SNAPSHOT_PROBE '.length)) as Record<string, unknown>);
        expect(records).toHaveLength(2);
        measurements.push(...records.map(record => ({ mode, ...record })));
        writeFileSync(join(artifacts, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
      }
    }
  } finally {
    for (const name of activeContainers) {
      await Bun.spawn(['docker', 'rm', '-f', name], { env, stdout: 'ignore', stderr: 'ignore' }).exited;
    }
    await Bun.spawn(['docker', 'image', 'rm', image], { env, stdout: 'ignore', stderr: 'ignore' }).exited;
    console.log(`G336 native evidence: ${artifacts}`);
  }
}, 1_200_000);
