import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const name = 'WorkStructurePublicationGuardTest';

function attributes(element: string): Record<string, string> {
  return Object.fromEntries(
    [...element.matchAll(/([\w.-]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]),
  );
}

test('Work Structure publication preserves fixed owner, rights and receipt bindings', () => {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const build = mkdtempSync(join(temporary, 'work-structure-publication-'));
  const evidenceBase = join(temporary, 'goal/work-structure-publication/evidence');
  mkdirSync(evidenceBase, { recursive: true });
  const evidence = mkdtempSync(join(evidenceBase, 'run-'));
  console.info(`Work Structure publication evidence: ${evidence}`);
  writeFileSync(join(evidence, 'owner-wrapper.ts'), readFileSync(import.meta.path));
  const dockerfile = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8');
  const image = /^FROM (\S+) AS module$/m.exec(dockerfile)?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const cache = join(temporary, 'semantic-source-readiness-maven-cache');
  mkdirSync(cache, { recursive: true });
  try {
    // Match the existing focused startup adapter's COPY inputs and memory bounds.
    const moduleStage = dockerfile.split(/\nFROM /, 1)[0]!;
    for (const line of moduleStage.split('\n')) {
      if (!/^COPY\s/.test(line)) continue;
      const copy = /^COPY (\S+) (\/build\/\S+)$/.exec(line);
      if (!copy) throw new Error(`unsupported native module COPY: ${line}`);
      const destination = join(build, copy[2]!.slice('/build/'.length));
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, copy[1]!), destination, { recursive: true });
    }
    const hashes: Record<string, string> = {};
    const capture = (directory: string) => {
      for (const entry of readdirSync(join(build, directory), { withFileTypes: true })) {
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) capture(path);
        else hashes[path] = createHash('sha256').update(readFileSync(join(build, path))).digest('hex');
      }
    };
    capture('');
    writeFileSync(join(evidence, 'input-identity.json'), `${JSON.stringify({
      sourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      sourceStatus: spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      dockerfile, hashes,
    }, null, 2)}\n`);
    const source = readFileSync(join(build, `src/test/java/com/rezics/jena/${name}.java`), 'utf8');
    const methods = [...source.matchAll(/@Test(?:\s*\([^)]*\))?\s+public\s+void\s+(\w+)\s*\(/g)]
      .map((match) => match[1]!).sort();
    expect(methods.length).toBeGreaterThan(0);
    writeFileSync(join(evidence, 'discovered-methods.json'), `${JSON.stringify(methods, null, 2)}\n`);
    mkdirSync(join(build, 'tmp'));
    const args = [
      'run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--memory', '1536m', '--memory-swap', '1536m', '--pids-limit', '256',
      '--volume', `${build}:/build`, '--volume', `${cache}:/maven-cache`,
      '--env', 'MAVEN_CONFIG=/maven-cache', '--env', 'MAVEN_OPTS=-Xmx128m',
      '--env', 'JAVA_TOOL_OPTIONS=-XX:+UseSerialGC -XX:ActiveProcessorCount=4',
      '--workdir', '/build', image, 'mvn', '-B', '-ntp', '-Dmaven.repo.local=/maven-cache',
      '-Djava.io.tmpdir=/build/tmp', '-DargLine=-Xmx384m', '-DforkCount=1', '-DreuseForks=false',
      `-Dtest=${name}`, 'test',
    ];
    writeFileSync(join(evidence, 'invocation.json'), `${JSON.stringify(args, null, 2)}\n`);
    const result = spawnSync('docker', args,
      { cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 8_388_608 });
    writeFileSync(join(evidence, 'maven.stdout'), result.stdout ?? '');
    writeFileSync(join(evidence, 'maven.stderr'), result.stderr ?? '');
    writeFileSync(join(evidence, 'process-result.json'), `${JSON.stringify({
      status: result.status, signal: result.signal, error: result.error?.message,
    }, null, 2)}\n`);
    if (result.status !== 0)
      throw new Error(`native Work Structure publication test failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    const reports = join(build, `target/surefire-reports/TEST-com.rezics.jena.${name}.xml`);
    expect(existsSync(reports)).toBe(true);
    const xml = readFileSync(reports, 'utf8');
    const suite = attributes(/<testsuite\b[^>]*>/.exec(xml)![0]);
    expect(suite.name).toBe(`com.rezics.jena.${name}`);
    expect([suite.failures, suite.errors, suite.skipped]).toEqual(['0', '0', '0']);
    const cases = [...xml.matchAll(/<testcase\b[^>]*>/g)].map((match) => attributes(match[0]).name!);
    expect(cases.sort()).toEqual(methods);
    expect(Number(suite.tests)).toBe(methods.length);
  } finally {
    const reports = join(build, 'target/surefire-reports');
    if (existsSync(reports)) cpSync(reports, join(evidence, 'surefire-reports'), { recursive: true });
    rmSync(build, { recursive: true, force: true });
  }
}, 610_000);
