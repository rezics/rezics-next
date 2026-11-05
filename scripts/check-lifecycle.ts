#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { isCheckHostRun } from './check-placement.ts';
import {
  controllerProofReservationPath,
  controllerProofStatePath,
  isCheckId,
  ownershipFromEnvironment,
  readJsonFile,
  remoteRunCustodyPath,
  sameControllerProofBinding,
  validControllerProofRegistration,
  validateControllerProofBinding,
  validateControllerProofReservation,
  validatedRegistryDirectory,
  type CheckRemoteRunCustody,
  type ControllerProofBindingV1,
  type ControllerProofStartV1,
  type ControllerProofState,
} from './check-custody.ts';
import {
  LIFECYCLE_CHILD,
  controlLifecycleChild,
  observeLifecycleChild,
  encodeLifecycleSpec,
  lifecycleSpecFromBinding,
  readLifecycleChildReceipt,
  sha256,
  validateLifecycleGate,
  validateLifecycleReceipt,
  sameLifecycleGate,
  type LifecycleChildReceipt,
  type LifecycleGate,
  type LifecycleProbeSpec,
} from './check-lifecycle-child.ts';
import { readHosts, transportLifecycleControl, type Host } from './remote-check.ts';
import { hostsLocation } from './stack-run.ts';
import {
  observeWorkerCheckTerminal,
  readWorkerCheckHistory,
  readWorkerCheckRecord,
  startControllerWorkerCheck,
  type CheckPhysicalRecord,
  type CheckRecord,
} from './worker-check.ts';

export type LifecycleProbeCommandRequest = Omit<LifecycleProbeSpec, 'version' | 'runtime' | 'childSha256'> & {
  cwd: string;
};
export type StartLifecycleProbeRequest = { binding: ControllerProofBindingV1; observeMs?: number };
export type ReadLifecycleProbeRequest = { binding: ControllerProofBindingV1; physicalRunId: string };
export type ReleaseLifecycleProbeRequest = {
  binding: ControllerProofBindingV1;
  gate: LifecycleGate;
  action?: 'release' | 'cancel';
};
export type WaitLifecycleProbeRequest = ReadLifecycleProbeRequest & { timeoutMs?: number };
export type LifecycleProbeResult = {
  version: 1;
  status: 'running' | 'released' | 'terminal' | 'unavailable';
  binding: ControllerProofBindingV1;
  physicalRunId: string | null;
  custody: 'running' | 'terminal' | 'unknown';
  child?: LifecycleChildReceipt;
  /** Actual command exit, independently recorded by the enclosing runner. Never derived from the requested exit. */
  childExitCode?: 0 | 7;
  wrapperExitCode?: number;
  physicalTerminal: boolean;
  record?: CheckRecord;
  physical?: CheckPhysicalRecord;
  reason?: string;
  failure?: { kind: 'child-infrastructure' | 'wrapper' | 'transport' | 'custody'; reason: string };
};
export type StartLifecycleProbeResult = {
  version: 1;
  admission: ControllerProofStartV1;
  observation: LifecycleProbeResult;
};
export type ReleaseLifecycleProbeResult = {
  version: 1;
  disposition: 'released' | 'cancelled' | 'unavailable';
  receipt?: LifecycleChildReceipt;
  reason?: string;
  custody: 'unknown';
};

/** Build argv BEFORE controller reservation. No token/UUID allocation or authorization is performed here. */
export function lifecycleProbeArgv(request: LifecycleProbeCommandRequest): string[] {
  const { cwd, ...options } = request;
  if (realpathSync(cwd) !== cwd) throw new Error('lifecycle: canonical source cwd required');
  const file = join(cwd, LIFECYCLE_CHILD);
  if (!lstatSync(file).isFile() || realpathSync(file) !== file)
    throw new Error('lifecycle: canonical child source required');
  const packageManager = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).packageManager as string;
  const pinned = spawnSync(
    join(cwd, 'node_modules/.bin/bun'),
    ['--eval', 'console.log(JSON.stringify({version:Bun.version,revision:Bun.revision}))'],
    {
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  if (pinned.error || pinned.status !== 0) throw pinned.error ?? new Error('lifecycle: pinned Bun unavailable');
  const runtime = { packageManager, ...JSON.parse(pinned.stdout.trim()) };
  const spec: LifecycleProbeSpec = { version: 1, ...options, runtime, childSha256: sha256(readFileSync(file)) };
  return ['bun', LIFECYCLE_CHILD, '--probe', encodeLifecycleSpec(spec)];
}

function boundedMs(value: number | undefined, fallback: number, maximum: number): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > maximum)
    throw new Error(`lifecycle: observation bound must be 0..${maximum} ms`);
  return ms;
}
function unavailable(
  binding: ControllerProofBindingV1,
  physicalRunId: string | null,
  reason: string,
): LifecycleProbeResult {
  return {
    version: 1,
    status: 'unavailable',
    binding,
    physicalRunId,
    custody: 'unknown',
    physicalTerminal: false,
    reason,
    failure: { kind: /control transport|connection to/.test(reason) ? 'transport' : 'custody', reason },
  };
}

