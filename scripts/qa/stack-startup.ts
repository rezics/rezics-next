import { join } from 'node:path';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../services/main/src/modules/work/activate.ts';
import { readEnv, replacePrivate } from '../dev/config.ts';
import { qaMemoryDeadline } from './memory-admission.ts';
import { commandAsync } from './core.ts';
import { integrationOwnerResetStatements, resetIntegrationState } from './integration-reset.ts';

const ADMISSION_WAIT_MS = 120_000;
const PREPARE_BUDGET_MS = 60_000;

/** Restart Fuseki after the text generation is stored, then page the Work-name
 * directory to complete. Admission is qualifyAtStartup on a delta-exclusive
 * service: it runs only when the process starts and a text generation already
 * exists. A dataset reset deletes that generation and withdraws the writer
 * before the fresh graph is written, so the same restart has to follow every
 * fresh graph, not only the first bootstrap. The database is a project volume:
 * stopping the container would discard a tmpfs store. */
export async function admitIntegrationWorkScope(input: {
  root: string;
  projectRunId: string;
  fusekiUrl: string;
  maintenanceToken: string | undefined;
  environment: NodeJS.ProcessEnv;
}): Promise<{ restartMs: number; prepareMs: number }> {
  const container = `rezics-qa-${input.projectRunId}-fuseki-1`;
  const fuseki = new FusekiClient(input.fusekiUrl, input.maintenanceToken);
  const previous = await fuseki.commandHealth().catch(() => undefined);
  const restartStarted = Date.now();
  // docker restart's default 10s stop is short enough to SIGKILL Fuseki. The
  // entrypoint then marks the text index uncertain and startup qualification
  // refuses the writer. An orderly stop leaves clean-stop, and the next
  // process is the one allowed to admit.
  const stopped = await commandAsync(
    input.root, 'docker', ['stop', '-t', '60', container], ADMISSION_WAIT_MS, input.environment,
  );
  if (!stopped.ok) throw new Error(`Fuseki stop failed: ${stopped.output}`);
  const started = await commandAsync(
    input.root, 'docker', ['start', container], ADMISSION_WAIT_MS, input.environment,
  );
  if (!started.ok) throw new Error(`Fuseki start failed: ${started.output}`);
  const waitDeadline = Date.now() + ADMISSION_WAIT_MS;
  let ready = false;
  while (Date.now() < waitDeadline) {
    try {
      const health = await fuseki.commandHealth();
      if (previous && health.instanceId === previous.instanceId) {
        await Bun.sleep(500);
        continue;
      }
      if (health.publicSearchDeltaAvailable === false) {
        throw new Error('Fuseki is not delta-exclusive, so startup cannot admit the Work-name writer');
      }
      if ('textIndexUncertain' in health && health.textIndexUncertain === true) {
        throw new Error('Fuseki text index is uncertain, so startup cannot admit the Work-name writer');
      }
      ready = true;
      break;
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('Fuseki is not delta-exclusive')
        || error.message.startsWith('Fuseki text index is uncertain'))) throw error;
      await Bun.sleep(500);
    }
  }
  if (!ready) throw new Error('Fuseki did not become ready after the Work-name writer restart');
  const restartMs = Date.now() - restartStarted;
  const prepareStarted = Date.now();
  const prepareDeadline = prepareStarted + PREPARE_BUDGET_MS;
  while (Date.now() < prepareDeadline) {
    const page = await fuseki.prepareWorkScopeDirectory();
    if (page.status === 'unavailable') {
      const logs = await commandAsync(
        input.root, 'docker', ['logs', '--tail', '40', container], 15_000, input.environment,
      );
      throw new Error(`Work name scope writer was not admitted (${page.reason})\n${logs.output}`);
    }
    if (page.status === 'deadline') continue;
    if (page.phase === 'complete' && page.more === false) {
      const prepareMs = Date.now() - prepareStarted;
      console.log(`work-scope-admission restartMs=${restartMs} prepareMs=${prepareMs}`);
      return { restartMs, prepareMs };
    }
    if (page.phase === 'owners' && page.more === true) continue;
    throw new Error(`Work name scope preparation is unqualified (${page.status} ${page.phase})`);
  }
  throw new Error('Work name scope preparation exceeds 60 seconds');
}

/** The product assembler has no raw update endpoint, and the image refuses
 * CLEAR ALL, so the SPARQL reset cannot empty this stack. Wipe the Fuseki
 * volume and write a fresh graph. The following admission restart then
 * qualifies the writer. A maintenance dataset reset that already succeeded
 * must not call this: wiping would drop the graph it just wrote. */
export async function resetDisposableExclusiveStack(input: {
  root: string;
  projectRunId: string;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  const stackDir = join(input.root, '.temp', 'stack', `rezics-qa-${input.projectRunId}`);
  const appsPath = join(stackDir, 'apps.env');
  const composePath = join(stackDir, 'compose.env');
  const saved = readEnv(composePath);
  const next = await resetIntegrationState(readEnv(appsPath), saved, {
    owners: resetIntegrationOwners,
    graph: async (apps, lineage) => {
      const started = Date.now();
      await emptyDurableFuseki(input);
      const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN, apps.FUSEKI_COMMAND_TOKEN);
      await waitForExclusiveFuseki(fuseki);
      await initializeFreshGraph(fuseki, lineage);
      console.log(`work-scope-disposable-reset recreateMs=${Date.now() - started}`);
    },
  });
  replacePrivate(appsPath, next);
  replacePrivate(composePath, {
    ...readEnv(composePath),
    MAIN_DATA_EPOCH: next.MAIN_DATA_EPOCH!,
    MAIN_ROUTING_EPOCH: next.MAIN_ROUTING_EPOCH!,
  });
}

