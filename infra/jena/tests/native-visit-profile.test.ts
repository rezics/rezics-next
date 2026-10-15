import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

test('native Realm seeks retain exact visit counters through query HTTP headers', () => {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const build = mkdtempSync(join(temporary, 'native-visit-profile-'));
  const image = /^FROM (\S+) AS module$/m.exec(
    readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'),
  )?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const cache = join(temporary, 'native-visit-profile-maven-cache');
  mkdirSync(cache, { recursive: true });
  cpSync(join(root, 'infra/jena/command-module/pom.xml'), join(build, 'pom.xml'));
  cpSync(join(root, 'infra/jena/command-module/src/main'), join(build, 'src/main'), { recursive: true });
  cpSync(join(root, 'generated/model'), join(build, 'profiles'), { recursive: true });
  mkdirSync(join(build, 'src/test/java/com/rezics/jena'), { recursive: true });
  cpSync(join(root, 'infra/jena/command-module/src/test/java/com/rezics/jena/RealmSearchSeekTest.java'),
    join(build, 'src/test/java/com/rezics/jena/RealmSearchSeekTest.java'));
  for (const file of ['CatalogueRankIteratorWorkTest.java', 'CachedTitleRankTest.java', 'RankedSnapshotTest.java'])
    cpSync(join(root, 'infra/jena/command-module/src/test/java/com/rezics/jena', file),
      join(build, 'src/test/java/com/rezics/jena', file));
  mkdirSync(join(build, 'tmp'));
  try {
    const result = spawnSync('docker', [
      'run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--volume', `${build}:/build`, '--volume', `${cache}:/maven-cache`,
      '--env', 'MAVEN_CONFIG=/maven-cache', '--env', 'MAVEN_OPTS=-Xmx128m',
      '--env', 'JAVA_TOOL_OPTIONS=-XX:+UseSerialGC -XX:ActiveProcessorCount=4 -Djava.io.tmpdir=/build/tmp',
      '--workdir', '/build', image,
      'mvn', '-B', '-ntp', '-DexcludedGroups=com.rezics.jena.ExternalFixture',
      '-DargLine=-Xmx384m', '-DforkCount=1', '-DreuseForks=false',
      '-Dmaven.repo.local=/maven-cache', '-Djava.io.tmpdir=/build/tmp',
      '-Dtest=RealmSearchSeekTest,CatalogueRankIteratorWorkTest,CachedTitleRankTest,RankedSnapshotTest', 'package',
    ], { cwd: root, encoding: 'utf8', timeout: 300_000 });
    if (result.status !== 0)
      throw new Error(`native visit tests failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    expect(result.stdout).toMatch(/Tests run: [1-9][0-9]*, Failures: 0, Errors: 0/);
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}, 310_000);
