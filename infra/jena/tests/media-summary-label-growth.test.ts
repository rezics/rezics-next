import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resourceSummaryGraphQuery } from '../../../services/main/src/modules/media/summary.ts';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';

const root = resolve(import.meta.dir, '../../..');
const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('summary label UNION inputs have flat native work under unrelated population growth', () => {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const build = mkdtempSync(join(temporary, 'summary-label-native-'));
  const evidenceBase = join(temporary, 'goal/summary-label-growth');
  mkdirSync(evidenceBase, { recursive: true });
  const evidence = mkdtempSync(join(evidenceBase, 'run-'));
  const image = /^FROM (\S+) AS module$/m.exec(readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'))?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const bounded = resourceSummaryGraphQuery([id(1)]);
  const start = bounded.indexOf('OPTIONAL { FILTER(?type IN ("agent","zone"))');
  const end = bounded.indexOf('OPTIONAL { FILTER(?type = "agent")', start);
  const labels = bounded.slice(start, end);
  expect(labels.match(/VALUES \?r \{/g)).toHaveLength(2);
  // Counterfactual is the original production query: remove only these two
  // new inputs, retaining every type, visibility and publication predicate.
  const baseline = bounded.slice(0, start) + labels.replace(/VALUES \?r \{[^}]*\} /g, '') + bounded.slice(end);
  const queries = { bounded, baseline,
    semantics: resourceSummaryGraphQuery([1, 10, 11, 12, 13, 20, 21, 22].map(id)) };
  const cache = join(temporary, 'summary-label-maven-cache');
  mkdirSync(cache, { recursive: true });
  cpSync(join(root, 'infra/jena/command-module/pom.xml'), join(build, 'pom.xml'));
  const java = 'src/test/java/com/rezics/jena/MediaSummaryLabelGrowthTest.java';
  mkdirSync(join(build, 'src/test/java/com/rezics/jena'), { recursive: true });
  cpSync(join(root, 'infra/jena/command-module', java), join(build, java));
  mkdirSync(join(build, 'tmp'));
  for (const [name, query] of Object.entries(queries)) {
    writeFileSync(join(build, `summary-${name}.rq`), query);
    writeFileSync(join(evidence, `summary-${name}.rq`), query);
  }
  writeFileSync(join(evidence, 'queries.json'), JSON.stringify({ image,
    queries: Object.fromEntries(Object.entries(queries).map(([name, query]) =>
      [name, createHash('sha256').update(query).digest('hex')])) }, null, 2));
  try {
    const result = spawnSync('docker', [
      'run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--volume', `${build}:/build`, '--volume', `${cache}:/maven-cache`,
      '--env', 'MAVEN_CONFIG=/maven-cache', '--env', 'MAVEN_OPTS=-Xmx128m',
      '--env', 'JAVA_TOOL_OPTIONS=-XX:+UseSerialGC -XX:ActiveProcessorCount=4 -Djava.io.tmpdir=/build/tmp',
      '--workdir', '/build', image, 'mvn', '-B', '-ntp', '-Dmaven.repo.local=/maven-cache',
      '-Djava.io.tmpdir=/build/tmp', '-DargLine=-Xmx384m', '-DforkCount=1', '-DreuseForks=false',
      '-Dtest=MediaSummaryLabelGrowthTest', 'test',
    ], { cwd: root, env: preserveReapEnvironment(process.env), encoding: 'utf8', timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(evidence, 'maven.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    if (result.status !== 0) throw new Error(`native summary growth failed (${result.status}); see ${evidence}/maven.log`);
    expect(result.stdout).toMatch(/Tests run: [1-9][0-9]*, Failures: 0, Errors: 0/);
    for (const line of result.stdout.split('\n')) if (line.startsWith('summary labels ')) console.info(line);
  } finally {
    for (const name of ['target/surefire-reports', 'summary-bounded.algebra', 'summary-baseline.algebra']) {
      if (existsSync(join(build, name))) cpSync(join(build, name), join(evidence, name.split('/').at(-1)!), { recursive: true });
    }
    rmSync(build, { recursive: true, force: true });
  }
}, 310_000);
