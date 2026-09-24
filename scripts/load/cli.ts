import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEnv } from '../dev/config.ts';

const root = resolve(import.meta.dir, '../..');
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
let works = 10_000, duration = 180, keep = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--works' && /^\d+$/.test(args[i + 1] ?? '')) works = Number(args[++i]);
  else if (args[i] === '--duration' && /^\d+$/.test(args[i + 1] ?? '')) duration = Number(args[++i]);
  else if (args[i] === '--keep') keep = true;
  else throw new Error(`Invalid load option: ${args[i]}`);
}
if (!Number.isInteger(works) || works < 10 || works > 10_000
  || !Number.isInteger(duration) || duration < 10 || duration > 180)
  throw new Error('load options require 10–10000 Works and 10–180 seconds');
const runId = `load-${newRunId()}`;
const artifacts = join(root, '.artifacts', 'load', runId);
const stack = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
mkdirSync(artifacts, { recursive: true });
const sourceBefore = sourceIdentity(root);
const evidence: Record<string, unknown> = {
  runId, source: sourceBefore, works, durationSeconds: duration,
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
  record('stack-up', command(root, 'corepack',
    ['yarn', 'stack:up', '--profile', 'qa', '--run-id', runId], 180_000));
  started = true;
  const apps = readEnv(join(stack, 'apps.env'));
  const compose = readEnv(join(stack, 'compose.env'));
  const appsFile = join(stack, 'load-apps.json');
  const composeFile = join(stack, 'load-compose.json');
  writeFileSync(appsFile, JSON.stringify(apps), { mode: 0o600 });
  writeFileSync(composeFile, JSON.stringify(compose), { mode: 0o600 });
  record('bootstrap', command(root, 'bun', ['scripts/qa/bootstrap.ts', appsFile, composeFile], 180_000));
  record('profile', command(root, 'bun', ['scripts/load/practical.ts', String(works),
    String(duration), artifacts], 3 * 60 * 60_000, { ...process.env, ...apps,
    REZICS_LOAD_RUN_ID: runId, REZICS_LOAD_ARTIFACT_DIR: artifacts }));
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (started && !keep) {
    const down = command(root, 'corepack',
      ['yarn', 'stack:reset', '--profile', 'qa', '--run-id', runId], 180_000);
    writeFileSync(join(artifacts, 'stack-reset.log'), down.output);
    evidence.stackResetMs = down.elapsedMs;
    if (!down.ok) failure = [failure, 'stack reset failed'].filter(Boolean).join('; ');
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
