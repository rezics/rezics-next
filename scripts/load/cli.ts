import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEnv } from '../dev/config.ts';
import { PRACTICAL_PROFILE_TIMEOUT_MS } from './budget.ts';
import { loadCompatibility, preparedLoadSourceMode } from './compatibility.ts';
import { fusekiImageFromCompose } from './image.ts';
import { validateLoadBaseline } from './baseline.ts';

const root = resolve(import.meta.dir, '../..');
function dockerEnvironment() {
  const socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, 'podman/podman.sock');
  return { ...process.env,
    ...(!process.env.DOCKER_HOST || process.env.DOCKER_HOST.includes('/.docker/desktop/')
      ? existsSync(socket) ? { DOCKER_HOST: `unix://${socket}` } : {} : {}) };
}
function command(cwd: string, name: string, args: string[], timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env) {
  const started = Date.now();
  const result = spawnSync(name, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs });
  return { ok: result.status === 0 && !result.error,
    output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'),
    elapsedMs: Date.now() - started };
}
function newRunId() {
  return `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()}-${randomBytes(3).toString('hex')}`;
}
function sourceIdentity(cwd: string) {
  const head = command(cwd, 'git', ['rev-parse', 'HEAD'], 5_000);
  const status = command(cwd, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], 5_000);
  const diff = command(cwd, 'git', ['diff', '--binary', 'HEAD'], 10_000);
  if (!head.ok || !status.ok || !diff.ok) throw new Error('Cannot identify load source tree');
  const hash = createHash('sha256').update(head.output).update(diff.output);
  for (const line of status.output.split('\n').filter(Boolean)) {
    const path = line.slice(3);
    if (line.startsWith('??') && existsSync(join(cwd, path)))
      hash.update(path).update(readFileSync(join(cwd, path)));
  }
  return { head: head.output.trim(), fingerprint: hash.digest('hex'), clean: !status.output.trim() };
}
const args = process.argv.slice(2);
let works = 10_000, duration = 180, seedWorkers = 1, keep = false, prepare = false;
let allowCompatibleSource = false;
let from: string | undefined, cohort: number | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--prepare') prepare = true;
  else if (args[i] === '--allow-compatible-source') allowCompatibleSource = true;
  else if (args[i] === '--works' && /^\d+$/.test(args[i + 1] ?? '')) works = Number(args[++i]);
  else if (args[i] === '--duration' && /^\d+$/.test(args[i + 1] ?? '')) duration = Number(args[++i]);
  else if (args[i] === '--seed-workers' && /^\d+$/.test(args[i + 1] ?? ''))
    seedWorkers = Number(args[++i]);
  else if (args[i] === '--keep') keep = true;
  else if (args[i] === '--from' && /^load-[a-z0-9-]{1,30}$/.test(args[i + 1] ?? '')) from = args[++i];
  else if (args[i] === '--cohort' && /^\d+$/.test(args[i + 1] ?? '')) cohort = Number(args[++i]);
  else throw new Error(`Invalid load option: ${args[i]}`);
}
if (!Number.isInteger(works) || works < 10 || works > 10_000
  || !Number.isInteger(duration) || duration < 10 || duration > 180
  || !Number.isInteger(seedWorkers) || seedWorkers < 1 || seedWorkers > 4)
  throw new Error('load options require 10–10000 Works, 10–180 seconds and 1–4 seed workers');
