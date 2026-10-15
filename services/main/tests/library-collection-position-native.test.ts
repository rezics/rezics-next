import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';

test('collection export positions have flat native work and follow every owner mutation', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const evidence = join(root, '.temp/personal-authoring-growth', `native-${randomUUID()}`);
  const build = join(evidence, 'build');
  mkdirSync(join(build, 'tmp'), { recursive: true });
  const module = join(root, 'infra/jena/command-module');
  cpSync(join(module, 'pom.xml'), join(build, 'pom.xml'));
  cpSync(join(module, 'src/main'), join(build, 'src/main'), { recursive: true });
  const testPath = 'src/test/java/com/rezics/jena/LibraryCollectionPositionTest.java';
  mkdirSync(join(build, 'src/test/java/com/rezics/jena'), { recursive: true });
  cpSync(join(module, testPath), join(build, testPath));
  const image = /^FROM (\S+) AS module$/m.exec(readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'))?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const cache = join(root, '.temp/library-position-maven-cache');
  mkdirSync(cache, { recursive: true });
  const child = Bun.spawn(['docker', 'run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`,
    '--memory', '1g', '--cpus', '2', '--volume', `${build}:/build`, '--volume', `${cache}:/maven-cache`,
    '--env', 'MAVEN_CONFIG=/maven-cache', '--env', 'MAVEN_OPTS=-Xmx128m',
    '--env', 'JAVA_TOOL_OPTIONS=-XX:+UseSerialGC -XX:ActiveProcessorCount=2 -Djava.io.tmpdir=/build/tmp',
    '--workdir', '/build', image, 'mvn', '-B', '-ntp', '-Dmaven.repo.local=/maven-cache',
    '-DargLine=-Xmx384m', '-Dtest=LibraryCollectionPositionTest', 'test'],
  { cwd: root, env: loadDockerEnvironment(), stdout: 'pipe', stderr: 'pipe', timeout: 300_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  writeFileSync(join(evidence, 'maven.log'), `${stdout}\n${stderr}`);
  expect(code, `Native evidence: ${evidence}/maven.log`).toBe(0);
  expect(stdout).toContain('Tests run: 3, Failures: 0, Errors: 0');
  for (const line of stdout.split('\n')) if (line.startsWith('library collection ')) console.log(line);
}, 310_000);
