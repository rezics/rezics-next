import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

test('offline erasure campaign native TDB2 and direct Lucene counterexamples', () => {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const build = mkdtempSync(join(temporary, 'erasure-campaign-native-'));
  // Reuse this release's builder pin; this test never opens a shared graph or builds a runtime image.
  const image = /^FROM (\S+) AS module$/m.exec(
    readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'),
  )?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const cache = join(temporary, 'erasure-campaign-maven-cache');
  mkdirSync(cache, { recursive: true });
  cpSync(join(root, 'infra/jena/command-module/pom.xml'), join(build, 'pom.xml'));
  cpSync(join(root, 'infra/jena/command-module/src/main'), join(build, 'src/main'), {
    recursive: true,
  });
  cpSync(
    join(root, 'infra/jena/command-module/src/test/resources'),
    join(build, 'src/test/resources'),
    {
      recursive: true,
    },
  );
  cpSync(join(root, 'generated/model'), join(build, 'profiles'), { recursive: true });
  mkdirSync(join(build, 'src/test/java/com/rezics/jena'), { recursive: true });
  for (const name of ['ErasurePurgeCampaignTest', 'PersonProfileErasurePolicyTest', 'PersonProfileErasurePurgeTest']) {
    cpSync(join(root, `infra/jena/command-module/src/test/java/com/rezics/jena/${name}.java`),
      join(build, `src/test/java/com/rezics/jena/${name}.java`));
  }
  cpSync(
    join(
      root,
      'infra/jena/command-module/src/test/java/com/rezics/jena/ModelMutationPolicyTest.java',
    ),
    join(build, 'src/test/java/com/rezics/jena/ModelMutationPolicyTest.java'),
  );
  mkdirSync(join(build, 'tmp'));
  try {
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
        '-Dtest=ErasurePurgeCampaignTest,ModelMutationPolicyTest,PersonProfileErasurePolicyTest,PersonProfileErasurePurgeTest',
        'test',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 300_000,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `native campaign tests failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    // The classes grow with each purge counterexample; what matters is that it ran and passed.
    for (const name of ['ErasurePurgeCampaignTest', 'ModelMutationPolicyTest', 'PersonProfileErasurePolicyTest', 'PersonProfileErasurePurgeTest']) {
      const report = readFileSync(join(build, `target/surefire-reports/TEST-com.rezics.jena.${name}.xml`), 'utf8');
      expect(report).toMatch(/<testsuite\b[^>]*tests="[1-9][0-9]*"/);
      expect(report).toMatch(/<testsuite\b[^>]*errors="0"/);
      expect(report).toMatch(/<testsuite\b[^>]*failures="0"/);
    }
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}, 310_000);
