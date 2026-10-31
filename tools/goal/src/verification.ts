import type { ProofMetadata } from './types.ts';

/** CP reservation identity; mapped exactly to the delivered native token wire field. */
export type ProofBinding = {
  version: 1;
  reservationToken: string;
  checkId: string;
  goal: string;
  taskId: string;
  attempt: number;
  sourceCommit: string;
  sourceTree: string;
  argv: string[];
  cwd: string;
};
export type ProofBindResult =
  | {
      status: 'bound';
      binding: ProofBinding;
      native?: { outcome: 'started' | 'replayed'; resultPath: string; registry: string };
    }
  | { status: 'refused'; provenNeverStarted: true; cause: string }
  | { status: 'unavailable' | 'unknown'; cause: string };
/** Structural receiving contract of scripts/check-custody.ts at the delivered producer commit. */
export type ControllerProofBindingV1 = Readonly<
  Omit<ProofBinding, 'reservationToken' | 'argv'> & { token: string; argv: readonly string[] }
>;
export type ControllerProofStartV1 =
  | Readonly<{ version: 1; outcome: 'started' | 'replayed'; binding: ControllerProofBindingV1; resultPath: string }>
  | Readonly<{ version: 1; outcome: 'refused-never-started'; binding: ControllerProofBindingV1; reason: string }>
  | Readonly<{
      version: 1;
      outcome: 'unavailable';
      binding: ControllerProofBindingV1;
      custody: 'unknown';
      reason: string;
    }>;
export interface ProofProducer {
  /** Bind once before execution; all physical infrastructure reruns retain this logical identity. */
  bind(binding: ProofBinding): Promise<ProofBindResult>;
}
/** Explicit compatibility fallback for snapshots without the native capability. */
export const unavailableProofProducer = {
  bind: (_binding: ProofBinding): ProofBindResult => ({
    status: 'unavailable',
    cause: 'Native producer has no controller reservation/source/argv binding capability',
  }),
};

/** Native producer integration required in every captured proof source. */
export const PROOF_PRODUCER_COMMIT = '4669e2280c9511a2157d683c09a25eb96f7d5c09';
export function nativeProofBinding(binding: ProofBinding): ControllerProofBindingV1 {
  const { reservationToken, ...facts } = binding;
  return { ...facts, token: reservationToken, argv: [...binding.argv] };
}
/** Strict receiving side: never turn a malformed/mismatched wire response into a capacity-free refusal. */
export function receiveProofStart(binding: ProofBinding, registry: string, value: unknown): ProofBindResult {
  const unknown = (cause: string): ProofBindResult => ({ status: 'unknown', cause });
  if (!isObject(value) || value.version !== 1 || !isDeepStrictEqual(value.binding, nativeProofBinding(binding)))
    return unknown('Native proof response identity mismatch');
  const keys =
    value.outcome === 'started' || value.outcome === 'replayed'
      ? ['version', 'outcome', 'binding', 'resultPath']
      : value.outcome === 'refused-never-started'
        ? ['version', 'outcome', 'binding', 'reason']
        : ['version', 'outcome', 'binding', 'custody', 'reason'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    return unknown('Native proof response fields mismatch');
  if (value.outcome === 'started' || value.outcome === 'replayed') {
    const resultPath = join(binding.cwd, '.temp/goal/checks/results', `${binding.checkId}.json`);
    if (value.resultPath !== resultPath) return unknown('Native proof result path mismatch');
    return { status: 'bound', binding, native: { outcome: value.outcome, resultPath, registry } };
  }
  if (typeof value.reason !== 'string' || !value.reason.trim()) return unknown('Native proof response cause missing');
  if (value.outcome === 'refused-never-started')
    return { status: 'refused', provenNeverStarted: true, cause: value.reason };
  if (value.outcome === 'unavailable' && value.custody === 'unknown') return unknown(value.reason);
  return unknown('Native proof response outcome unavailable');
}

/** Isolate per-task process.env for the actual async API; this bridge never executes acceptance itself. */
const PRODUCER_START = `import {pathToFileURL} from 'node:url';
const binding = JSON.parse(await Bun.stdin.text());
const {startControllerWorkerCheck} = await import(pathToFileURL(binding.cwd + '/scripts/worker-check.ts').href);
console.log(JSON.stringify(await startControllerWorkerCheck(binding)));`;
async function invokeProofProducer(binding: ProofBinding, registry: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--eval', PRODUCER_START], {
      cwd: binding.cwd,
      env: {
        ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GOAL_'))),
        GOAL_CHECK_REGISTRY: registry,
        GOAL_TASK_ID: binding.taskId,
        GOAL_ATTEMPT: String(binding.attempt),
        KERNEL_CHECK_AFFECTED: binding.sourceCommit,
        NODE_DISABLE_COMPILE_CACHE: '1',
        GOAL_CHECK_WAIT_FILE: join(dirname(registry), 'runs', binding.taskId, `${binding.attempt}.check-wait`),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      error = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-8192);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(error || `Native proof API bridge exited ${code}`));
      try {
        const value: unknown = JSON.parse(output);
        resolve(value);
      } catch (cause) {
        reject(cause);
      }
    });
    child.stdin.end(JSON.stringify(nativeProofBinding(binding)));
  });
}