function boundRecord(request: ReadLifecycleProbeRequest): {
  binding: ControllerProofBindingV1;
  spec: LifecycleProbeSpec;
  record: CheckRecord;
  physical: CheckPhysicalRecord;
} {
  const binding = validateControllerProofBinding(request.binding);
  const spec = lifecycleSpecFromBinding(binding);
  if (!isCheckId(request.physicalRunId)) throw new Error('lifecycle: exact physical generation required');
  const record = readWorkerCheckRecord(binding.checkId, binding.cwd);
  const physical = readWorkerCheckHistory(binding.checkId, request.physicalRunId, binding.cwd);
  const state = readJsonFile<ControllerProofState>(controllerProofStatePath(binding.cwd, binding.checkId));
  const registry = state && validatedRegistryDirectory(state.registry);
  const registration = registry && readJsonFile(join(registry, `${binding.checkId}.${request.physicalRunId}.json`));
  if (
    record.physicalRunId !== request.physicalRunId ||
    !physical ||
    !state ||
    state.phase !== 'intent' ||
    state.physical.length !== 1 ||
    !sameControllerProofBinding(record.controllerProof, binding) ||
    !sameControllerProofBinding(physical.controllerProof, binding) ||
    !validControllerProofRegistration(registration, binding)
  )
    throw new Error('lifecycle: controller/physical custody unavailable or generation changed');
  return { binding, spec, record, physical };
}

function remotePlacement(
  binding: ControllerProofBindingV1,
  physicalRunId: string,
): { custody: CheckRemoteRunCustody; host: Host; run: string } {
  const custody = readJsonFile<CheckRemoteRunCustody>(remoteRunCustodyPath(binding.cwd, physicalRunId));
  if (!custody || custody.version !== 1 || custody.physicalRunId !== physicalRunId || custody.attempts.length !== 1)
    throw new Error('lifecycle: selected remote physical placement unavailable');
  const attempt = custody.attempts[0]!;
  const location = hostsLocation(binding.cwd, process.env);
  if (!('file' in location)) throw new Error('lifecycle: configured control transport unavailable');
  const host = readHosts(location.file).find((candidate) => candidate.name === attempt.host);
  if (!host || !['a', 'b'].includes(host.name)) throw new Error('lifecycle: selected control host unavailable');
  return { custody, host, run: attempt.id };
}

function matchesSpec(
  receipt: LifecycleChildReceipt,
  spec: LifecycleProbeSpec,
  physical: string,
  remote: string | null,
): void {
  validateLifecycleReceipt(receipt);
  if (
    encodeLifecycleSpec(receipt.evidence.gate.spec) !== encodeLifecycleSpec(spec) ||
    receipt.evidence.gate.physicalRunId !== physical ||
    receipt.evidence.gate.remoteRunId !== remote
  )
    throw new Error('lifecycle: returned child does not bind selected physical execution');
}
function foregroundLogTail(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('lifecycle: foreground log unavailable');
    const bytes = Buffer.alloc(Math.min(stat.size, 65_536));
    const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length));
    return bytes.subarray(0, count).toString();
  } finally {
    closeSync(fd);
  }
}

