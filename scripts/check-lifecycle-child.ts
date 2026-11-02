#!/usr/bin/env bun
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { isCheckId, processIdentity, sameProcess, validateRunnerIdentity, validateControllerProofBinding, type ControllerProofBindingV1, type RunnerIdentity } from './check-custody.ts';

export const LIFECYCLE_CHILD = 'scripts/check-lifecycle-child.ts';
export const LIFECYCLE_MAX_MS = 120_000;
export const LIFECYCLE_MAX_BYTES = 16_384;
export type LifecycleRuntimePin = { packageManager: string; version: string; revision: string };
export type LifecycleProbeSpec = {
  version: 1;
  checkId: string;
  taskId: string;
  attempt: number;
  sourceCommit: string;
  sourceTree: string;
  nonce: string;
  exitCode: 0 | 7;
  lifetimeMs: number;
  runtime: LifecycleRuntimePin;
  childSha256: string;
};
export type LifecycleGate = {
  spec: LifecycleProbeSpec;
  physicalRunId: string;
  host: string;
  remoteRunId: string | null;
  child: RunnerIdentity;
};
export type LifecycleChildEvidence = {
  gate: LifecycleGate;
  runtime: LifecycleRuntimePin & { execPath: string; executableSha256: string; pinnedExecutableSha256: string };
  source: { commit: string; tree: string; childSha256: string };
  port: number;
  startedAt: string;
  expiresAt: string;
};
export type LifecycleChildReceipt = {
  version: 1;
  state: 'running' | 'released' | 'child-result' | 'infrastructure-failure';
  evidence: LifecycleChildEvidence;
  action?: 'release' | 'cancel';
  exitCode?: 0 | 7;
  reason?: string;
};
export type LifecycleControl = { version: 1; operation: 'read' | 'release' | 'cancel'; gate: LifecycleGate };
export type LifecycleObserveControl = { version: 1; operation: 'observe'; spec: LifecycleProbeSpec; physicalRunId: string; remoteRunId: string | null };
export type LifecycleHostControl = LifecycleControl | LifecycleObserveControl;

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('lifecycle: invalid closed object');
  return value as Record<string, unknown>;
}
export function sha256(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export function validateLifecycleSpec(value: unknown): LifecycleProbeSpec {
  const item = object(value, ['version', 'checkId', 'taskId', 'attempt', 'sourceCommit', 'sourceTree', 'nonce', 'exitCode', 'lifetimeMs', 'runtime', 'childSha256']);
  const runtime = object(item.runtime, ['packageManager', 'version', 'revision']);
  if (item.version !== 1 || !isCheckId(item.checkId) || !isCheckId(item.taskId) ||
    !Number.isSafeInteger(item.attempt) || Number(item.attempt) < 1 ||
    !revision(item.sourceCommit) || !revision(item.sourceTree) || item.sourceCommit.length !== item.sourceTree.length ||
    !hash(item.nonce) || !hash(item.childSha256) || (item.exitCode !== 0 && item.exitCode !== 7) ||
    !Number.isSafeInteger(item.lifetimeMs) || Number(item.lifetimeMs) < 100 || Number(item.lifetimeMs) > LIFECYCLE_MAX_MS ||
    typeof runtime.packageManager !== 'string' || !/^bun@[\w.+-]{1,100}$/.test(runtime.packageManager) ||
    typeof runtime.version !== 'string' || !/^[\w.+-]{1,100}$/.test(runtime.version) ||
    typeof runtime.revision !== 'string' || !/^[a-f0-9]{7,64}$/.test(runtime.revision)) throw new Error('lifecycle: invalid bounded probe');
  return {
    version: 1, checkId: item.checkId, taskId: item.taskId, attempt: Number(item.attempt),
    sourceCommit: item.sourceCommit, sourceTree: item.sourceTree, nonce: item.nonce,
    exitCode: item.exitCode, lifetimeMs: Number(item.lifetimeMs), childSha256: item.childSha256,
    runtime: { packageManager: runtime.packageManager, version: runtime.version, revision: runtime.revision },
  };
}

export function encodeLifecycleSpec(value: LifecycleProbeSpec): string {
  return Buffer.from(JSON.stringify(validateLifecycleSpec(value))).toString('base64url');
}
export function decodeLifecycleSpec(encoded: string): LifecycleProbeSpec {
  if (encoded.length > 4096 || !/^[\w-]+$/.test(encoded)) throw new Error('lifecycle: invalid probe encoding');
  const result = validateLifecycleSpec(JSON.parse(Buffer.from(encoded, 'base64url').toString()));
  if (encodeLifecycleSpec(result) !== encoded) throw new Error('lifecycle: noncanonical probe encoding');
  return result;
}
/** Recognition grants no admission or local placement. Only this exact fixed operation is supported. */
export function lifecycleSpecFromArgv(argv: readonly string[]): LifecycleProbeSpec | undefined {
  if (argv.length !== 4 || argv[0] !== 'bun' || argv[1] !== LIFECYCLE_CHILD || argv[2] !== '--probe') return undefined;
  return decodeLifecycleSpec(argv[3]!);
}
export function lifecycleSpecFromBinding(value: ControllerProofBindingV1): LifecycleProbeSpec {
  const binding = validateControllerProofBinding(value);
  const spec = lifecycleSpecFromArgv(binding.argv);
  if (!spec || spec.checkId !== binding.checkId || spec.taskId !== binding.taskId || spec.attempt !== binding.attempt ||
    spec.sourceCommit !== binding.sourceCommit || spec.sourceTree !== binding.sourceTree) throw new Error('lifecycle: reservation does not bind this probe');
  return spec;
}
export function lifecycleExecutionSpec(argv: readonly string[]): LifecycleProbeSpec | undefined {
  if (argv[0] !== 'bun' || argv.length !== 6 || argv[4] !== '--physical' || !isCheckId(argv[5])) return undefined;
  return lifecycleSpecFromArgv(['bun', ...argv.slice(1, 4)]);
}

export function validateLifecycleGate(value: unknown): LifecycleGate {
  const item = object(value, ['spec', 'physicalRunId', 'host', 'remoteRunId', 'child']);
  const spec = validateLifecycleSpec(item.spec);
  object(item.child, ['pid', 'start', 'boot', 'group']);
  const child = validateRunnerIdentity(item.child);
  if (!isCheckId(item.physicalRunId) || typeof item.host !== 'string' || item.host.length < 1 || item.host.length > 255 ||
    (item.remoteRunId !== null && (typeof item.remoteRunId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(item.remoteRunId))))
    throw new Error('lifecycle: invalid physical gate');
  return { spec, physicalRunId: item.physicalRunId, host: item.host, remoteRunId: item.remoteRunId as string | null, child };
}
export function sameLifecycleGate(left: unknown, right: LifecycleGate): boolean {
  try {
    const a = Buffer.from(JSON.stringify(validateLifecycleGate(left)));
    const b = Buffer.from(JSON.stringify(validateLifecycleGate(right)));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
export function validateLifecycleControl(value: unknown): LifecycleControl {
  const item = object(value, ['version', 'operation', 'gate']);
  if (item.version !== 1 || !['read', 'release', 'cancel'].includes(String(item.operation))) throw new Error('lifecycle: invalid operation');
  return { version: 1, operation: item.operation as LifecycleControl['operation'], gate: validateLifecycleGate(item.gate) };
}
export function validateLifecycleHostControl(value: unknown): LifecycleHostControl {
  if ((value as LifecycleObserveControl)?.operation !== 'observe') return validateLifecycleControl(value);
  const item = object(value, ['version', 'operation', 'spec', 'physicalRunId', 'remoteRunId']);
  if (item.version !== 1 || !isCheckId(item.physicalRunId) || (item.remoteRunId !== null &&
    (typeof item.remoteRunId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(item.remoteRunId)))) throw new Error('lifecycle: invalid observation placement');
  return { version: 1, operation: 'observe', spec: validateLifecycleSpec(item.spec), physicalRunId: item.physicalRunId, remoteRunId: item.remoteRunId as string | null };
}

export function lifecycleDirectory(physicalRunId: string): string {
  if (!isCheckId(physicalRunId)) throw new Error('lifecycle: invalid physical identity');
  return `.temp/goal/checks/lifecycle/${physicalRunId}`;
}
/** Every ancestor is physical. Never follow a gate symlink, including a replaced parent directory. */
function directory(root: string, physicalRunId: string, create = false): string {
  let current = resolve(root);
  if (realpathSync(current) !== current) throw new Error('lifecycle: noncanonical root');
  for (const part of lifecycleDirectory(physicalRunId).split('/')) {
    current = join(current, part);
    if (create) { try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    if (!lstatSync(current).isDirectory() || realpathSync(current) !== current) throw new Error('lifecycle: unsafe gate directory');
  }
  return current;
}
function readReceipt(root: string, physical: string, name: string): LifecycleChildReceipt | undefined {
  let fd: number | undefined;
  try {
    const file = join(directory(root, physical), name);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIFECYCLE_MAX_BYTES) throw new Error('lifecycle: unsafe receipt');
    return JSON.parse(readFileSync(fd, 'utf8')) as LifecycleChildReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function saveReceipt(root: string, receipt: LifecycleChildReceipt, name: string): void {
  const parent = directory(root, receipt.evidence.gate.physicalRunId);
  const bytes = JSON.stringify(receipt) + '\n';
  if (Buffer.byteLength(bytes) > LIFECYCLE_MAX_BYTES) throw new Error('lifecycle: receipt too large');
  const fd = openSync(join(parent, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(parent, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export function validateLifecycleReceipt(value: unknown, gate?: LifecycleGate): LifecycleChildReceipt {
  if (!value || typeof value !== 'object') throw new Error('lifecycle: missing receipt');
  const r = value as LifecycleChildReceipt;
  const evidence = r.evidence;
  if (r.version !== 1 || !['running', 'released', 'child-result', 'infrastructure-failure'].includes(r.state) || !evidence)
    throw new Error('lifecycle: invalid child receipt');
  const actualGate = validateLifecycleGate(evidence.gate);
  if (gate && !sameLifecycleGate(actualGate, gate)) throw new Error('lifecycle: receipt gate mismatch');
  const pin = actualGate.spec.runtime;
  if (!evidence.runtime || !hash(evidence.runtime.executableSha256) || !hash(evidence.runtime.pinnedExecutableSha256) ||
    typeof evidence.runtime.execPath !== 'string' || !evidence.runtime.execPath.startsWith('/') ||
    !evidence.source || !revision(evidence.source.commit) || !revision(evidence.source.tree) || !hash(evidence.source.childSha256) ||
    !Number.isInteger(evidence.port) || evidence.port < 0 || evidence.port > 65535 ||
    !Number.isFinite(Date.parse(evidence.startedAt)) || !Number.isFinite(Date.parse(evidence.expiresAt)) ||
    Date.parse(evidence.expiresAt) - Date.parse(evidence.startedAt) !== actualGate.spec.lifetimeMs)
    throw new Error('lifecycle: invalid child evidence');
  if (r.state !== 'infrastructure-failure' && (
    evidence.runtime.packageManager !== pin.packageManager || evidence.runtime.version !== pin.version || evidence.runtime.revision !== pin.revision ||
    evidence.runtime.executableSha256 !== evidence.runtime.pinnedExecutableSha256 ||
    evidence.source.commit !== actualGate.spec.sourceCommit || evidence.source.tree !== actualGate.spec.sourceTree ||
    evidence.source.childSha256 !== actualGate.spec.childSha256 || evidence.port === 0)) throw new Error('lifecycle: child pin mismatch');
  if (r.state === 'released' && !['release', 'cancel'].includes(r.action ?? '')) throw new Error('lifecycle: missing release action');
  if (r.state === 'child-result' && (r.exitCode !== actualGate.spec.exitCode || r.action !== 'release')) throw new Error('lifecycle: invalid child result');
  if (r.state !== 'child-result' && r.exitCode !== undefined) throw new Error('lifecycle: infrastructure is not a child exit');
  return r;
}
export function readLifecycleChildReceipt(root: string, physical: string, gate?: LifecycleGate): LifecycleChildReceipt | undefined {
  const r = readReceipt(root, physical, 'terminal.json') ?? readReceipt(root, physical, 'release.json') ?? readReceipt(root, physical, 'ready.json');
  if (!r) return undefined;
  const result = validateLifecycleReceipt(r, gate);
  if (result.evidence.gate.physicalRunId !== physical) throw new Error('lifecycle: wrong receipt generation');
  return result;
}

/** Loopback RPC is reached only by the selected host's fixed control command, never by a caller-local gate file. */
export async function controlLifecycleChild(root: string, value: LifecycleControl): Promise<LifecycleChildReceipt> {
  const request = validateLifecycleControl(value);
  const receipt = readLifecycleChildReceipt(root, request.gate.physicalRunId, request.gate);
  if (!receipt) throw new Error('lifecycle: child observation unavailable');
  if (receipt.state !== 'running') {
    if (request.operation !== 'read' && receipt.action !== (request.operation === 'release' ? 'release' : 'cancel'))
      throw new Error('lifecycle: contradictory or expired release');
    return receipt;
  }
  if (!sameProcess(request.gate.child)) throw new Error('lifecycle: child identity gone or replaced');
  return await new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port: receipt.evidence.port });
    let bytes = '';
    socket.setTimeout(2_000, () => socket.destroy(new Error('lifecycle: control timeout')));
    socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
    socket.on('error', fail);
    socket.on('data', (chunk) => {
      bytes += chunk.toString();
      if (Buffer.byteLength(bytes) > LIFECYCLE_MAX_BYTES) socket.destroy(new Error('lifecycle: control response too large'));
    });
    socket.on('end', () => {
      try { done(validateLifecycleReceipt(JSON.parse(bytes), request.gate)); } catch (error) { fail(error); }
    });
  });
}
export async function observeLifecycleChild(root: string, value: LifecycleObserveControl): Promise<LifecycleChildReceipt> {
  const request = validateLifecycleHostControl(value);
  if (request.operation !== 'observe') throw new Error('lifecycle: expected observation operation');
  const receipt = readLifecycleChildReceipt(root, request.physicalRunId);
  if (!receipt || encodeLifecycleSpec(receipt.evidence.gate.spec) !== encodeLifecycleSpec(request.spec) ||
    receipt.evidence.gate.remoteRunId !== request.remoteRunId) throw new Error('lifecycle: observation identity unavailable');
  return receipt.state === 'running' ? await controlLifecycleChild(root, { version: 1, operation: 'read', gate: receipt.evidence.gate }) : receipt;
}

function gitIdentity(root: string, expression: string): string {
  const result = spawnSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', '--verify', expression], {
    encoding: 'utf8', timeout: 2_000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  });
  if (result.error || result.status !== 0) throw new Error('lifecycle: child source identity unavailable');
  return result.stdout.trim();
}

export async function runLifecycleChild(spec: LifecycleProbeSpec, physicalRunId: string): Promise<never> {
  spec = validateLifecycleSpec(spec);
  if (!isCheckId(physicalRunId)) throw new Error('lifecycle: missing physical run');
  const root = realpathSync(process.cwd());
  directory(root, physicalRunId, true);
  // A physical incarnation cannot be revived, even after an expired/crashed child.
  const claim = openSync(join(directory(root, physicalRunId), 'claim'), 'wx', 0o600);
  closeSync(claim);
  const child = processIdentity();
  if (!child) throw new Error('lifecycle: child process identity unavailable');
  const runtime = {
    packageManager: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager as string,
    version: Bun.version, revision: Bun.revision, execPath: realpathSync(process.execPath),
    executableSha256: sha256(readFileSync(process.execPath)),
    pinnedExecutableSha256: sha256(readFileSync(join(root, 'node_modules/.bin/bun'))),
  };
  const source = { commit: gitIdentity(root, 'HEAD^{commit}'), tree: gitIdentity(root, 'HEAD^{tree}'), childSha256: sha256(readFileSync(import.meta.path)) };
  const startedAt = new Date().toISOString();
  const evidence: LifecycleChildEvidence = {
    gate: { spec, physicalRunId, host: hostname(), remoteRunId: process.env.REZICS_LIFECYCLE_REMOTE_RUN ?? null, child },
    runtime,
    source,
    port: 0, startedAt, expiresAt: new Date(Date.parse(startedAt) + spec.lifetimeMs).toISOString(),
  };
  let acknowledgedAction: 'release' | 'cancel' | undefined;
  const infra = (reason: string, code: number): never => {
    const receipt: LifecycleChildReceipt = { version: 1, state: 'infrastructure-failure', evidence, reason, ...(acknowledgedAction ? { action: acknowledgedAction } : {}) };
    saveReceipt(root, receipt, 'terminal.json');
    console.log('lifecycle: ' + JSON.stringify(receipt));
    process.exit(code);
  };
  if (runtime.packageManager !== spec.runtime.packageManager || runtime.version !== spec.runtime.version || runtime.revision !== spec.runtime.revision ||
    runtime.executableSha256 !== runtime.pinnedExecutableSha256) infra('child runtime pin mismatch', 78);
  if (evidence.source.commit !== spec.sourceCommit || evidence.source.tree !== spec.sourceTree || evidence.source.childSha256 !== spec.childSha256)
    infra('child source pin mismatch', 78);
  let state: LifecycleChildReceipt = { version: 1, state: 'running', evidence };
  let observations = 0;
  const deadline = performance.now() + spec.lifetimeMs;
  const timer = setTimeout(() => infra('caller gate expired without application result', 124), spec.lifetimeMs);
  process.on('SIGTERM', () => infra('child cancelled by supervisor', 143));
  process.on('SIGINT', () => infra('child cancelled by supervisor', 130));
  let finishing = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let bytes = '';
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      bytes += chunk.toString();
      if (Buffer.byteLength(bytes) > LIFECYCLE_MAX_BYTES) socket.destroy();
    });
    socket.on('end', () => {
      try {
        const request = validateLifecycleControl(JSON.parse(bytes));
        if (!sameLifecycleGate(request.gate, evidence.gate) || !sameProcess(evidence.gate.child)) throw new Error('lifecycle: foreign gate');
        if (++observations > 1024) throw new Error('lifecycle: observation budget exhausted');
        if (performance.now() >= deadline) infra('caller gate expired without application result', 124);
        if (request.operation === 'read') { socket.end(JSON.stringify(state)); return; }
        const action = request.operation === 'release' ? 'release' : 'cancel';
        if (state.action && state.action !== action) throw new Error('lifecycle: contradictory release');
        if (!state.action) {
          acknowledgedAction = action;
          state = { version: 1, state: 'released', evidence, action };
          saveReceipt(root, state, 'release.json');
        }
        socket.end(JSON.stringify(state), () => {
          if (finishing) return;
          finishing = true;
          clearTimeout(timer);
          if (action === 'cancel') infra('caller cancelled child', 125);
          const result: LifecycleChildReceipt = { version: 1, state: 'child-result', evidence, action, exitCode: spec.exitCode };
          saveReceipt(root, result, 'terminal.json');
          // The wrapper independently records the actual OS exit; this line is not terminal physical proof.
          process.stdout.write('lifecycle: ' + JSON.stringify(result) + '\n', () => process.exit(spec.exitCode));
        });
      } catch { socket.end(JSON.stringify({ error: 'lifecycle: request refused' })); }
    });
  });
  server.maxConnections = 4;
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') infra('child endpoint unavailable', 78);
  evidence.port = (address as { port: number }).port;
  saveReceipt(root, state, 'ready.json');
  console.log('lifecycle: ' + JSON.stringify(state));
  return await new Promise<never>(() => {});
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 4 && args[0] === '--probe' && args[2] === '--physical') {
      await runLifecycleChild(decodeLifecycleSpec(args[1]!), args[3]!);
    } else if (args.length === 2 && args[0] === '--control' && args[1]!.length <= 24_000 && /^[\w-]+$/.test(args[1]!)) {
      const request = validateLifecycleHostControl(JSON.parse(Buffer.from(args[1]!, 'base64url').toString()));
      console.log(JSON.stringify(await (request.operation === 'observe' ? observeLifecycleChild(process.cwd(), request) : controlLifecycleChild(process.cwd(), request))));
    } else throw new Error('lifecycle: unsupported fixed child operation');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(75); }
}