async function emptyDurableFuseki(input: {
  root: string;
  projectRunId: string;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  const container = `rezics-qa-${input.projectRunId}-fuseki-1`;
  const stopped = await commandAsync(
    input.root, 'docker', ['stop', '-t', '60', container], ADMISSION_WAIT_MS, input.environment,
  );
  if (!stopped.ok) throw new Error(`Disposable Fuseki stop failed: ${stopped.output}`);
  const image = await commandAsync(
    input.root, 'docker', ['inspect', container, '--format', '{{.Config.Image}}'], 15_000, input.environment,
  );
  if (!image.ok) throw new Error(`Disposable Fuseki image lookup failed: ${image.output}`);
  const wiped = await commandAsync(input.root, 'docker', [
    'run', '--rm', '--user', '0:0', '--volumes-from', container, '--entrypoint', 'sh', image.output.trim(),
    '-c', 'rm -rf /fuseki/databases/* /fuseki/databases/.[!.]*',
  ], 60_000, input.environment);
  if (!wiped.ok) throw new Error(`Disposable Fuseki wipe failed: ${wiped.output}`);
  const started = await commandAsync(
    input.root, 'docker', ['start', container], ADMISSION_WAIT_MS, input.environment,
  );
  if (!started.ok) throw new Error(`Disposable Fuseki start failed: ${started.output}`);
}

async function resetIntegrationOwners(compose: Record<string, string>): Promise<void> {
  const db = new Client({
    connectionString: `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`,
  });
  await db.connect();
  try {
    for (const sql of integrationOwnerResetStatements) await db.query(sql);
  } finally {
    await db.end();
  }
}

async function waitForExclusiveFuseki(fuseki: FusekiClient): Promise<void> {
  const deadline = Date.now() + ADMISSION_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const health = await fuseki.commandHealth();
      if (health.publicSearchDeltaAvailable === false) {
        throw new Error('Fuseki is not delta-exclusive, so startup cannot admit the Work-name writer');
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Fuseki is not delta-exclusive')) throw error;
      await Bun.sleep(500);
    }
  }
  throw new Error('Fuseki did not become ready after the disposable recreate');
}

/** Bun's case clock cannot pause; the enclosing runner bounds active file work. */
export function qaStartupTestTimeout(activeMs: number, env: NodeJS.ProcessEnv = process.env): number {
  if (env.REZICS_STACK_PROFILE !== undefined && env.REZICS_STACK_PROFILE !== 'qa') return activeMs;
  return Math.max(activeMs, qaMemoryDeadline(env) - Date.now());
}

/** Indirect startup scripts must stream admission and retain their active work budget. */
export async function runQaAdmissionChildAsync(root: string, program: string, args: string[],
  workTimeout: number, env: NodeJS.ProcessEnv = process.env, onOutputLine?: (line: string) => void) {
  const context = startupChildContext(env, workTimeout, Date.now());
  const result = await commandAsync(root, program, args, workTimeout, context.env,
    onOutputLine, { runDeadline: context.deadline });
  return { ...result, stdout: result.output, stderr: '', status: result.ok ? 0 : 1,
    error: result.timedOut ? new Error('QA admission child timed out') : undefined };
}

function startupChildContext(env: NodeJS.ProcessEnv, workTimeout: number, started: number) {
  if (env.REZICS_STACK_PROFILE !== undefined && env.REZICS_STACK_PROFILE !== 'qa')
    return { env, timeout: workTimeout, deadline: undefined };
  const deadline = qaMemoryDeadline(env);
  return { env: { ...env, REZICS_QA_MEMORY_DEADLINE: String(deadline), REZICS_QA_MEMORY_EVENTS: '1' },
    timeout: Math.max(1, deadline - started) + workTimeout, deadline };
}

/** The child bounds Compose readiness after admission; its parent must allow both. */
export async function runQaStartupChildAsync(root: string, args: string[], workTimeout: number,
  env: NodeJS.ProcessEnv = process.env, onOutputLine?: (line: string) => void) {
  const context = startupChildContext(env, workTimeout, Date.now());
  // Clone's work budget also covers copying. Pause it for admission rather than
  // enlarging it to the run deadline; stack:up bounds readiness in its child.
  const cloneDeadline = args[0] === 'stack:clone' ? context.deadline : undefined;
  const result = await commandAsync(root, 'bun', ['scripts/dev/cli.ts', ...args],
    cloneDeadline === undefined ? context.timeout : workTimeout,
    context.env, onOutputLine, { runDeadline: cloneDeadline });
  const admissionWaitMs = admissionWaitDuration(result.output);
  return { ...result, admissionWaitMs, activeElapsedMs: result.elapsedMs - admissionWaitMs,
    stdout: result.output, stderr: '', status: result.ok ? 0 : 1,
    error: result.timedOut ? new Error('QA startup child timed out') : undefined };
}

export function admissionWaitDuration(output: string): number {
  const tokens = new Map<string, number>();
  for (const match of output.matchAll(/^QA_MEMORY_WAIT_END (\S+) (\d+)$/gm))
    tokens.set(match[1]!, Number(match[2]));
  return [...tokens.values()].reduce((total, duration) => total + duration, 0);
}