/** Read one logical/physical identity, never scan history or relaunch a lost child. */
export async function readLifecycleProbe(request: ReadLifecycleProbeRequest): Promise<LifecycleProbeResult> {
  const binding = validateControllerProofBinding(request.binding);
  lifecycleSpecFromBinding(binding);
  try {
    const { spec, record, physical } = boundRecord(request);
    const placed = physical.remoteExpected ? remotePlacement(binding, request.physicalRunId) : undefined;
    if (!placed && (!isCheckHostRun(binding.cwd) || record.runnerHost !== hostname()))
      throw new Error('lifecycle: physical command placement not yet established');
    let child: LifecycleChildReceipt | undefined;
    const remoteTerminal =
      !placed ||
      (placed.custody.status === 'terminal' &&
        placed.custody.attempts.every((attempt) => attempt.status === 'terminal'));
    if (record.status === 'finished' && remoteTerminal) {
      child = readLifecycleChildReceipt(binding.cwd, request.physicalRunId);
      if (!child) throw new Error('lifecycle: immutable returned child receipt unavailable');
    } else {
      // Caller-local receipts cannot establish a remote live child or release its gate.
      child = placed
        ? validateLifecycleReceipt(
            JSON.parse(
              await transportLifecycleControl(placed.host, placed.run, {
                version: 1,
                operation: 'observe',
                spec,
                physicalRunId: request.physicalRunId,
                remoteRunId: placed.run,
              }),
            ),
          )
        : await observeLifecycleChild(binding.cwd, {
            version: 1,
            operation: 'observe',
            spec,
            physicalRunId: request.physicalRunId,
            remoteRunId: null,
          });
    }
    matchesSpec(child, spec, request.physicalRunId, placed?.run ?? null);
    if (!placed && child.evidence.gate.host !== record.runnerHost) throw new Error('lifecycle: child host mismatch');
    const proof =
      record.status === 'finished'
        ? await observeWorkerCheckTerminal(binding.checkId, binding.cwd, request.physicalRunId)
        : undefined;
    const result: LifecycleProbeResult = {
      version: 1,
      status: 'unavailable',
      binding,
      physicalRunId: request.physicalRunId,
      custody: 'unknown',
      physicalTerminal: Boolean(proof),
      child,
      record,
      physical: proof ? readWorkerCheckHistory(binding.checkId, request.physicalRunId, binding.cwd) : physical,
      ...(record.exitCode === undefined ? {} : { wrapperExitCode: record.exitCode }),
    };
    if (child.state === 'running' && record.status === 'running') {
      result.status = 'running';
      result.custody = 'running';
    } else if (child.state === 'released' && record.status === 'running') {
      result.status = 'released';
    } else if (child.state === 'child-result' && record.status === 'finished') {
      const native = record.physicalRun;
      const log = foregroundLogTail(join(binding.cwd, record.log));
      const exactLine = 'lifecycle: ' + JSON.stringify(child);
      const nativeMatches =
        !placed ||
        (native?.host === placed.host.name &&
          native.run === placed.run &&
          native.exitCode === spec.exitCode &&
          !native.lifetimeFailure);
      if (
        record.exitCode === spec.exitCode &&
        nativeMatches &&
        log.split('\n').filter((line) => line === exactLine).length === 1
      ) {
        result.childExitCode = spec.exitCode;
        if (proof) {
          result.status = 'terminal';
          result.custody = 'terminal';
        } else result.reason = 'lifecycle: child exited; enclosing whole-tree terminal custody unknown';
      } else result.reason = 'lifecycle: child receipt, native exit, wrapper or foreground log disagree';
    } else result.reason = child.reason ?? 'lifecycle: wrapper or child terminal result unavailable';
    if (result.reason)
      result.failure = {
        kind:
          child.state === 'infrastructure-failure'
            ? 'child-infrastructure'
            : result.reason.includes('disagree')
              ? 'wrapper'
              : 'custody',
        reason: result.reason,
      };
    return result;
  } catch (error) {
    return unavailable(binding, request.physicalRunId, error instanceof Error ? error.message : String(error));
  }
}

export async function startLifecycleProbe(request: StartLifecycleProbeRequest): Promise<StartLifecycleProbeResult> {
  const binding = validateControllerProofBinding(request.binding);
  lifecycleSpecFromBinding(binding);
  const observeMs = boundedMs(request.observeMs, 5_000, 5_000);
  const admission = await startControllerWorkerCheck(binding);
  let observation = unavailable(
    binding,
    null,
    admission.outcome === 'refused-never-started' || admission.outcome === 'unavailable'
      ? admission.reason
      : 'child has not published running identity',
  );
  if (admission.outcome === 'started' || admission.outcome === 'replayed') {
    const deadline = performance.now() + observeMs;
    do {
      const head = readWorkerCheckRecord(binding.checkId, binding.cwd);
      if (head.physicalRunId) observation = await readLifecycleProbe({ binding, physicalRunId: head.physicalRunId });
      if (
        observation.status === 'running' ||
        observation.status === 'terminal' ||
        head.status === 'finished' ||
        performance.now() >= deadline
      )
        break;
      await Bun.sleep(Math.min(250, Math.max(0, deadline - performance.now())));
    } while (performance.now() < deadline);
  }
  return { version: 1, admission, observation };
}

