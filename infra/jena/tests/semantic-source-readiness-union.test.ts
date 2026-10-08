import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const classes = [
  'WorkNameScopeBasisTest',
  'WorkNameScopeCommandTest',
  'SemanticSourceBasisTest',
  'ClaimFoldInventoryCommandTest',
  'ClaimFoldInventoryTest',
  'ClaimStatementFoldTest',
  'SearchDeltaJournalTest',
  'TextEntityDocumentsTest',
  'MembershipSeekTest',
  'MetadataRestoreTest',
  'ErasureRestorePolicyTest',
  'ErasurePurgeCampaignTest',
  'RealmSearchSeekTest',
  'StatementPublicationMembershipTest',
  'ModelMutationPolicyTest',
  'CommitProofRetirementTest',
] as const;

function attributes(element: string): Record<string, string> {
  return Object.fromEntries(
    [...element.matchAll(/([\w.-]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]),
  );
}

test('accepted semantic source prerequisites share one native TDB2 owner runtime', () => {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const build = mkdtempSync(join(temporary, 'semantic-source-readiness-native-'));
  const evidenceBase = join(temporary, 'goal/native-accepted-union/evidence');
  mkdirSync(evidenceBase, { recursive: true });
  const evidence = mkdtempSync(join(evidenceBase, 'run-'));
  const dockerfile = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8');
  const image = /^FROM (\S+) AS module$/m.exec(dockerfile)?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const moduleStage = dockerfile.split(/\nFROM /, 1)[0]!;
  const nativeEnvironment = ['MAVEN_OPTS', 'JAVA_TOOL_OPTIONS'].map((name) => {
    const declaration = new RegExp(`^ENV ${name}="([^"\\n]*)"$`, 'm').exec(moduleStage);
    if (!declaration) throw new Error(`missing native builder ${name}`);
    return `${name}=${declaration[1]!}`;
  });
  const packageInvocation = /^RUN --mount=type=cache,id=rezics-native-test-files,target=\/build\/tmp,sharing=locked mvn (.+) package$/m.exec(moduleStage)?.[1];
  if (!packageInvocation || !packageInvocation.split(' ').every((argument) => /^-[^\s"'`]+$/.test(argument)))
    throw new Error('unsupported native builder Maven invocation');
  const mavenArguments = packageInvocation.split(' ');
  const cache = join(temporary, 'semantic-source-readiness-maven-cache');
  mkdirSync(cache, { recursive: true });

  try {
    // Use the exact image build inputs, including startup configuration and query
    // fixtures. Refuse new COPY syntax instead of silently diverging from Docker.
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
        else
          hashes[path] = createHash('sha256')
            .update(readFileSync(join(build, path)))
            .digest('hex');
      }
    };
    capture('');
    writeFileSync(
      join(evidence, 'tested-source-hashes.json'),
      `${JSON.stringify(hashes, null, 2)}\n`,
    );
    const methods = Object.fromEntries(
      classes.map((name) => {
        const source = readFileSync(
          join(build, `src/test/java/com/rezics/jena/${name}.java`),
          'utf8',
        );
        const names = [...source.matchAll(/@Test(?:\s*\([^)]*\))?\s+public\s+void\s+(\w+)\s*\(/g)]
          .map((match) => match[1]!)
          .sort();
        if (names.length === 0) throw new Error(`no original test methods found in ${name}`);
        return [name, names];
      }),
    );
    writeFileSync(
      join(evidence, 'original-test-methods.json'),
      `${JSON.stringify(methods, null, 2)}\n`,
    );
    mkdirSync(join(build, 'tmp'));
    const available = Number(
      /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1],
    );
    if (!Number.isFinite(available) || available < 12 * 1024 * 1024)
      throw new Error('native union requires the host 12 GiB available memory floor');

    const arguments_ = [
      'run',
      '--rm',
      '--user',
      `${process.getuid!()}:${process.getgid!()}`,
      // The unchanged self-fork fixtures overlap Maven, parent and child JVMs.
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
      ...nativeEnvironment.flatMap((declaration) => ['--env', declaration]),
      '--workdir',
      '/build',
      image,
      'mvn',
      ...mavenArguments,
      '-Dmaven.repo.local=/maven-cache',
      `-Dtest=${classes.join(',')}`,
      'test',
    ];
    writeFileSync(
      join(evidence, 'invocation.json'),
      `${JSON.stringify({ image, availableKiB: available, arguments: arguments_ }, null, 2)}\n`,
    );
    // Keep Surefire's normal subprocess classpath: the original body crash proof
    // starts a fresh JVM using surefire.test.class.path inside this same build.
    const result = spawnSync('docker', arguments_, {
      cwd: root,
      encoding: 'utf8',
      // Fourteen sequential original classes share one Maven invocation; this
      // aggregate allowance leaves each owner's native turn budgets unchanged.
      timeout: 900_000,
      maxBuffer: 8_388_608,
    });
    writeFileSync(join(evidence, 'native-test.stdout'), result.stdout ?? '');
    writeFileSync(join(evidence, 'native-test.stderr'), result.stderr ?? '');
    writeFileSync(
      join(evidence, 'process-result.json'),
      `${JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }, null, 2)}\n`,
    );
    const reports = join(build, 'target/surefire-reports');
    if (existsSync(reports))
      cpSync(reports, join(evidence, 'surefire-reports'), { recursive: true });
    console.info(`Native source readiness evidence: ${evidence}`);
    if (result.status !== 0)
      throw new Error(
        `native union failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
      );

    const counts: Record<string, number> = {};
    for (const name of classes) {
      const xml = readFileSync(
        join(evidence, `surefire-reports/TEST-com.rezics.jena.${name}.xml`),
        'utf8',
      );
      const suiteElement = /<testsuite\b[^>]*>/.exec(xml)?.[0];
      if (!suiteElement) throw new Error(`missing actual Surefire suite for ${name}`);
      const suite = attributes(suiteElement);
      expect(suite.name).toBe(`com.rezics.jena.${name}`);
      expect(Number(suite.failures)).toBe(0);
      expect(Number(suite.errors)).toBe(0);
      expect(Number(suite.skipped)).toBe(0);
      const cases = [...xml.matchAll(/<testcase\b[^>]*>/g)].map((match) => attributes(match[0]));
      expect(cases.map((item) => item.name!).sort()).toEqual(methods[name]);
      expect(cases.every((item) => item.classname === `com.rezics.jena.${name}`)).toBe(true);
      counts[name] = Number(suite.tests);
      expect(counts[name]).toBe(cases.length);
    }
    const authored = Object.values(methods).reduce((total, names) => total + names.length, 0);
    const observed = Object.values(counts).reduce((total, count) => total + count, 0);
    expect(observed).toBe(authored);
    writeFileSync(
      join(evidence, 'actual-xml-counts.json'),
      `${JSON.stringify({ classes: counts, tests: observed, failures: 0, errors: 0, skipped: 0 }, null, 2)}\n`,
    );
    console.info(
      `Native source readiness actual XML: ${observed} tests in ${classes.length} classes; failures=0 errors=0 skipped=0`,
    );
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}, 910_000);
