import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fusekiDockerfile, fusekiImageTag } from './fuseki-image.ts';
import { preserveReapEnvironment } from '../qa/container-reaper.ts';
import { terminateProcessGroup } from '../qa/process/terminate.ts';

export const imageBuildBudgetMs = 10 * 60_000;

export interface FusekiImageOptions {
  env?: NodeJS.ProcessEnv;
  docker?: string;
  budgetMs?: number;
  /** A caller's private log descriptor; otherwise Docker output is streamed. */
  output?: number;
  /** Tests isolate locks; ordinary callers always share the host directory. */
  lockDirectory?: string;
}

export function fusekiImageLock(image: string, directory = '/tmp/rezics-fuseki-images'): string {
  mkdirSync(directory, { recursive: true });
  return join(directory, `${createHash('sha256').update(image).digest('hex')}.lock`);
}

/** The second inspection runs under the kernel lock. Its fd is inherited by the
 * builder, so a dead caller cannot free the lock while its build is still alive. */
export function fusekiImageBuildCommand(root: string, image: string, options: FusekiImageOptions = {}): string[] {
  const script = 'if "$1" image inspect "$2" >/dev/null 2>&1; then '
    + 'printf "Image present: %s\\n" "$2"; exit 0; fi\n'
    + 'printf "Building image: %s\\n" "$2"\n'
    + 'exec "$3" "$4" --gib 4 -- "$1" build --progress plain --file "$5" --tag "$2" "$6"';
  return ['flock', '--exclusive', fusekiImageLock(image, options.lockDirectory), 'sh', '-c', script,
    'fuseki-image', options.docker ?? 'docker', image, process.execPath,
    join(import.meta.dir, '../qa/host-admission.ts'), join(root, fusekiDockerfile), root];
}

/** Stream a command without buffering Maven output and stop its whole process group on cancellation. */
export async function runImageCommand(root: string, command: readonly string[], options: FusekiImageOptions = {}): Promise<void> {
  const child = spawn(command[0]!, command.slice(1), { cwd: root,
    env: preserveReapEnvironment({ ...process.env, ...options.env, DOCKER_BUILDKIT: '1' }),
    detached: true, stdio: ['ignore', options.output ?? 'inherit', options.output ?? 'inherit'] });
  let stopping: Promise<void> | undefined;
  const stop = () => { if (child.pid) stopping ??= terminateProcessGroup(child.pid, { graceMs: 10_000 }); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let timedOut = false;
  const budgetMs = options.budgetMs ?? imageBuildBudgetMs;
  const timer = setTimeout(() => { timedOut = true; stop(); }, budgetMs);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    });
    if (stopping) await stopping;
    if (timedOut) throw new Error(`Image command exceeded ${budgetMs / 1000} s`);
    if (stopping || code !== 0) throw new Error(`Image command failed (exit ${code ?? 'signal'})`);
  } finally {
    clearTimeout(timer);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

/** Shared by generation, stack startup, refresh and the explicit task. */
export async function ensureFusekiImage(root: string, options: FusekiImageOptions = {}): Promise<string> {
  const image = fusekiImageTag(root);
  const inspected = spawnSync(options.docker ?? 'docker', ['image', 'inspect', image],
    { cwd: root, env: preserveReapEnvironment({ ...process.env, ...options.env }),
      stdio: 'ignore', timeout: 10_000 });
  if (inspected.status === 0) return image;
  console.log(`Waiting for image build lock: ${image}`);
  await runImageCommand(root, fusekiImageBuildCommand(root, image, options), options);
  if (fusekiImageTag(root) !== image) throw new Error('Fuseki build inputs changed during the build; run task jena:image again');
  return image;
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error('usage: task jena:image');
  console.log(await ensureFusekiImage(resolve(import.meta.dir, '../..')));
}