/** Publish only an admitted identity, using the producer's existing fence and closed reservation schema. */
export function productionProofProducer(store: WorkerStore, registry: string, env: NodeJS.ProcessEnv): ProofProducer {
  return {
    async bind(binding) {
      try {
        const admitted = () => {
          const run = store.proofReservation(binding.taskId, binding.attempt);
          store.assertCurrent(binding);
          if (run?.status !== 'reserved' || !isDeepStrictEqual(run.binding, binding))
            throw new Error('Native proof publication requires its exact active SQLite reservation');
        };
        admitted();
        if (
          spawnSync('git', ['merge-base', '--is-ancestor', PROOF_PRODUCER_COMMIT, binding.sourceCommit], {
            cwd: binding.cwd,
            stdio: 'ignore',
          }).status !== 0
        )
          return {
            status: 'unavailable',
            cause: 'Captured proof source does not contain the delivered producer; capture fresh integration source',
          };
        if (realpathSync(binding.cwd) !== binding.cwd) throw new Error('Native proof cwd must be canonical');
        const custody: unknown = await import(pathToFileURL(join(binding.cwd, 'scripts/check-custody.ts')).href);
        const wrapper: unknown = await import(pathToFileURL(join(binding.cwd, 'scripts/worker-check.ts')).href);
        if (
          !isObject(custody) ||
          !isObject(wrapper) ||
          typeof wrapper.startControllerWorkerCheck !== 'function' ||
          typeof custody.validateControllerProofBinding !== 'function' ||
          typeof custody.controllerProofReservationPath !== 'function' ||
          typeof custody.validateControllerProofReservation !== 'function' ||
          typeof custody.withCheckFence !== 'function' ||
          typeof custody.writeAtomicJson !== 'function' ||
          typeof custody.validControllerProofRegistration !== 'function'
        )
          return { status: 'unavailable', cause: 'Captured native producer ABI unavailable' };
        const {
          validateControllerProofBinding,
          controllerProofReservationPath,
          validateControllerProofReservation,
          withCheckFence,
          writeAtomicJson,
        } = custody;
        const wire: unknown = validateControllerProofBinding(nativeProofBinding(binding));
        if (!isDeepStrictEqual(wire, nativeProofBinding(binding)))
          throw new Error('Native proof binding changed during validation');
        mkdirSync(registry, { recursive: true });
        const path: unknown = controllerProofReservationPath(registry, binding.reservationToken);
        if (typeof path !== 'string') throw new Error('Native proof reservation path unavailable');
        await withCheckFence(binding.cwd, binding.checkId, () => {
          admitted();
          const reservation = { version: 1, state: 'reserved', binding: wire };
          const validated: unknown = validateControllerProofReservation(reservation);
          if (!isDeepStrictEqual(validated, reservation))
            throw new Error('Native proof reservation changed during validation');
          if (existsSync(path)) {
            const retained: unknown = validateControllerProofReservation(JSON.parse(readFileSync(path, 'utf8')));
            if (!isDeepStrictEqual(retained, reservation))
              throw new Error('Native proof reservation was revoked or changed');
          } else writeAtomicJson(path, reservation);
        });
        return receiveProofStart(binding, registry, await invokeProofProducer(binding, registry, env));
      } catch (error) {
        return { status: 'unknown', cause: String(error) };
      }
    },
  };
}

