import { test, expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { readingWorkScope } from '../src/modules/reading-position/work-scope.ts';

test('G1022: native transactional label directory passes folding, mutation, recovery and scale cases', async () => {
  const root = resolve(import.meta.dir, '../../..'), output = resolve(root, '.temp/g-1022-native');
  mkdirSync(output, { recursive: true });
  // The native work-cost probe executes the production scope expression.
  const scope = JSON.parse(readFileSync(resolve(root,
    'infra/jena/command-module/src/test/resources/g1022-reading-scope.json'), 'utf8')) as { root: string; where: string };
  expect(scope.where).toBe(readingWorkScope(scope.root));
  const image = readFileSync(resolve(root, 'infra/jena/Dockerfile'), 'utf8').match(/^FROM (maven:\S+) AS module$/m)![1]!;
  const run = Bun.spawn(['docker', 'run', '--rm', '-v', `${root}/infra/jena/command-module:/source:ro`,
    '-v', `${output}:/work`, '-v', `${root}/generated/model:/profiles:ro`, '-w', '/work', image,
    'sh', '-ec', 'cp /source/pom.xml /work/pom.xml; cp -r /source/src /work/; mvn -B -ntp -Dmaven.repo.local=/work/m2 -Dtest=g1022OccurrenceLabelsTest test'],
  { env: loadDockerEnvironment(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  const status = await run.exited;
  writeFileSync(resolve(output, 'check.log'), stdout + stderr);
  console.log(status === 0 ? stdout.split('\n').filter(line => line.startsWith('G1022') || line.includes('Tests run:')).join('\n') : (stdout + stderr).slice(-6000));
  expect(status, stderr).toBe(0);
}, 600_000);