if (prepare && (works > 9_990 || from || cohort || keep)
  || !prepare && (Boolean(from) !== Boolean(cohort))
  || allowCompatibleSource && (!from || prepare)
  || cohort !== undefined && (cohort < 10 || cohort >= works)) {
  throw new Error('prepare requires 10–9990 background Works; clone load requires --from and 10+ fresh Works');
}
const runId = `load-${newRunId()}`;
const artifacts = join(root, '.artifacts', 'load', runId);
const stack = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
mkdirSync(artifacts, { recursive: true });
const sourceBefore = sourceIdentity(root);
const evidence: Record<string, unknown> = {
  runId, mode: prepare ? 'prepare' : from ? 'clone-profile' : 'online-profile',
  source: sourceBefore, works, durationSeconds: duration, seedWorkers,
  ...(from ? { baselineSource: from, freshCohort: cohort } : {}),
  compatibility: loadCompatibility(root),
  qualification: works === 10_000 && duration === 180 ? 'practical-profile' : 'diagnostic-only',
  startedAt: new Date().toISOString(),
};
const record = (name: string, value: ReturnType<typeof command>) => {
  writeFileSync(join(artifacts, `${name}.log`), value.output);
  evidence[`${name}Ms`] = value.elapsedMs;
  if (!value.ok) throw new Error(`${name} failed; see ${name}.log`);
};
let started = false;
let failure: string | undefined;
try {
  if (existsSync(join(root, '.temp', 'qa-full.lock')))
    throw new Error('A full yarn qa run is active; reserve the host for this load profile');
  let baselineFile: string | undefined;
  if (from && cohort) {
    const sourceArtifacts = join(root, '.artifacts', 'load', from);
    const sourceRun = JSON.parse(readFileSync(join(sourceArtifacts, 'run.json'), 'utf8')) as Record<string, any>;
    baselineFile = join(sourceArtifacts, 'baseline.json');
    const bytes = readFileSync(baselineFile);
    validateLoadBaseline(JSON.parse(bytes.toString('utf8')), from, works - cohort);
    const digest = createHash('sha256').update(bytes).digest('hex');
    evidence.baselineSourceMode = preparedLoadSourceMode(sourceRun, sourceBefore,
      works - cohort, digest, evidence.compatibility as ReturnType<typeof loadCompatibility>,
      allowCompatibleSource);
    evidence.baselineSource = sourceRun.source;
    evidence.baselineDigest = digest;
    record('stack-clone', command(root, 'corepack', ['yarn', 'stack:clone', '--profile', 'qa',
      '--run-id', from, '--persistent', '--to-run-id', runId], 1_200_000));
  } else {
    record('stack-up', command(root, 'corepack',
      ['yarn', 'stack:up', '--profile', 'qa', '--run-id', runId, '--persistent'], 180_000));
  }
  started = true;
  const image = fusekiImageFromCompose(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8')).image;
  const inspected = command(root, 'docker', ['image', 'inspect', image, '--format', '{{.Id}}'],
    10_000, dockerEnvironment());
  if (!inspected.ok || !/^sha256:[0-9a-f]{64}$/.test(inspected.output.trim())) {
    throw new Error('Cannot verify the running Fuseki image identity');
  }
  const docker = dockerEnvironment();
  const container = command(root, 'docker', ['ps', '-q',
    '--filter', `label=com.docker.compose.project=rezics-qa-${runId}`,
    '--filter', 'label=com.docker.compose.service=fuseki'], 10_000, docker);
  const runningImage = container.ok && container.output.trim()
    ? command(root, 'docker', ['inspect', container.output.trim(), '--format', '{{.Image}}'], 10_000, docker)
    : undefined;
  if (!runningImage?.ok || runningImage.output.trim() !== inspected.output.trim()) {
    throw new Error('Running Fuseki container differs from the pinned image identity');
  }
  evidence.fusekiImageId = runningImage.output.trim();
  const apps = readEnv(join(stack, 'apps.env'));
  const compose = readEnv(join(stack, 'compose.env'));
  const appsFile = join(stack, 'load-apps.json');
  const composeFile = join(stack, 'load-compose.json');
  writeFileSync(appsFile, JSON.stringify(apps), { mode: 0o600 });
  writeFileSync(composeFile, JSON.stringify(compose), { mode: 0o600 });
  if (!from) record('bootstrap', command(root, 'bun',
    ['scripts/qa/bootstrap.ts', appsFile, composeFile], 180_000));
  record('profile', command(root, 'bun', ['scripts/load/practical.ts', String(works),
    String(duration), artifacts, String(seedWorkers)], PRACTICAL_PROFILE_TIMEOUT_MS, { ...process.env, ...apps,
    REZICS_LOAD_RUN_ID: runId, REZICS_LOAD_ARTIFACT_DIR: artifacts,
    ...(prepare ? { REZICS_LOAD_PREPARE: '1' } : {}),
    ...(from && cohort ? { REZICS_LOAD_BASELINE_FILE: baselineFile!,
      REZICS_LOAD_SOURCE_RUN_ID: from, REZICS_LOAD_COHORT: String(cohort) } : {}) }));
  if (prepare) {
    const bytes = readFileSync(join(artifacts, 'baseline.json'));
    validateLoadBaseline(JSON.parse(bytes.toString('utf8')), runId, works);
    evidence.baselineDigest = createHash('sha256').update(bytes).digest('hex');
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (started && !keep) {
    const down = command(root, 'corepack',
      ['yarn', prepare && !failure ? 'stack:down' : 'stack:reset', '--profile', 'qa',
        '--run-id', runId, '--persistent'], 180_000);
    writeFileSync(join(artifacts, prepare && !failure ? 'stack-down.log' : 'stack-reset.log'), down.output);
    evidence[prepare && !failure ? 'stackDownMs' : 'stackResetMs'] = down.elapsedMs;
    if (!down.ok) failure = [failure, 'stack teardown failed'].filter(Boolean).join('; ');
  }
  const sourceAfter = sourceIdentity(root);
  evidence.sourceStable = sourceAfter.fingerprint === sourceBefore.fingerprint;
  evidence.completedAt = new Date().toISOString();
  if (!evidence.sourceStable) failure = [failure, 'source changed during load run'].filter(Boolean).join('; ');
  if (failure) evidence.failure = failure;
  writeFileSync(join(artifacts, 'run.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Load artifacts: ${artifacts}`);
}
if (failure) throw new Error(failure);