/** Parse only the selected public metadata schema, independently of execution authorization. */
export function parseProofMetadata(value: unknown): ProofMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('proof must be an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['journey', 'sourceTasks', 'sourceCommit'].includes(key)))
    throw new Error('proof supports only journey, sourceTasks, and sourceCommit');
  if (typeof raw.journey !== 'string' || !raw.journey.trim()) throw new Error('proof.journey is required');
  if (
    !Array.isArray(raw.sourceTasks) ||
    !raw.sourceTasks.length ||
    raw.sourceTasks.some((task) => typeof task !== 'string' || !task.trim()) ||
    new Set(raw.sourceTasks).size !== raw.sourceTasks.length
  )
    throw new Error('proof.sourceTasks must be a nonempty list of distinct original tasks');
  if (typeof raw.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(raw.sourceCommit))
    throw new Error('proof.sourceCommit must be a captured full commit id');
  return { journey: raw.journey, sourceTasks: [...raw.sourceTasks], sourceCommit: raw.sourceCommit };
}

import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import type { Brief, Task } from './types.ts';
import type { AuthenticatedManager } from './priority-authority.ts';
import type { WorkerStore } from './store.ts';
import { git } from './tasks.ts';

export type ProofAuthorization = {
  fingerprint: string;
  manager: string;
  sessionId: string;
  sourceTree: string;
  integrationBranch: string;
  originals: { taskId: string; commit: string; argv: string[] }[];
};
export type ProofReservation = {
  binding: ProofBinding;
  status: 'reserved' | 'bound' | 'unknown' | 'released';
  cause?: string;
  /** All producer observations, including physical reruns, are retained without normalization. */
  observation?: ProofObservation;
  native?: { outcome: 'started' | 'replayed'; resultPath: string; registry: string };
};
export type ProofObservation = {
  status: 'running' | 'terminal' | 'unknown';
  passed: boolean;
  cause: string;
  record: unknown;
  physical: unknown[];
};
export function proofFingerprint(brief: Brief): string {
  return createHash('sha256')
    .update(JSON.stringify([brief.goal, brief.manager, brief.kind, brief.proof, brief.acceptance]))
    .digest('hex');
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
/** Explicit Bun test or service check files, preserving the complete raw env/cwd prefix. */
function fileCommand(argv: string[]): { prefix: string[]; files: string[] } | undefined {
  const first = argv.findIndex((word) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(word));
  if (first < 0) return;
  const prefix = argv.slice(0, first);
  let index = 0;
  if (prefix[index] === 'env') {
    index++;
    while (index < prefix.length) {
      if (prefix[index] === '-u' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix[index + 1] ?? '')) index += 2;
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix[index] ?? '')) index++;
      else break;
    }
  }
  const command = prefix.slice(index);
  const bunTest =
    command[0] === 'bun' &&
    (command[1] === 'test' ||
      (command[1] === '--cwd' && command[3] === 'test') ||
      (command[1]?.startsWith('--cwd=') && command[2] === 'test'));
  if (
    !bunTest &&
    !same(command, ['bun', 'run', '--cwd', 'services/kernel', 'check']) &&
    !same(command, ['bun', 'run', '--cwd', 'services/auth', 'check'])
  )
    return;
  const files = argv.slice(first);
  if (!files.every((word) => /^[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(word))) return;
  return { prefix: argv.slice(0, first), files };
}
export function originalCommandMatches(command: string[], originals: string[][]): boolean {
  if (originals.every((argv) => same(argv, command))) return true;
  const parts = originals.map(fileCommand);
  if (parts.some((part) => !part)) return false;
  const prefix = parts[0]!.prefix;
  if (!parts.every((part) => same(part!.prefix, prefix))) return false;
  return same(command, [...prefix, ...new Set(parts.flatMap((part) => part!.files))]);
}
export function authorizeProof(
  store: WorkerStore,
  root: string,
  brief: Brief,
  actor: AuthenticatedManager | null | undefined,
  operations: string | undefined,
  integrationBranch: string,
): ProofAuthorization {
  if (brief.kind !== 'verification' || !brief.proof || brief.criticalPath)
    throw new Error('invalid verification registration');
  if (!actor || ![brief.manager, operations].includes(actor.id))
    throw new Error('proof registration requires the authenticated owning or operations manager');
  const session = store.db.query('SELECT state FROM manager_sessions WHERE id=?').get(actor.id) as {
    state: string;
  } | null;
  const state: unknown = session ? JSON.parse(session.state) : null;
  if (!isObject(state) || state.status !== 'running' || state.threadId !== actor.sessionId)
    throw new Error('proof registration requires a live authenticated manager session');
  const proof = parseProofMetadata(brief.proof);
  if (!originalCommandHasInputs(brief.acceptance.command))
    throw new Error('proof cannot register a broad root or gate campaign');
  if (git(root, ['rev-parse', `refs/heads/${integrationBranch}`]) !== proof.sourceCommit)
    throw new Error('proof source must be the captured integration head');
  if (git(root, ['rev-parse', `${proof.sourceCommit}^{commit}`]) !== proof.sourceCommit)
    throw new Error('proof source is not a captured commit');
  const originals = proof.sourceTasks.map((id) => {
    const task = store.task(id);
    const commit = task.integratedCommit ?? task.mergedCommit;
    if (
      task.brief.goal !== brief.goal ||
      task.brief.manager !== brief.manager ||
      task.brief.kind === 'verification' ||
      !['integrated', 'merged'].includes(task.state) ||
      !commit
    )
      throw new Error(`proof source ${id} must be a same-Goal integrated original`);
    if (git(root, ['merge-base', commit, proof.sourceCommit]) !== commit)
      throw new Error(`proof source commit does not contain ${id}`);
    return { taskId: id, commit, argv: [...task.brief.acceptance.command] };
  });
  if (
    !originalCommandMatches(
      brief.acceptance.command,
      originals.map((original) => original.argv),
    )
  )
    throw new Error('proof command must retain every whole original argv or its exact deduplicated file union');
  return {
    integrationBranch,
    fingerprint: proofFingerprint(brief),
    manager: actor.id,
    sessionId: actor.sessionId,
    sourceTree: git(root, ['rev-parse', `${proof.sourceCommit}^{tree}`]),
    originals,
  };
}
/** Read captured Git objects only. Explicit command files, including shell-contained originals, must exist. */
export function preflightProof(root: string, brief: Brief): string[] {
  if (!brief.proof) return ['proof metadata unavailable'];
  const tokens = brief.acceptance.command.flatMap(
    (word) => word.match(/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?|sh|json|sql)\b/g) ?? [],
  );
  let cwd = '';
  const argv = brief.acceptance.command;
  const cwdIndex = argv.indexOf('--cwd');
  if (cwdIndex >= 0) cwd = `${argv[cwdIndex + 1]}/`;
  else cwd = (argv.find((word) => word.startsWith('--cwd='))?.slice(6) ?? '') + '/';
  if (cwd === '/') cwd = '';
  return [...new Set(tokens)].filter((file) => {
    if (file.startsWith('-') || file.includes('..') || file.startsWith('/')) return true;
    return (
      spawnSync('git', ['cat-file', '-e', `${brief.proof!.sourceCommit}:${cwd}${file}`], { cwd: root, stdio: 'ignore' })
        .status !== 0
    );
  });
}
export function newProofBinding(task: Task, attempt: number): ProofBinding {
  if (!task.brief.proof || task.proofAuthorization?.fingerprint !== proofFingerprint(task.brief))
    throw new Error('proof registration unavailable');
  return {
    version: 1,
    reservationToken: randomUUID(),
    checkId: randomUUID(),
    goal: task.brief.goal,
    taskId: task.id,
    attempt,
    sourceCommit: task.brief.proof.sourceCommit,
    sourceTree: task.proofAuthorization.sourceTree,
    argv: [...task.brief.acceptance.command],
    cwd: task.worktree,
  };
}
export function proofProtocolAuthorized(brief: Partial<Brief>, run?: ProofReservation): boolean {
  return (
    brief.kind === 'verification' &&
    Boolean(
      brief.proof &&
      run &&
      (run.status === 'bound' || (run.status === 'released' && run.observation?.status === 'terminal')) &&
      brief.proof.sourceCommit === run.binding.sourceCommit &&
      same(brief.acceptance?.command, run.binding.argv),
    )
  );
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
/** Bind only actual delivered read APIs. No producer export is presumed or synthesized. */
export async function loadProofReader(wrapper: string, registry?: string): Promise<ProofReader> {
  const module: unknown = await import(pathToFileURL(wrapper).href);
  if (
    !isObject(module) ||
    typeof module.readWorkerCheckRecord !== 'function' ||
    typeof module.readWorkerCheckHistory !== 'function'
  )
    throw new Error('Native wrapper custody reader unavailable');
  const record = module.readWorkerCheckRecord,
    history = module.readWorkerCheckHistory;
  const reader: ProofReader = {
    record: (id, cwd) => record(id, cwd),
    history: (id, physical, cwd) => history(id, physical, cwd),
  };
  if (registry) {
    const custody: unknown = await import(pathToFileURL(join(wrapper, '../check-custody.ts')).href);
    if (
      !isObject(custody) ||
      typeof custody.validControllerProofRegistration !== 'function' ||
      typeof custody.controllerProofStatePath !== 'function'
    )
      throw new Error('Native proof registration reader unavailable');
    const { validControllerProofRegistration, controllerProofStatePath } = custody;
    reader.incarnations = (binding) => {
      const path: unknown = controllerProofStatePath(binding.cwd, binding.checkId);
      if (typeof path !== 'string') throw new Error('Native proof state path unavailable');
      const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (
        !isObject(state) ||
        state.phase !== 'intent' ||
        !isDeepStrictEqual(state.binding, nativeProofBinding(binding)) ||
        state.registry !== registry ||
        !Array.isArray(state.physical) ||
        !state.physical.length ||
        state.physical.length > 2 ||
        !state.physical.every(
          (run: unknown) => isObject(run) && typeof run.physicalRunId === 'string' && Array.isArray(run.argv),
        )
      )
        throw new Error('Native proof physical intent unavailable');
      return state.physical.map((run: unknown) => {
        if (
          !isObject(run) ||
          typeof run.physicalRunId !== 'string' ||
          !Array.isArray(run.argv) ||
          !run.argv.every((arg: unknown) => typeof arg === 'string')
        )
          throw new Error('Native physical argv unavailable');
        return {
          id: run.physicalRunId,
          argv: run.argv.filter((arg: unknown): arg is string => typeof arg === 'string'),
        };
      });
    };
    reader.valid = (binding, id) => {
      const registration: unknown = JSON.parse(readFileSync(join(registry, `${binding.checkId}.${id}.json`), 'utf8'));
      return validControllerProofRegistration(registration, nativeProofBinding(binding)) === true;
    };
  }
  return reader;
}
export interface ProofReader {
  record(id: string, cwd: string): unknown;
  history(id: string, physicalRunId: string, cwd: string): unknown;
  incarnations?(binding: ProofBinding): { id: string; argv: string[] }[];
  valid?(binding: ProofBinding, physicalRunId: string): boolean;
}
/** Observe the real reader's terminal proofs; a rerun predecessor must also have authoritative custody. */
export function observeProof(binding: ProofBinding, reader: ProofReader): ProofObservation {
  const physical: unknown[] = [];
  let record: unknown;
  const result = (status: ProofObservation['status'], passed: boolean, cause: string): ProofObservation => ({
    status,
    passed,
    cause,
    record,
    physical,
  });
  try {
    record = reader.record(binding.checkId, binding.cwd);
    if (
      !isObject(record) ||
      record.id !== binding.checkId ||
      record.cwd !== binding.cwd ||
      !same(record.argv, binding.argv) ||
      !isObject(record.ownership) ||
      record.ownership.taskId !== binding.taskId ||
      record.ownership.attempt !== binding.attempt ||
      record.custodyVersion !== 1
    )
      return result('unknown', false, 'logical check identity or ownership mismatch');
    const incarnations = reader.incarnations?.(binding);
    const ids = incarnations?.map((run) => run.id) ?? [
      ...new Set(
        [record.waitForPhysicalRunId, record.physicalRunId].filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (
      incarnations &&
      (!isDeepStrictEqual(record.controllerProof, nativeProofBinding(binding)) ||
        ids.at(-1) !== record.physicalRunId ||
        new Set(ids).size !== ids.length)
    )
      return result('unknown', false, 'native binding or physical intent mismatch');
    if (!ids.length || (typeof record.reruns === 'number' && record.reruns > ids.length - 1))
      return result('unknown', false, 'physical rerun custody unavailable');
    for (const id of ids) {
      const run = reader.history(binding.checkId, id, binding.cwd);
      physical.push(run);
      if (reader.valid && !reader.valid(binding, id))
        return result('unknown', false, 'native registration custody unavailable');
      if (
        !isObject(run) ||
        run.id !== binding.checkId ||
        run.physicalRunId !== id ||
        !same(
          run.argv,
          incarnations?.find((entry) => entry.id === id)?.argv ??
            (id === record.physicalRunId ? (record.physicalArgv ?? binding.argv) : binding.argv),
        ) ||
        run.cwd !== binding.cwd ||
        !isObject(run.ownership) ||
        run.ownership.taskId !== binding.taskId ||
        run.ownership.attempt !== binding.attempt
      )
        return result('unknown', false, 'physical ownership unavailable');
      if (run.status === 'unknown') return result('unknown', false, 'physical incarnation is unknown');
      const proof = run.terminalProof;
      if (
        !isObject(proof) ||
        proof.local !== true ||
        proof.remote !== (run.remoteExpected ? true : null) ||
        proof.resultKnown !== true
      )
        return result(
          record.status === 'running' && run.status === 'running' ? 'running' : 'unknown',
          false,
          'physical terminal custody unresolved',
        );
    }
    if (physical.some((run) => !isObject(run) || run.status !== 'finished' || typeof run.exitCode !== 'number'))
      return result('unknown', false, 'physical terminal result unavailable');
    const latest = physical.at(-1);
    if (!isObject(latest) || latest.exitCode !== record.exitCode)
      return result('unknown', false, 'logical and physical terminal results disagree');
    if (record.status !== 'finished' || typeof record.exitCode !== 'number')
      return result('unknown', false, 'terminal result unavailable');
    return result(
      'terminal',
      record.exitCode === 0 &&
        record.infrastructureFailureFinal !== true &&
        record.timedOut !== true &&
        record.unverified !== true &&
        !record.error &&
        physical.every((run) => isObject(run) && run.timedOut !== true && run.unverified !== true && !run.error),
      `check ${binding.checkId}: exit ${record.exitCode}; ${String(record.failureSummary ?? record.infrastructureFailure ?? '')}; log ${String(record.log)}${record.infrastructureFailureFinal ? '; final infrastructure failure' : ''}`,
    );
  } catch (error) {
    return result('unknown', false, String(error));
  }
}
/** Terminal observation and revocation share the producer fence with all physical incarnation publication. */
export async function readReservationObservation(
  run: ProofReservation,
  registry = run.native?.registry,
): Promise<ProofObservation> {
  const binding = run.binding;
  const unknown = (cause: unknown): ProofObservation => ({
    status: 'unknown',
    passed: false,
    cause: String(cause),
    record: null,
    physical: [],
  });
  try {
    const reader = await loadProofReader(join(binding.cwd, 'scripts/worker-check.ts'), registry);
    if (!registry) return observeProof(binding, reader);
    const custody: unknown = await import(pathToFileURL(join(binding.cwd, 'scripts/check-custody.ts')).href);
    if (
      !isObject(custody) ||
      typeof custody.withCheckFence !== 'function' ||
      typeof custody.controllerProofReservationPath !== 'function' ||
      typeof custody.validateControllerProofReservation !== 'function' ||
      typeof custody.writeAtomicJson !== 'function'
    )
      return unknown('Native proof terminal fence unavailable');
    const { withCheckFence, controllerProofReservationPath, validateControllerProofReservation, writeAtomicJson } =
      custody;
    let observation = unknown('Native proof observation unavailable');
    await withCheckFence(binding.cwd, binding.checkId, () => {
      observation = observeProof(binding, reader);
      if (observation.status !== 'terminal') return;
      const path: unknown = controllerProofReservationPath(registry, binding.reservationToken);
      if (typeof path !== 'string') throw new Error('Native proof reservation path unavailable');
      const reservation: unknown = validateControllerProofReservation(JSON.parse(readFileSync(path, 'utf8')));
      if (!isObject(reservation) || !isDeepStrictEqual(reservation.binding, nativeProofBinding(binding)))
        throw new Error('Native proof terminal reservation changed');
      writeAtomicJson(path, { version: 1, state: 'revoked', binding: nativeProofBinding(binding) });
    });
    return observation;
  } catch (error) {
    return unknown(error);
  }
}
export async function readProofObservation(task: Task): Promise<ProofObservation> {
  if (task.proofRun?.status === 'released' && task.proofRun.observation) return task.proofRun.observation;
  if (!task.proofRun || task.proofRun.status !== 'bound')
    return {
      status: 'unknown',
      passed: false,
      cause: 'proof producer binding unavailable',
      record: null,
      physical: [],
    };
  return readReservationObservation(task.proofRun);
}

export type HistoricalProofCheck = { taskId: string; attempt: number; checkId: string; cwd: string };
/** Old unbound UUIDs can release quarantine through custody, but can never acquire source/token provenance. */
export async function historicalProofTerminal(check: HistoricalProofCheck): Promise<ProofObservation> {
  const physical: unknown[] = [];
  let record: unknown;
  try {
    const reader = await loadProofReader(join(check.cwd, 'scripts/worker-check.ts'));
    record = reader.record(check.checkId, check.cwd);
    if (
      !isObject(record) ||
      record.id !== check.checkId ||
      record.cwd !== check.cwd ||
      record.custodyVersion !== 1 ||
      !isObject(record.ownership) ||
      record.ownership.taskId !== check.taskId ||
      record.ownership.attempt !== check.attempt ||
      record.status !== 'finished' ||
      typeof record.exitCode !== 'number' ||
      typeof record.physicalRunId !== 'string'
    )
      throw new Error('Historical check custody unresolved');
    const ids = [
      ...new Set(
        [record.waitForPhysicalRunId, record.physicalRunId].filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (typeof record.reruns === 'number' && record.reruns > ids.length - 1)
      throw new Error('Historical rerun custody unresolved');
    for (const id of ids) {
      const run = reader.history(check.checkId, id, check.cwd);
      physical.push(run);
      if (
        !isObject(run) ||
        run.id !== check.checkId ||
        run.physicalRunId !== id ||
        run.cwd !== check.cwd ||
        !isDeepStrictEqual(run.ownership, record.ownership) ||
        run.status !== 'finished' ||
        typeof run.exitCode !== 'number' ||
        !isObject(run.terminalProof) ||
        run.terminalProof.local !== true ||
        run.terminalProof.remote !== (run.remoteExpected ? true : null) ||
        run.terminalProof.resultKnown !== true
      )
        throw new Error('Historical physical custody unresolved');
    }
    return {
      status: 'terminal',
      passed: false,
      cause: 'Historical owned terminal custody; no registered proof provenance',
      record,
      physical,
    };
  } catch (error) {
    return { status: 'unknown', passed: false, cause: String(error), record, physical };
  }
}

/** Passing evidence belongs only to this exact source and integration ref, never a later source. */
export function proofSourceUnchanged(task: Task, integrationBranch: string): boolean {
  if (!task.brief.proof || !task.proofRun || task.proofAuthorization?.fingerprint !== proofFingerprint(task.brief))
    return false;
  try {
    return (
      git(task.worktree, ['rev-parse', 'HEAD']) === task.proofRun.binding.sourceCommit &&
      git(task.worktree, ['rev-parse', 'HEAD^{tree}']) === task.proofRun.binding.sourceTree &&
      git(task.worktree, ['rev-parse', `refs/heads/${integrationBranch}`]) === task.proofRun.binding.sourceCommit &&
      git(task.worktree, ['status', '--porcelain', '--untracked-files=all']) === ''
    );
  } catch {
    return false;
  }
}

export class ProofCapacityQueuedError extends Error {
  constructor() {
    super('Proof queued: three owned checks active or prior task custody unresolved');
  }
}

function originalCommandHasInputs(argv: string[]): boolean {
  const text = argv.join(' ');
  return (
    !/(?:^|[\s/])(?:gate(?:857)?|root-check|remote-check)(?:\.[cm]?[jt]s)?(?:\s|$)/i.test(text) &&
    /(?:\.(?:test|spec)\.[cm]?[jt]sx?|[\w/-]+\.(?:ts|js|sh))(?:[\s'"]|$)/.test(text)
  );
}
