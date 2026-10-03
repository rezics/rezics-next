import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadDockerEnvironment } from './docker-env.ts';
import { fusekiImageFromCompose } from './image.ts';
import { fusekiCandidateCounts, type CapturedFusekiQuery } from './fuseki-candidates.ts';

const root = resolve(import.meta.dir, '../..');
export interface FusekiPlan {
  queryFile: string;
  planFile: string;
  queryDigest: string;
  bytes: number;
  basis: 'ARQ optimized algebra; not runtime TDB2/Lucene operator work';
}

/** Run the pinned image offline, with no live TDB2 mount or extra server.
 * Raw queries/plans belong only in explicit local diagnostic artifacts. */
export function captureFusekiPlan(
  sparql: string,
  options: {
    label: string;
    directory?: string;
    image?: { image: string; jenaVersion: string };
    dockerEnv?: NodeJS.ProcessEnv;
    run?: (command: string[]) => { status: number | null; stdout: string; stderr: string };
  },
): FusekiPlan {
  if (
    !/^[a-z][a-z0-9-]{0,60}$/.test(options.label) ||
    !sparql.trim() ||
    Buffer.byteLength(sparql) > 1_048_576
  )
    throw new Error('Invalid Fuseki plan input');
  const directory = resolve(options.directory ?? join(root, '.temp/work-profiles/plans'));
  const local = relative(root, directory);
  if (local.startsWith('..') && directory !== '/tmp' && !directory.startsWith('/tmp/'))
    throw new Error('Plan artifacts must stay in this checkout or /tmp');
  mkdirSync(directory, { recursive: true });
  const image =
    options.image ??
    fusekiImageFromCompose(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8'));
  const queryDigest = createHash('sha256').update(sparql).digest('hex');
  const stem = `${options.label}-${queryDigest.slice(0, 12)}`;
  const queryFile = `${stem}.sparql`,
    planFile = `${stem}.plan.txt`;
  writeFileSync(join(directory, queryFile), sparql + '\n');
  const command = [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--volume',
    `${directory}:/artifacts:ro,Z`,
    '--entrypoint',
    'java',
    image.image,
    '-cp',
    `/opt/apache-jena-fuseki-${image.jenaVersion}/fuseki-server.jar`,
    'arq.qparse',
    '--explain',
    '--query',
    `/artifacts/${queryFile}`,
  ];
  const result = options.run
    ? options.run(command)
    : spawnSync(command[0]!, command.slice(1), {
        cwd: root,
        env: options.dockerEnv ?? loadDockerEnvironment(),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4_194_304,
      });
  writeFileSync(join(directory, planFile), result.stdout + result.stderr);
  if (result.status !== 0 || !result.stdout.trim())
    throw new Error(`Fuseki plan failed; inspect ${planFile}`);
  return {
    queryFile,
    planFile,
    queryDigest,
    bytes: Buffer.byteLength(result.stdout),
    basis: 'ARQ optimized algebra; not runtime TDB2/Lucene operator work',
  };
}

/** Pair the exact captured request with its result, without replaying a potentially moved snapshot. */
export function captureFusekiQueryPlan(
  captured: CapturedFusekiQuery,
  options: Parameters<typeof captureFusekiPlan>[1] & { candidateVariable?: string },
) {
  const plan = captureFusekiPlan(captured.sparql, options);
  const candidates = fusekiCandidateCounts(captured.result, options.candidateVariable);
  const countsFile = plan.planFile.replace(/\.plan\.txt$/, '.counts.json');
  const directory = resolve(options.directory ?? join(root, '.temp/work-profiles/plans'));
  writeFileSync(
    join(directory, countsFile),
    JSON.stringify({ queryDigest: plan.queryDigest, candidates }, null, 2) + '\n',
  );
  return { ...plan, candidates, countsFile };
}
