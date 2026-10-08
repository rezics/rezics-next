import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const name = 'CommandModuleStartupTest';

function attributes(element: string): Record<string, string> {
  return Object.fromEntries(
    [...element.matchAll(/([\w.-]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]),
  );
}

// Focused native run of the startup callback on an in-memory TDB2/Lucene fixture, in the same builder image,
// build inputs and memory bounds as the accepted native union. It adds no class to that union's list.
test('restore holds of any value start for inspection and never mint Source qualification', () => {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const build = mkdtempSync(join(temporary, 'command-module-startup-'));
  const dockerfile = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8');
  const image = /^FROM (\S+) AS module$/m.exec(dockerfile)?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const cache = join(temporary, 'semantic-source-readiness-maven-cache');
  mkdirSync(cache, { recursive: true });
  try {
    // Exact module-stage build inputs; refuse COPY syntax this copy cannot reproduce.
    const moduleStage = dockerfile.split(/\nFROM /, 1)[0]!;
    for (const line of moduleStage.split('\n')) {
      if (!/^COPY\s/.test(line)) continue;
      const copy = /^COPY (\S+) (\/build\/\S+)$/.exec(line);
      if (!copy) throw new Error(`unsupported native module COPY: ${line}`);
      const destination = join(build, copy[2]!.slice('/build/'.length));
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, copy[1]!), destination, { recursive: true });
    }
    const source = readFileSync(join(build, `src/test/java/com/rezics/jena/${name}.java`), 'utf8');
    const methods = [
      ...source.matchAll(/@Test(?:\s*\([^)]*\))?\s+public\s+void\s+(\w+)\s*\(/g),
    ]
      .map((match) => match[1]!)
      .sort();
    expect(methods.length).toBeGreaterThan(0);
    mkdirSync(join(build, 'tmp'));
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        `${process.getuid!()}:${process.getgid!()}`,
        '--memory',
        '1536m',
        '--memory-swap',
        '1536m',
        '--pids-limit',
        '256',
        '--volume',
        `${build}:/build`,
        '--volume',
        `${cache}:/maven-cache`,
        '--env',
        'MAVEN_CONFIG=/maven-cache',
        '--env',
        'MAVEN_OPTS=-Xmx128m',
        '--env',
        'JAVA_TOOL_OPTIONS=-XX:+UseSerialGC -XX:ActiveProcessorCount=4',
        '--workdir',
        '/build',
        image,
        'mvn',
        '-B',
        '-ntp',
        '-Dmaven.repo.local=/maven-cache',
        '-Djava.io.tmpdir=/build/tmp',
        '-DargLine=-Xmx384m',
        '-DforkCount=1',
        '-DreuseForks=false',
        `-Dtest=${name}`,
        'test',
      ],
      { cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 8_388_608 },
    );
    if (result.status !== 0)
      throw new Error(
        `native startup test failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
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
    rmSync(build, { recursive: true, force: true });
  }
}, 610_000);