export async function releaseLifecycleProbe(
  request: ReleaseLifecycleProbeRequest,
): Promise<ReleaseLifecycleProbeResult> {
  try {
    const gate = validateLifecycleGate(request.gate);
    const { binding, spec, physical, record } = boundRecord({
      binding: request.binding,
      physicalRunId: gate.physicalRunId,
    });
    const owner = ownershipFromEnvironment(process.env);
    if (!owner || owner.taskId !== binding.taskId || owner.attempt !== binding.attempt)
      throw new Error('lifecycle: current owner attempt mismatch');
    const state = readJsonFile<ControllerProofState>(controllerProofStatePath(binding.cwd, binding.checkId));
    if (!state) throw new Error('lifecycle: proof custody unavailable');
    const reservation = validateControllerProofReservation(
      readJsonFile(controllerProofReservationPath(state.registry, binding.token)),
    );
    if (reservation.state !== 'reserved' || !sameControllerProofBinding(reservation.binding, binding))
      throw new Error('lifecycle: reservation revoked or replaced');
    if (encodeLifecycleSpec(spec) !== encodeLifecycleSpec(gate.spec)) throw new Error('lifecycle: foreign caller gate');
    const action = request.action ?? 'release';
    if (action !== 'release' && action !== 'cancel') throw new Error('lifecycle: unsupported release action');
    const placed = physical.remoteExpected ? remotePlacement(binding, gate.physicalRunId) : undefined;
    if (!placed && (!isCheckHostRun(binding.cwd) || record.runnerHost !== hostname()))
      throw new Error('lifecycle: selected execution host unavailable');
    let receipt: LifecycleChildReceipt;
    if (record.status === 'finished' && (!placed || placed.custody.status === 'terminal')) {
      const returned = readLifecycleChildReceipt(binding.cwd, gate.physicalRunId, gate);
      if (!returned || returned.action !== action) throw new Error('lifecycle: expired or contradictory release');
      receipt = returned;
    } else {
      const observation = await readLifecycleProbe({ binding, physicalRunId: gate.physicalRunId });
      if (!observation.child || !sameLifecycleGate(observation.child.evidence.gate, gate))
        throw new Error('lifecycle: running identity was not established');
      receipt = placed
        ? validateLifecycleReceipt(
            JSON.parse(
              await transportLifecycleControl(placed.host, placed.run, { version: 1, operation: action, gate }),
            ),
            gate,
          )
        : await controlLifecycleChild(binding.cwd, { version: 1, operation: action, gate });
    }
    matchesSpec(receipt, spec, gate.physicalRunId, placed?.run ?? null);
    if (receipt.action !== action) throw new Error('lifecycle: release acknowledgement unavailable');
    return { version: 1, disposition: action === 'release' ? 'released' : 'cancelled', receipt, custody: 'unknown' };
  } catch (error) {
    return {
      version: 1,
      disposition: 'unavailable',
      custody: 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Finite foreground observation only. Caller loss and timeout preserve the same incarnation and unknown custody. */
export async function waitLifecycleProbe(request: WaitLifecycleProbeRequest): Promise<LifecycleProbeResult> {
  const timeout = boundedMs(request.timeoutMs, 30_000, 60_000);
  const deadline = performance.now() + timeout;
  let result: LifecycleProbeResult;
  do {
    result = await readLifecycleProbe(request);
    if (result.status === 'terminal' || result.physicalTerminal || performance.now() >= deadline) return result;
    await Bun.sleep(Math.min(250, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  return result;
}

if (import.meta.main) {
  try {
    const [operation, file, ...extra] = process.argv.slice(2);
    if (!file || extra.length || !['argv', 'start', 'read', 'release', 'wait'].includes(operation ?? ''))
      throw new Error(
        'Usage: bun scripts/check-lifecycle.ts <argv|start|read|release|wait> <absolute-private-request.json>',
      );
    if (
      !file.startsWith('/') ||
      !lstatSync(file).isFile() ||
      realpathSync(file) !== file ||
      lstatSync(file).size > 24_000
    )
      throw new Error('lifecycle: bounded physical request file required');
    const request = JSON.parse(readFileSync(file, 'utf8'));
    const result =
      operation === 'argv'
        ? lifecycleProbeArgv(request)
        : operation === 'start'
          ? await startLifecycleProbe(request)
          : operation === 'read'
            ? await readLifecycleProbe(request)
            : operation === 'release'
              ? await releaseLifecycleProbe(request)
              : await waitLifecycleProbe(request);
    console.log(JSON.stringify(result));
    if (operation === 'wait') {
      const terminal = result as LifecycleProbeResult;
      if (terminal.record)
        console.log(
          `check: id ${terminal.binding.checkId}\ncheck: physical ${terminal.physicalRunId}\ncheck: exit status ${terminal.status === 'terminal' ? terminal.childExitCode : 75}\ncheck: log ${terminal.record.log}`,
        );
      process.exit(terminal.status === 'terminal' ? terminal.childExitCode! : 75);
    }
    if (operation === 'release' && (result as ReleaseLifecycleProbeResult).disposition === 'unavailable')
      process.exit(75);
    if (operation === 'read' && (result as LifecycleProbeResult).status === 'unavailable') process.exit(75);
    if (operation === 'start') {
      const admission = (result as StartLifecycleProbeResult).admission;
      if (admission.outcome === 'refused-never-started') process.exit(1);
      if (admission.outcome === 'unavailable') process.exit(75);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(75);
  }
}
