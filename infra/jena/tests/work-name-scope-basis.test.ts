import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

test('native Work name source and adoption basis use bounded actual TDB2 owner turns', () => {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const build = mkdtempSync(join(temporary, 'work-name-scope-basis-native-'));
  const image = /^FROM (\S+) AS module$/m.exec(
    readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'),
  )?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const cache = join(temporary, 'work-name-scope-basis-maven-cache');
  mkdirSync(cache, { recursive: true });
  cpSync(join(root, 'infra/jena/command-module/pom.xml'), join(build, 'pom.xml'));
  cpSync(join(root, 'infra/jena/fuseki-text.ttl'), join(build, 'fuseki-text.ttl'));
  cpSync(join(root, 'infra/jena/command-module/src/main'), join(build, 'src/main'), {
    recursive: true,
  });
  mkdirSync(join(build, 'src/test/java/com/rezics/jena'), { recursive: true });
  for (const name of ['WorkNameScopeBasisTest', 'WorkNameScopeCommandTest', 'SlimCommandTest',
    'TitleControlPolicyTest', 'TitleCandidateCommandTest', 'TitleCandidateParseDepthTest', 'ExternalFixture']) {
    const testPath = `src/test/java/com/rezics/jena/${name}.java`;
    cpSync(join(root, 'infra/jena/command-module', testPath), join(build, testPath));
  }
  // Reuse the command fixture's actual profiles; the fixture class is compiled
  // for its helpers, while only the two owned proof classes are executed.
  cpSync(join(root, 'generated/model'), join(build, 'profiles'), { recursive: true });
  mkdirSync(join(build, 'tmp'));
  try {
    // Compile before issuing the short original lease, so cold Maven work cannot turn it into fixture expiry.
    const compile = spawnSync('docker', ['run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--volume', `${build}:/build`, '--volume', `${cache}:/maven-cache`, '--env', 'MAVEN_CONFIG=/maven-cache',
      '--workdir', '/build', image, 'mvn', '-B', '-ntp', '-Dmaven.repo.local=/maven-cache',
      '-Djava.io.tmpdir=/build/tmp', '-DskipTests', 'test-compile'], { cwd: root, encoding: 'utf8', timeout: 180_000 });
    if (compile.status !== 0) throw new Error(`native title acceptance compile failed:\n${compile.stdout}\n${compile.stderr}`);
    // The candidate proof is issued by actual Account/Access/custody owners, never by this native fixture.
    const authority = spawnSync('bun', ['test', 'services/main/tests/work-title-control.test.ts'],
      { cwd: root, encoding: 'utf8', timeout: 60_000 });
    if (authority.status !== 0) throw new Error(`title acceptance authority fixture failed:\n${authority.stdout}\n${authority.stderr}`);
    console.info(authority.stdout, authority.stderr);
    cpSync(join(root, '.temp/goal/title-acceptance/authenticated-native-fixture.json'),
      join(build, 'authenticated-native-fixture.json'));
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        `${process.getuid!()}:${process.getgid!()}`,
        '--volume',
        `${build}:/build`,
        '--volume',
        `${cache}:/maven-cache`,
        '--env',
        'MAVEN_CONFIG=/maven-cache',
        '--workdir',
        '/build',
        image,
        'mvn',
        '-B',
        '-ntp',
        '-Dmaven.repo.local=/maven-cache',
        '-Djava.io.tmpdir=/build/tmp',
        '-Drezics.title.candidate.fixture=/build/authenticated-native-fixture.json',
        '-DargLine=-Drezics.title.candidate.fixture=/build/authenticated-native-fixture.json',
        '-Dsurefire.runOrder=alphabetical',
        '-Dtest=WorkNameScopeBasisTest,WorkNameScopeCommandTest,TitleControlPolicyTest,TitleCandidateCommandTest,TitleCandidateParseDepthTest',
        'surefire:test',
      ],
      { cwd: root, encoding: 'utf8', timeout: 300_000 },
    );
    if (result.status !== 0)
      throw new Error(
        `native Work scope tests failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    expect(result.stdout).toMatch(/Tests run: \d+, Failures: 0, Errors: 0/);
    expect(result.stdout).toContain('Work scope links=150 dead=100 active=50');
    expect(result.stdout).toContain('Work source aliases=1001 unrelated=2100');
    expect(result.stdout).toContain('Work command cancellation');
    expect(result.stdout).toContain('Work startup production configuration');
    expect(result.stdout).toContain('Work recipe unrelated=4096');
    expect(result.stdout).toContain('Work recipe oversized scalar=8MiB');
    expect(result.stdout).toContain('Work recipe oversized lookahead=1');
    expect(result.stdout).toContain(
      'Work recipe byteBoundary source=262144 copies=262144 total=524288',
    );
    expect(result.stdout).toContain('formatterOracle=exact');
    expect(result.stdout).toContain('privateRecipeDocuments=0 ownerFanout=0');
    for (const line of result.stdout.split('\n'))
      if (/^Work (scope|source|adoption|command|startup|recipe) |Title candidate |Tests run:/.test(line)) console.info(line);
  } finally {
    const produced = join(build, 'target/surefire-reports');
    if (existsSync(produced)) {
      const reports = join(root, '.temp/goal/title-acceptance/native-reports');
      rmSync(reports, { recursive: true, force: true });
      cpSync(produced, reports, { recursive: true });
    }
    rmSync(build, { recursive: true, force: true });
  }
}, 310_000);
