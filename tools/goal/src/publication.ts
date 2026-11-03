import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { migrate } from './db.ts';
import { acquireDirectoryLease, type DirectoryLease } from './lease.ts';
import { groupMembers, processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import {
  dependencyInstallationMatches,
  dependencyKey,
  dependencyStoreMatches,
  installShared,
} from './shared-dependencies.ts';
import { checkPinnedBunInstallation } from './check-compatibility.ts';
import { SqliteManagerInbox } from './inbox.ts';
import type { InboxDocumentReference, ManagerEvent } from './contracts.ts';
import { PublicationLegacyReconciliation } from './publication-legacy.ts';

const HOUR_MS = 60 * 60 * 1000;
const WORKFLOW_DEADLINE_SECONDS = 1800;
const WORKFLOW_GRACE_SECONDS = 30;
const WORKFLOW_BLOBS = [
  { path: 'apps/web/scripts/storybook-deploy.ts', blob: '1f3f1ed73e874b046747870435a668f3861f82cd' },
  { path: 'apps/web/scripts/storybook-build.ts', blob: '80ac41d76f350cda8f1bf33be6d3ac4e44eab292' },
  { path: 'apps/web/scripts/storybook-smoke.ts', blob: 'e01be88891a79d5e217099e676073b45a916d996' },
] as const;

const publicationMigrations = [
  {
    module: 'native-publication',
    version: 1,
    sql: `
      CREATE TABLE publication_inventory (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        digest TEXT NOT NULL,
        body TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        observed_by TEXT NOT NULL,
        observed_session TEXT NOT NULL
      );
      CREATE TABLE publication_authorities (
        id TEXT PRIMARY KEY,
        slot_utc TEXT NOT NULL UNIQUE,
        message_id INTEGER NOT NULL UNIQUE,
        owner_session TEXT NOT NULL,
        document_path TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        document TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL,
        received_by TEXT NOT NULL,
        received_session TEXT NOT NULL,
        invocation_id TEXT UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('received', 'claimed'))
      );
      CREATE TABLE publication_custody (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('publisher', 'capture')),
        state TEXT NOT NULL CHECK (state IN ('preparing', 'launching', 'running', 'unknown', 'terminal')),
        invocation_id TEXT,
        identity TEXT,
        members TEXT NOT NULL,
        evidence_path TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        evidence TEXT NOT NULL,
        created_at TEXT NOT NULL,
        terminal_at TEXT
      );
      CREATE INDEX publication_custody_live ON publication_custody(state, kind);
      CREATE TABLE publication_invocations (
        id TEXT PRIMARY KEY,
        authority_id TEXT NOT NULL UNIQUE REFERENCES publication_authorities(id),
        state TEXT NOT NULL,
        slot_utc TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        worktree TEXT NOT NULL,
        dependency_key TEXT,
        dependency_store TEXT,
        bun_version TEXT,
        bun_executable TEXT,
        argv TEXT,
        cwd TEXT,
        deadline_seconds INTEGER NOT NULL,
        log_path TEXT NOT NULL,
        receipt_path TEXT NOT NULL,
        process_identity TEXT,
        process_members TEXT NOT NULL,
        process_visibility TEXT NOT NULL,
        spawn_intent_at TEXT,
        started_at TEXT,
        ended_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        terminal_cause TEXT,
        live_status TEXT,
        live_commit TEXT,
        live_error TEXT,
        receipt TEXT,
        delivered_at TEXT,
        delivery_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE publication_receipt_deliveries (
        invocation_id TEXT NOT NULL REFERENCES publication_invocations(id),
        manager TEXT NOT NULL,
        inbox_message_id INTEGER,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY (invocation_id, manager)
      );
      CREATE TABLE publication_legacy_cadence (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_started_at TEXT NOT NULL,
        evidence_hash TEXT NOT NULL
      );
    `,
  },
] as const;

export type PublicationActor = { id: string; sessionId: string };
export type PublicationLiveBuild = { commit?: string };
export type PublicationProcessObservation = {
  identity(pid?: number): ProcessIdentity | null;
  same(identity: ProcessIdentity): boolean;
  members(group: number): ProcessIdentity[];
};
export type PreparedPublicationDependencies = {
  key: string;
  store: string;
  bunVersion: string;
  bunExecutable: string;
};
export type PublicationControllerOptions = {
  db: Database;
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  integrationBranch: string;
  operationsManager: string;
  now?: () => number;
  inbox?: SqliteManagerInbox;
  process?: PublicationProcessObservation;
  fetchLiveBuild?: () => Promise<PublicationLiveBuild>;
  workflowBlobs?: readonly { path: string; blob: string }[];
  prepareDependencies?: (
    mainCheckout: string,
    sourceTree: string,
    worktreeRoot: string,
  ) => PreparedPublicationDependencies;
  beforeSpawn?: (invocationId: string) => void;
  afterSpawnIntent?: (invocationId: string) => void;
  afterIdentityRecorded?: (invocationId: string, identity: ProcessIdentity) => void;
};

type Authority = {
  owner?: unknown;
  controller?: unknown;
  decision?: unknown;
  slotUtc?: unknown;
  maximumWorkflowInvocations?: unknown;
  observedDev?: unknown;
  eligibleNewIntegratedSource?: unknown;
  publicBuildRead?: unknown;
  previousPublisher?: unknown;
  conditions?: unknown;
  notAuthorized?: unknown;
  status?: unknown;
  [key: string]: unknown;
};

type InvocationRow = {
  id: string;
  authority_id: string;
  state: string;
  slot_utc: string;
  source_ref: string;
  source_commit: string;
  worktree: string;
  dependency_key: string | null;
  dependency_store: string | null;
  bun_version: string | null;
  bun_executable: string | null;
  argv: string | null;
  cwd: string | null;
  deadline_seconds: number;
  log_path: string;
  receipt_path: string;
  process_identity: string | null;
  process_members: string;
  process_visibility: string;
  spawn_intent_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  signal: string | null;
  terminal_cause: string | null;
  live_status: string | null;
  live_commit: string | null;
  live_error: string | null;
  receipt: string | null;
  delivered_at: string | null;
  delivery_error: string | null;
  created_at: string;
};

type AuthorityRow = {
  id: string;
  slot_utc: string;
  message_id: number;
  owner_session: string;
  document_path: string;
  document_hash: string;
  document: string;
  body: string;
  received_at: string;
  received_by: string;
  received_session: string;
  invocation_id: string | null;
  state: string;
};

type BootstrapInput = {
  version?: unknown;
  visibility?: unknown;
  observedAt?: unknown;
  noUnregisteredPublisherOrCaptureGroups?: unknown;
  records?: unknown;
  historyEvidencePaths?: unknown;
};

type ProcessLikeChild = ChildProcess;

const nativeProcess: PublicationProcessObservation = {
  identity: (pid) => processIdentity(pid),
  same: (identity) => sameProcess(identity),
  members: (group) => groupMembers(group),
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isIdentity(value: unknown): value is ProcessIdentity {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.start === 'string' &&
    /^\d+$/.test(value.start) &&
    typeof value.boot === 'string' &&
    value.boot.length > 0 &&
    Number.isSafeInteger(value.group) &&
    Number(value.group) > 0
  );
}

function normalizedIdentity(identity: ProcessIdentity): ProcessIdentity {
  return { pid: identity.pid, start: identity.start, boot: identity.boot, group: identity.group };
}

function pathWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

function readRegularFile(root: string, relativePath: string): { path: string; text: string; hash: string } {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..'))
    throw new Error('publication evidence path must be a relative path without parent traversal');
  const path = resolve(root, relativePath);
  if (!pathWithin(root, path)) throw new Error('publication evidence path escapes its configured root');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`publication evidence is not a regular file: ${relativePath}`);
  const real = realpathSync(path);
  if (!pathWithin(root, real)) throw new Error('publication evidence resolves outside its configured root');
  const bytes = readFileSync(real);
  return { path: real, text: bytes.toString('utf8'), hash: sha256(bytes) };
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseAuthority(text: string): Authority {
  const value = parseJson(text, 'owner decision');
  if (!isRecord(value)) throw new Error('owner decision must be a JSON object');
  const authority = value as Authority;
  if (
    authority.owner !== 'web' ||
    authority.controller !== 'control-plane' ||
    authority.decision !== 'authorize-one-conditional-normal-hourly-workflow' ||
    authority.maximumWorkflowInvocations !== 1 ||
    typeof authority.slotUtc !== 'string' ||
    typeof authority.observedDev !== 'string' ||
    !/^[0-9a-f]{40}$/.test(authority.observedDev) ||
    !Array.isArray(authority.eligibleNewIntegratedSource) ||
    !authority.eligibleNewIntegratedSource.length ||
    !isRecord(authority.publicBuildRead) ||
    !Array.isArray(authority.conditions) ||
    !Array.isArray(authority.notAuthorized)
  )
    throw new Error('owner decision does not contain the retained single-slot Web publication authority');
  if (
    !isRecord(authority.previousPublisher) ||
    authority.previousPublisher.exit !== 1 ||
    typeof authority.previousPublisher.result !== 'string' ||
    !authority.previousPublisher.result.includes('failed-no-repeat') ||
    typeof authority.previousPublisher.receipt !== 'string'
  )
    throw new Error('owner decision does not preserve the prior failed-no-repeat publisher history');
  if (
    authority.publicBuildRead.url !== 'https://storybook.rezics.com/build.json' ||
    typeof authority.publicBuildRead.checkedAt !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(String(authority.publicBuildRead.commit))
  )
    throw new Error('owner decision does not retain its exact public build metadata observation');
  const slot = Date.parse(authority.slotUtc);
  if (!Number.isFinite(slot) || new Date(slot).toISOString() !== normalizeSlot(authority.slotUtc))
    throw new Error('owner decision slotUtc must be a canonical UTC hour');
  const required = requiredIntegratedCommits(authority);
  if (!required.length) throw new Error('owner decision does not name actual required integrated commits');
  return authority;
}

function normalizeSlot(slotUtc: string): string {
  const parsed = Date.parse(slotUtc);
  if (!Number.isFinite(parsed)) return '';
  const iso = new Date(parsed).toISOString();
  return iso.slice(0, 13) + ':00:00.000Z';
}

function requiredIntegratedCommits(authority: Authority): string[] {
  if (!Array.isArray(authority.eligibleNewIntegratedSource)) return [];
  const commits = authority.eligibleNewIntegratedSource.flatMap((value) => {
    if (typeof value !== 'string') return [];
    const match = value.match(/^([0-9a-f]{40})(?:\s|$)/i);
    return match ? [match[1]!.toLowerCase()] : [];
  });
  return [...new Set(commits)];
}

function managerHasSession(db: Database, managerId: string, sessionId: string): boolean {
  const table = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manager_sessions'").get();
  if (!table) return false;
  const row = db.query('SELECT state FROM manager_sessions WHERE id=?').get(managerId) as { state: string } | null;
  if (!row) return false;
  try {
    const state = JSON.parse(row.state) as { threadId?: unknown; history?: unknown };
    if (state.threadId === sessionId) return true;
    return (
      Array.isArray(state.history) && state.history.some((entry) => isRecord(entry) && entry.threadId === sessionId)
    );
  } catch {
    return false;
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  return env;
}

type CommandResult = { code: number | null; stdout: string; stderr: string; error?: string };
function runSync(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function git(root: string, args: string[]): CommandResult {
  return runSync('git', args, root);
}

function gitValue(root: string, args: string[], label: string): string {
  const result = git(root, args);
  if (result.code !== 0 || result.error)
    throw new Error(`${label}: ${result.error ?? (result.stderr.trim() || `git exited ${result.code}`)}`);
  return result.stdout.trim();
}

function requireCommit(root: string, value: string, label: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value) || git(root, ['cat-file', '-e', `${value}^{commit}`]).code !== 0)
    throw new Error(`${label} is not an available full Git commit`);
  return value.toLowerCase();
}

function isAncestor(root: string, ancestor: string, commit: string): boolean {
  return git(root, ['merge-base', '--is-ancestor', ancestor, commit]).code === 0;
}

function currentHour(now: number): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS;
}

function assertCurrentSlot(authority: Authority, now: number): void {
  const slot = Date.parse(String(authority.slotUtc));
  if (slot !== currentHour(now)) throw new Error('publication authority is outside its ordinary UTC hourly slot');
}

function validDocPath(slotUtc: string, path: string): boolean {
  const date = new Date(Date.parse(slotUtc)).toISOString();
  const dateName = date.slice(0, 10).replace(/-/g, '');
  const hourMinute = date.slice(11, 16).replace(':', '');
  return path === `.temp/goal/web/resume-${dateName}/publication-${hourMinute}-owner-decision.json`;
}

function assertSingleDocument(references: unknown): InboxDocumentReference {
  if (!Array.isArray(references) || references.length !== 1)
    throw new Error('owner decision inbox message must attach exactly one canonical decision document');
  const reference = references[0];
  if (!isRecord(reference) || typeof reference.path !== 'string' || reference.change !== undefined)
    throw new Error('owner decision inbox document reference is malformed');
  return reference as InboxDocumentReference;
}

function processMembersValid(members: unknown): members is ProcessIdentity[] {
  return Array.isArray(members) && members.every(isIdentity);
}

const CANCELLATION_EVIDENCE_PATH = 'control-plane/storybook-duplicate-cancellation.json';
const PRIOR_SUCCESS_RECEIPT_PATH = 'web/resume-20261101/publication-1940.json';

function sameIncarnation(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.start === right.start && left.boot === right.boot;
}

function validateCancelledDuplicate(body: Record<string, unknown>): ProcessIdentity {
  const expected = body.expected;
  const observed = body.observed;
  const observedFields = isRecord(observed) ? observed : undefined;
  const firstPublisher = body.firstPublisher;
  const postSignal = body.postSignalObservation;
  if (
    !isIdentity(expected) ||
    !isIdentity(observed) ||
    !observedFields ||
    !isIdentity(firstPublisher) ||
    !isRecord(postSignal) ||
    body.toolExit !== 130 ||
    body.signal !== 'SIGTERM to exact owned timeout PID only' ||
    body.groupChange !== 'timeout created its own process group after launch identity capture' ||
    body.laterKnownTreeGone !== true ||
    !Number.isSafeInteger(body.toolSession) ||
    Number(body.toolSession) <= 0 ||
    typeof body.at !== 'number' ||
    !Number.isFinite(body.at) ||
    typeof body.observedAt !== 'number' ||
    !Number.isFinite(body.observedAt) ||
    body.observedAt <= body.at ||
    !sameIncarnation(expected, observed) ||
    expected.group === observed.group ||
    expected.group === firstPublisher.group ||
    observed.group !== observed.pid ||
    firstPublisher.pid === observed.pid ||
    firstPublisher.group !== firstPublisher.pid ||
    typeof observedFields.cwd !== 'string' ||
    !observedFields.cwd.endsWith('/apps/web') ||
    typeof observedFields.cmd !== 'string' ||
    !observedFields.cmd.startsWith('timeout --signal=TERM --kill-after=30s 1800s ') ||
    firstPublisher.boot !== observed.boot ||
    BigInt(firstPublisher.start) >= BigInt(observed.start) ||
    postSignal[String(observed.pid)] !== null
  )
    throw new Error('legacy cancelled-publisher identity or cancellation evidence is incomplete or inconsistent');

  for (const [pid, value] of Object.entries(postSignal)) {
    if (value === null) continue;
    if (
      !isRecord(value) ||
      pid !== String(firstPublisher.pid) ||
      value.start !== firstPublisher.start ||
      Number(value.group) !== firstPublisher.group ||
      value.state !== 'S'
    )
      throw new Error('legacy cancelled-publisher post-signal evidence contains an unknown process incarnation');
  }
  return normalizedIdentity(observed);
}

function validatePriorWorkflowReceipt(body: Record<string, unknown>, identity: ProcessIdentity): void {
  if (
    body.state !== 'terminal' ||
    !Number.isInteger(body.exitCode) ||
    typeof body.workflowStartedAt !== 'string' ||
    !Number.isFinite(Date.parse(body.workflowStartedAt)) ||
    typeof body.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(body.finishedAt)) ||
    !/^[0-9a-f]{40}$/i.test(String(body.sourceCommit)) ||
    !Number.isSafeInteger(body.workflowPid) ||
    body.workflowPid !== identity.pid
  )
    throw new Error('legacy workflow receipt PID or terminal evidence does not match its retained process identity');
}

function readLatestProcessState(
  db: Database,
  id: string,
): { state: string; identity: ProcessIdentity | null; members: ProcessIdentity[] } | undefined {
  const row = db.query('SELECT state, identity, members FROM publication_custody WHERE id=?').get(id) as {
    state: string;
    identity: string | null;
    members: string;
  } | null;
  if (!row) return;
  let identity: ProcessIdentity | null = null;
  let members: ProcessIdentity[] = [];
  try {
    if (row.identity) identity = JSON.parse(row.identity) as ProcessIdentity;
  } catch {
    return { state: 'unknown', identity: null, members: [] };
  }
  try {
    members = JSON.parse(row.members) as ProcessIdentity[];
  } catch {
    return { state: 'unknown', identity, members: [] };
  }
  if ((identity && !isIdentity(identity)) || !processMembersValid(members))
    return { state: 'unknown', identity: null, members: [] };
  return { state: row.state, identity, members };
}

function exactMemberSet(left: readonly ProcessIdentity[], right: readonly ProcessIdentity[]): boolean {
  const key = (identity: ProcessIdentity) => `${identity.pid}:${identity.start}:${identity.boot}:${identity.group}`;
  const a = new Set(left.map(key));
  const b = new Set(right.map(key));
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function makeReceiptPath(stateDirectory: string, invocationId: string): string {
  return join(stateDirectory, 'publication', `${invocationId}.receipt.json`);
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

function outputLine(path: string, value: string): void {
  const fd = openSync(path, 'a', 0o600);
  try {
    writeFileSync(fd, `${value}\n`);
  } finally {
    closeSync(fd);
  }
}

export class PublicationController {
  readonly options: PublicationControllerOptions;
  readonly db: Database;
  readonly process: PublicationProcessObservation;
  readonly legacy: PublicationLegacyReconciliation;
  private readonly now: () => number;
  private readonly inbox: SqliteManagerInbox;

  constructor(options: PublicationControllerOptions) {
    this.options = options;
    this.db = options.db;
    this.process = options.process ?? nativeProcess;
    this.now = options.now ?? Date.now;
    this.inbox = options.inbox ?? new SqliteManagerInbox(options.db, options.stateDirectory);
    migrate(this.db, publicationMigrations);
    this.legacy = new PublicationLegacyReconciliation({ ...options, process: this.process }, (path, body) => {
      if (body.toolExit === undefined) return null;
      if (path.replaceAll('\\', '/') !== CANCELLATION_EVIDENCE_PATH)
        throw new Error('unsupported cancellation identity evidence path');
      return validateCancelledDuplicate(body);
    });
  }

  private lease(): DirectoryLease {
    return acquireDirectoryLease(join(this.options.stateDirectory, 'publication', 'custody.lease'));
  }

  receive(messageId: number, actor: PublicationActor): { id: string; slotUtc: string; state: string; replay: boolean } {
    if (!Number.isSafeInteger(messageId) || messageId <= 0)
      throw new Error('publication receive requires an inbox message id');
    if (actor.id !== this.options.operationsManager)
      throw new Error('only the configured operations manager may receive publication authority');
    const lease = this.lease();
    try {
      const existing = this.db
        .query('SELECT id, slot_utc, state FROM publication_authorities WHERE message_id=?')
        .get(messageId) as { id: string; slot_utc: string; state: string } | null;
      const row = this.db
        .query('SELECT manager, event, sender, kind, document_refs FROM manager_inbox WHERE id=?')
        .get(messageId) as {
        manager: string;
        event: string;
        sender: string | null;
        kind: string | null;
        document_refs: string | null;
      } | null;
      if (!row) throw new Error(`publication owner decision inbox message does not exist: ${messageId}`);
      if (row.manager !== actor.id || row.sender !== 'web' || row.kind !== 'decision')
        throw new Error(
          'publication authority must arrive as a durable Web decision addressed to the configured operations manager',
        );
      const event = parseJson(row.event, 'owner decision inbox event');
      if (!isRecord(event) || event.managerId !== actor.id || event.from !== 'web' || event.kind !== 'decision')
        throw new Error('publication inbox event identity is inconsistent with its durable index');
      const ownerSession = safeString(event.senderSessionId);
      if (!ownerSession || !managerHasSession(this.db, 'web', ownerSession))
        throw new Error('owner decision inbox event has no retained authenticated Web provider session provenance');
      const reference = assertSingleDocument(
        row.document_refs ? parseJson(row.document_refs, 'owner decision document refs') : undefined,
      );
      const initial = readRegularFile(this.options.mainCheckout, reference.path);
      const authority = parseAuthority(initial.text);
      const slotUtc = String(authority.slotUtc);
      if (!validDocPath(slotUtc, reference.path))
        throw new Error('owner decision document path does not match its UTC slot provenance');
      if (existing) {
        if (existing.id !== initial.hash || existing.slot_utc !== slotUtc)
          throw new Error('this durable inbox message was already received with different authority bytes');
        return { id: existing.id, slotUtc: existing.slot_utc, state: existing.state, replay: true };
      }
      const slotClaim = this.db.query('SELECT id FROM publication_authorities WHERE slot_utc=?').get(slotUtc) as {
        id: string;
      } | null;
      if (slotClaim) throw new Error(`publication slot already has a retained authority: ${slotClaim.id}`);
      const storedBody = JSON.stringify({
        messageId,
        manager: actor.id,
        sessionId: actor.sessionId,
        owner: 'web',
        ownerSession,
        documentPath: reference.path,
        documentHash: initial.hash,
      });
      const now = new Date(this.now()).toISOString();
      this.db
        .transaction(() => {
          this.db
            .query(`INSERT INTO publication_authorities
          (id, slot_utc, message_id, owner_session, document_path, document_hash, document, body, received_at,
           received_by, received_session, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`)
            .run(
              initial.hash,
              slotUtc,
              messageId,
              ownerSession,
              reference.path,
              initial.hash,
              initial.text,
              storedBody,
              now,
              actor.id,
              actor.sessionId,
            );
        })
        .immediate();
      return { id: initial.hash, slotUtc, state: 'received', replay: false };
    } finally {
      lease.release();
    }
  }

  bootstrap(
    actor: PublicationActor,
    manifestRelativePath = 'publication/bootstrap.json',
  ): { digest: string; records: number; replay: boolean; observedAt: string } {
    if (actor.id !== this.options.operationsManager)
      throw new Error('only the configured operations manager may bootstrap publication custody');
    const lease = this.lease();
    try {
      this.legacy.assertClear();
      const file = readRegularFile(this.options.stateDirectory, manifestRelativePath);
      const value = parseJson(file.text, 'publication custody bootstrap');
      if (!isRecord(value)) throw new Error('publication custody bootstrap must be a JSON object');
      const input = value as BootstrapInput;
      if (
        input.version !== 1 ||
        input.visibility !== 'complete-native-publisher-capture-host-inventory' ||
        input.noUnregisteredPublisherOrCaptureGroups !== true ||
        typeof input.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(input.observedAt)) ||
        !Array.isArray(input.records) ||
        input.records.length === 0
      )
        throw new Error(
          'publication bootstrap needs a complete host inventory, explicit no-unknown attestation, and retained legacy evidence records',
        );
      const digest = file.hash;
      const imported = input.records.map((record, index) => this.importBootstrapRecord(record, index));
      const requiredCustodyPaths = [
        'control-plane/storybook-publication-20261031-2100.json',
        'control-plane/storybook-publication-20261031-2200.json',
        'control-plane/storybook-publication-20261031-2300.json',
        CANCELLATION_EVIDENCE_PATH,
        PRIOR_SUCCESS_RECEIPT_PATH,
      ];
      for (const path of requiredCustodyPaths) {
        const count = imported.filter((record) => record.path.replaceAll('\\', '/') === path).length;
        if (count !== 1)
          throw new Error(`publication bootstrap must import exactly one retained custody record for ${path}`);
      }
      if (
        !Array.isArray(input.historyEvidencePaths) ||
        input.historyEvidencePaths.length === 0 ||
        !input.historyEvidencePaths.every((path) => typeof path === 'string')
      )
        throw new Error(
          'publication bootstrap must retain the cancelled-duplicate and prior owner history evidence paths',
        );
      const historyEvidence = input.historyEvidencePaths.map((path) => {
        const evidence = readRegularFile(this.options.stateDirectory, path as string);
        return { path: path as string, hash: evidence.hash, text: evidence.text };
      });
      const historicalStart = this.assertRequiredBootstrapHistory(historyEvidence);
      const observedAt = new Date(Date.parse(input.observedAt)).toISOString();
      const observedAtMs = Date.parse(observedAt);
      if (observedAtMs > this.now() + 30_000 || this.now() - observedAtMs > 5 * 60_000)
        throw new Error('publication host inventory snapshot must be no more than five minutes old');
      const existing = this.db
        .query('SELECT digest, body, observed_at FROM publication_inventory WHERE singleton=1')
        .get() as { digest: string; body: string; observed_at: string } | null;
      if (existing?.digest === digest)
        return {
          digest,
          records: JSON.parse(existing.body).records.length as number,
          replay: true,
          observedAt: existing.observed_at,
        };
      if (existing && Date.parse(observedAt) <= Date.parse(existing.observed_at))
        throw new Error('publication inventory refresh must be newer than the retained snapshot');
      if (existing) this.assertInventoryRefresh(imported);
      const inventoryBody = JSON.stringify({
        digest,
        manifestPath: manifestRelativePath,
        visibility: input.visibility,
        noUnregisteredPublisherOrCaptureGroups: true,
        observedAt,
        historyEvidence: historyEvidence.map(({ path, hash, text }) => ({ path, hash, text })),
        records: imported.map((record) => ({
          id: record.id,
          kind: record.kind,
          state: record.state,
          path: record.path,
          hash: record.hash,
        })),
      });
      this.db
        .transaction(() => {
          if (existing) {
            this.db
              .query(
                `UPDATE publication_inventory SET digest=?, body=?, observed_at=?, observed_by=?, observed_session=? WHERE singleton=1`,
              )
              .run(digest, inventoryBody, observedAt, actor.id, actor.sessionId);
          } else {
            this.db
              .query(`INSERT INTO publication_inventory(singleton, digest, body, observed_at, observed_by, observed_session)
            VALUES (1, ?, ?, ?, ?, ?)`)
              .run(digest, inventoryBody, observedAt, actor.id, actor.sessionId);
          }
          for (const record of imported) {
            this.db
              .query(`INSERT INTO publication_custody
            (id, kind, state, identity, members, evidence_path, evidence_hash, evidence, created_at, terminal_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
              .run(
                record.id,
                record.kind,
                record.state,
                record.identity ? JSON.stringify(record.identity) : null,
                JSON.stringify(record.members),
                record.path,
                record.hash,
                record.raw,
                observedAt,
                record.state === 'terminal' ? observedAt : null,
              );
          }
          if (historicalStart) {
            const previous = this.db
              .query('SELECT last_started_at FROM publication_legacy_cadence WHERE singleton=1')
              .get() as { last_started_at: string } | null;
            const lastStartedAt =
              previous && Date.parse(previous.last_started_at) > Date.parse(historicalStart)
                ? previous.last_started_at
                : historicalStart;
            this.db
              .query(`INSERT INTO publication_legacy_cadence(singleton, last_started_at, evidence_hash)
            VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET last_started_at=excluded.last_started_at, evidence_hash=excluded.evidence_hash`)
              .run(lastStartedAt, digest);
          }
          for (const prior of this.db
            .query("SELECT id, identity FROM publication_custody WHERE state <> 'terminal'")
            .all() as { id: string; identity: string | null }[]) {
            const identity = prior.identity ? (JSON.parse(prior.identity) as ProcessIdentity) : null;
            const resolved = imported.some(
              (record) => identity && sameIdentity(record.identity, identity) && record.state === 'terminal',
            );
            if (resolved)
              this.db
                .query("UPDATE publication_custody SET state='terminal', terminal_at=? WHERE id=?")
                .run(observedAt, prior.id);
          }
        })
        .immediate();
      return { digest, records: imported.length, replay: false, observedAt };
    } finally {
      lease.release();
    }
  }

  private importBootstrapRecord(
    record: unknown,
    index: number,
  ): {
    id: string;
    kind: 'publisher' | 'capture';
    state: 'terminal' | 'running' | 'unknown';
    path: string;
    hash: string;
    raw: string;
    identity: ProcessIdentity | null;
    members: ProcessIdentity[];
  } {
    if (
      !isRecord(record) ||
      (record.kind !== 'publisher' && record.kind !== 'capture') ||
      typeof record.path !== 'string'
    )
      throw new Error(
        `publication bootstrap record ${index + 1} needs a publisher/capture kind and retained evidence path`,
      );
    const evidence = readRegularFile(this.options.stateDirectory, record.path);
    const body = parseJson(evidence.text, `legacy ${record.kind} evidence`);
    if (!isRecord(body)) throw new Error(`legacy ${record.kind} evidence must be a JSON object`);
    const state = body.state;
    let rawIdentity: unknown = body.process ?? body.launcher ?? body.identity;
    let relatedEvidence: { path: string; hash: string; text: string } | undefined;
    let cancelledDuplicate = false;
    const recordPath = record.path.replaceAll('\\', '/');
    const hasCompanionReference = record.identityEvidencePath !== undefined || record.identityField !== undefined;
    if (hasCompanionReference) {
      if (isIdentity(rawIdentity))
        throw new Error('legacy receipt mixes direct process identity with companion identity evidence');
      if (
        record.kind !== 'publisher' ||
        typeof record.identityEvidencePath !== 'string' ||
        typeof record.identityField !== 'string'
      )
        throw new Error('legacy process companion identity reference is incomplete or unsupported');
      const companionPath = record.identityEvidencePath.replaceAll('\\', '/');
      const cancellationReference =
        recordPath === CANCELLATION_EVIDENCE_PATH &&
        companionPath === CANCELLATION_EVIDENCE_PATH &&
        record.identityField === 'observed';
      const priorWorkflowReference =
        recordPath === PRIOR_SUCCESS_RECEIPT_PATH &&
        companionPath === CANCELLATION_EVIDENCE_PATH &&
        record.identityField === 'firstPublisher';
      if (!cancellationReference && !priorWorkflowReference)
        throw new Error(
          'legacy process companion identity reference does not match a supported retained evidence form',
        );
      relatedEvidence = readRegularFile(this.options.stateDirectory, record.identityEvidencePath);
      const identityBody = parseJson(relatedEvidence.text, 'legacy identity evidence');
      if (!isRecord(identityBody)) throw new Error('legacy process companion identity evidence must be a JSON object');
      if (cancellationReference) {
        rawIdentity = validateCancelledDuplicate(identityBody);
        cancelledDuplicate = true;
      } else {
        const cancellationIdentity = validateCancelledDuplicate(identityBody);
        rawIdentity = identityBody.firstPublisher;
        if (!isIdentity(rawIdentity))
          throw new Error('legacy prior workflow has no complete retained first-publisher identity');
        validatePriorWorkflowReceipt(body, rawIdentity);
        if (sameIdentity(identityBody.firstPublisher, cancellationIdentity))
          throw new Error('legacy cancellation and prior publisher identities are not independently retained');
      }
    }
    if (!isIdentity(rawIdentity))
      throw new Error(`legacy ${record.kind} evidence has no complete PID/start/boot/group identity`);
    const identity = normalizedIdentity(rawIdentity);
    const groupNow = this.observeGroup(identity.group);
    const cancellationExpected = cancelledDuplicate ? body : undefined;
    const expectedGroup =
      cancellationExpected && isIdentity(cancellationExpected.expected)
        ? this.observeGroup(cancellationExpected.expected.group)
        : undefined;
    const workflowReceipt =
      state === 'terminal' &&
      Number.isInteger(body.exitCode) &&
      (typeof body.endedAt === 'string' || typeof body.finishedAt === 'string');
    const terminalReceipt = workflowReceipt || cancelledDuplicate;
    let importedState: 'terminal' | 'running' | 'unknown';
    const allGroupsComplete = groupNow.complete && (!expectedGroup || expectedGroup.complete);
    const allGroupsClear = groupNow.members.length === 0 && (!expectedGroup || expectedGroup.members.length === 0);
    if (terminalReceipt && allGroupsComplete && allGroupsClear) importedState = 'terminal';
    else if (this.process.same(identity) || groupNow.members.length > 0 || (expectedGroup?.members.length ?? 0) > 0)
      importedState = 'running';
    else importedState = 'unknown';
    if (record.kind === 'capture' && state !== 'terminal' && !isRecord(body.capture)) importedState = 'unknown';
    const rawLog = body.log ?? body.logPath;
    if (importedState === 'terminal' && typeof rawLog === 'string') {
      const logPath = resolve(rawLog);
      if (!pathWithin(this.options.stateDirectory, logPath) || !existsSync(logPath) || !lstatSync(logPath).isFile())
        importedState = 'unknown';
    } else if (importedState === 'terminal' && !cancelledDuplicate) importedState = 'unknown';
    const raw = relatedEvidence
      ? JSON.stringify({
          originalEvidence: evidence.text,
          identityEvidencePath: relatedEvidence.path,
          identityEvidenceHash: relatedEvidence.hash,
          identityEvidence: relatedEvidence.text,
        })
      : evidence.text;
    const rawHash = sha256(raw);
    return {
      id: `legacy-${record.kind}-${rawHash}`,
      kind: record.kind,
      state: importedState,
      path: record.path,
      hash: rawHash,
      raw,
      identity,
      members: groupNow.members,
    };
  }

  private assertRequiredBootstrapHistory(history: Array<{ path: string; text: string }>): string | null {
    const normalized = history.map(({ path }) => path.replaceAll('\\', '/'));
    const required = [
      'control-plane/storybook-publication-20261031-2100.json',
      'control-plane/storybook-publication-20261031-2200.json',
      'control-plane/storybook-publication-20261031-2300.json',
      'control-plane/storybook-duplicate-cancellation.json',
      'control-plane/publication-0100-0500-disposition.json',
      'web/resume-20261101/publication-0100-owner-decision.json',
      'web/resume-20261101/publication-1940.json',
    ];
    for (const path of required) {
      if (!normalized.some((candidate) => candidate === path || candidate.endsWith(`/${path}`)))
        throw new Error(`publication bootstrap omitted required prior owner/process history: ${path}`);
    }
    const find = (suffix: string) => history.find((item) => item.path.replaceAll('\\', '/').endsWith(suffix));
    const failed = find('control-plane/storybook-publication-20261031-2300.json');
    const duplicate = find('control-plane/storybook-duplicate-cancellation.json');
    const owner = find('web/resume-20261101/publication-0100-owner-decision.json');
    const disposition = find('control-plane/publication-0100-0500-disposition.json');
    if (!failed || !duplicate || !owner || !disposition) throw new Error('publication bootstrap history is incomplete');
    const failedBody = parseJson(failed.text, 'prior failed publication receipt');
    const duplicateBody = parseJson(duplicate.text, 'prior duplicate cancellation evidence');
    const ownerBody = parseAuthority(owner.text);
    const dispositionBody = parseJson(disposition.text, 'retained publication disposition');
    if (
      !isRecord(failedBody) ||
      failedBody.state !== 'terminal' ||
      failedBody.exitCode !== 1 ||
      failedBody.result !== 'failed-no-repeat' ||
      failedBody.attempts !== 1 ||
      failedBody.maximumWorkflowInvocations !== 1
    )
      throw new Error('publication bootstrap does not preserve the prior terminal failed-no-repeat publisher receipt');
    if (!isRecord(duplicateBody))
      throw new Error(
        'publication bootstrap does not preserve the cancelled duplicate and original publisher identity',
      );
    validateCancelledDuplicate(duplicateBody);
    if (
      !isRecord(dispositionBody) ||
      dispositionBody.authorityDisposition !== 'unconsumed-retained' ||
      dispositionBody.workflowInvocationsByThisDecision !== 0 ||
      dispositionBody.actual01Handle !== null
    )
      throw new Error('publication bootstrap does not preserve the current unconsumed owner authority disposition');
    if (
      ownerBody.maximumWorkflowInvocations !== 1 ||
      ownerBody.status !== 'conditional decision only; no start, delivery, or acceptance claimed'
    )
      throw new Error('publication bootstrap owner decision is not the retained conditional one-invocation authority');
    let lastStarted = 0;
    for (const evidence of history) {
      const body = parseJson(evidence.text, `publication history ${evidence.path}`);
      if (!isRecord(body)) continue;
      for (const candidate of [body.workflowStartedAt, body.startedAt]) {
        if (typeof candidate !== 'string') continue;
        const parsed = Date.parse(candidate);
        if (Number.isFinite(parsed)) lastStarted = Math.max(lastStarted, parsed);
      }
    }
    return lastStarted ? new Date(lastStarted).toISOString() : null;
  }

  private assertInventoryRefresh(imported: Array<{ identity: ProcessIdentity | null; state: string }>): void {
    const prior = this.db.query("SELECT id, identity FROM publication_custody WHERE state <> 'terminal'").all() as {
      id: string;
      identity: string | null;
    }[];
    for (const row of prior) {
      let identity: ProcessIdentity | null = null;
      try {
        if (row.identity) identity = JSON.parse(row.identity) as ProcessIdentity;
      } catch {}
      if (!identity || !imported.some((record) => sameIdentity(record.identity, identity)))
        throw new Error(`refreshed inventory omitted prior active or unknown custody ${row.id}`);
    }
  }

  private observeGroup(group: number): { members: ProcessIdentity[]; complete: boolean } {
    try {
      const members = this.process.members(group).map(normalizedIdentity);
      return { members, complete: members.every((member) => member.group === group) };
    } catch {
      return { members: [], complete: false };
    }
  }

  registerCapture(
    actor: PublicationActor,
    pid: number,
    evidencePath: string,
  ): { id: string; state: string; members: number } {
    if (actor.id !== this.options.operationsManager)
      throw new Error('only the configured operations manager may register capture custody');
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('capture registration needs a positive PID');
    const lease = this.lease();
    try {
      this.assertAllCustodyClear();
      const identity = this.process.identity(pid);
      if (!identity) throw new Error('capture PID has no visible live process identity');
      if (identity.group !== identity.pid) throw new Error('capture custody must own a detached process group');
      const members = this.observeGroup(identity.group);
      if (
        !members.complete ||
        !this.process.same(identity) ||
        !members.members.some((member) => member.pid === identity.pid && sameIdentity(member, identity))
      )
        throw new Error('capture process group visibility is incomplete or does not contain its recorded leader');
      const source = readRegularFile(this.options.stateDirectory, evidencePath);
      const id = `capture-${randomUUID()}`;
      const event = JSON.stringify({
        kind: 'capture-registration',
        identity,
        members: members.members,
        sourcePath: evidencePath,
        sourceHash: source.hash,
      });
      this.db
        .transaction(() => {
          this.db
            .query(`INSERT INTO publication_custody
          (id, kind, state, identity, members, evidence_path, evidence_hash, evidence, created_at)
          VALUES (?, 'capture', 'running', ?, ?, ?, ?, ?, ?)`)
            .run(
              id,
              JSON.stringify(identity),
              JSON.stringify(members.members),
              evidencePath,
              sha256(event),
              event,
              new Date(this.now()).toISOString(),
            );
        })
        .immediate();
      return { id, state: 'running', members: members.members.length };
    } finally {
      lease.release();
    }
  }

  retireCapture(actor: PublicationActor, custodyId: string, evidencePath: string): { id: string; state: 'terminal' } {
    if (actor.id !== this.options.operationsManager)
      throw new Error('only the configured operations manager may retire capture custody');
    const lease = this.lease();
    try {
      const existing = readLatestProcessState(this.db, custodyId);
      if (!existing || !custodyId.startsWith('capture-')) throw new Error('unknown capture custody identity');
      const evidence = readRegularFile(this.options.stateDirectory, evidencePath);
      const body = parseJson(evidence.text, 'capture terminal evidence');
      if (
        !isRecord(body) ||
        body.kind !== 'capture-terminal' ||
        body.custodyId !== custodyId ||
        body.exitCode === undefined
      )
        throw new Error('capture terminal evidence must name this original custody and exact terminal result');
      if (!existing.identity || !sameIdentity(body.identity, existing.identity))
        throw new Error('capture terminal evidence process identity does not match the original handle');
      const groupNow = this.observeGroup(existing.identity.group);
      if (!groupNow.complete || groupNow.members.length)
        throw new Error('capture group is live or visibility is incomplete; custody remains active');
      this.db
        .transaction(() => {
          this.db
            .query(`UPDATE publication_custody SET state='terminal', members='[]', evidence_path=?, evidence_hash=?, evidence=?, terminal_at=?
          WHERE id=? AND kind='capture' AND state IN ('running','unknown')`)
            .run(evidencePath, evidence.hash, evidence.text, new Date(this.now()).toISOString(), custodyId);
        })
        .immediate();
      return { id: custodyId, state: 'terminal' };
    } finally {
      lease.release();
    }
  }

  async start(authorityId: string, actor: PublicationActor): Promise<Record<string, unknown>> {
    if (actor.id !== this.options.operationsManager)
      throw new Error('only the configured operations manager may start publication');
    const lease = this.lease();
    let invocationId: string | undefined;
    try {
      this.requireBootstrappedInventory();
      const auth = this.authority(authorityId);
      const authority = parseAuthority(auth.document);
      const now = this.now();
      assertCurrentSlot(authority, now);
      const source = this.eligibleSource(authority);
      this.assertCadence(now);
      this.assertAuthorityUnclaimed(auth);
      this.assertAllCustodyClear();
      invocationId = randomUUID();
      const worktree = resolve(this.options.worktreeRoot, 'storybook-publications', invocationId);
      if (!pathWithin(this.options.worktreeRoot, worktree))
        throw new Error('publication worktree escaped its configured worktree root');
      const paths = this.publicationPaths(invocationId);
      const stamp = new Date(now).toISOString();
      const authorityBody = JSON.stringify({ authorityId: auth.id, slotUtc: auth.slot_utc, invocationId });
      this.db
        .transaction(() => {
          this.assertAuthorityUnclaimed(auth);
          this.assertAllCustodyClear();
          this.db
            .query(`INSERT INTO publication_invocations
          (id, authority_id, state, slot_utc, source_ref, source_commit, worktree, deadline_seconds,
           log_path, receipt_path, process_members, process_visibility, created_at)
          VALUES (?, ?, 'preparing', ?, ?, ?, ?, ?, ?, ?, '[]', 'unobserved', ?)`)
            .run(
              invocationId!,
              auth.id,
              auth.slot_utc,
              `refs/heads/${this.options.integrationBranch}`,
              source,
              worktree,
              WORKFLOW_DEADLINE_SECONDS,
              paths.logPath,
              paths.receiptPath,
              stamp,
            );
          this.db
            .query(
              "UPDATE publication_authorities SET state='claimed', invocation_id=? WHERE id=? AND invocation_id IS NULL",
            )
            .run(invocationId!, auth.id);
          this.db
            .query(`INSERT INTO publication_custody
          (id, kind, state, invocation_id, identity, members, evidence_path, evidence_hash, evidence, created_at)
          VALUES (?, 'publisher', 'preparing', ?, NULL, '[]', ?, ?, ?, ?)`)
            .run(
              `publisher-${invocationId!}`,
              invocationId!,
              relative(this.options.stateDirectory, paths.logPath),
              '',
              authorityBody,
              stamp,
            );
        })
        .immediate();
      mkdirSync(dirname(paths.logPath), { recursive: true });
      outputLine(paths.logPath, `Publication invocation ${invocationId} reserved for ${source}`);
      const invocation = this.invocation(invocationId);
      const prepared = await this.prepare(invocation, source);
      this.ensureSourceRefStillCurrent(invocation.source_ref, source);
      this.assertWorkflowBlobs(source);
      const appDirectory = join(invocation.worktree, 'apps/web');
      const bunExecutable = prepared.bunExecutable;
      const argv = [
        'timeout',
        '--signal=TERM',
        `--kill-after=${WORKFLOW_GRACE_SECONDS}s`,
        `${WORKFLOW_DEADLINE_SECONDS}s`,
        bunExecutable,
        'run',
        'storybook:deploy',
        '--force',
      ];
      const cwd = appDirectory;
      this.updatePrepared(invocationId, prepared, argv, cwd);
      this.options.beforeSpawn?.(invocationId);
      this.ensureSourceRefStillCurrent(invocation.source_ref, source);
      this.markSpawnPossible(invocationId, actor);
      this.options.afterSpawnIntent?.(invocationId);
      return await this.spawnAndObserve(this.invocation(invocationId), actor);
    } catch (error) {
      if (invocationId) {
        const row = this.invocation(invocationId);
        if (row && !row.spawn_intent_at) {
          this.finishPreSpawnFailure(row, error);
          void this.deliverReceipt(invocationId).catch(() => {});
        }
      }
      throw error;
    } finally {
      lease.release();
    }
  }

  private prepare(invocation: InvocationRow, source: string): PreparedPublicationDependencies {
    const existingPath = existsSync(invocation.worktree);
    const pathRegistered = git(this.options.mainCheckout, ['worktree', 'list', '--porcelain'])
      .stdout.split('\n')
      .some((line) => line === `worktree ${invocation.worktree}`);
    if (existingPath || pathRegistered) {
      if (!existingPath || !pathRegistered)
        throw new Error('publication worktree path exists without matching Git worktree custody');
      const head = gitValue(
        invocation.worktree,
        ['rev-parse', '--verify', 'HEAD'],
        'reading retained publication worktree HEAD',
      );
      if (head !== source) throw new Error('retained publication worktree does not match its immutable source commit');
      const status = gitValue(
        invocation.worktree,
        ['status', '--porcelain'],
        'checking retained publication source cleanliness',
      );
      if (status) throw new Error('retained publication worktree is dirty; it will not be reset or repaired');
    } else {
      mkdirSync(dirname(invocation.worktree), { recursive: true });
      const added = git(this.options.mainCheckout, ['worktree', 'add', '--detach', invocation.worktree, source]);
      if (added.code !== 0 || added.error)
        throw new Error(`could not create isolated publication source worktree: ${added.error ?? added.stderr.trim()}`);
    }
    this.assertWorkflowBlobs(source);
    const statusBefore = gitValue(
      invocation.worktree,
      ['status', '--porcelain'],
      'checking immutable publication source',
    );
    if (statusBefore) throw new Error('eligible publication source worktree is not clean');
    const prepared = this.options.prepareDependencies
      ? this.options.prepareDependencies(this.options.mainCheckout, invocation.worktree, this.options.worktreeRoot)
      : prepareExactDependencies(this.options.mainCheckout, invocation.worktree, this.options.worktreeRoot);
    const statusAfter = gitValue(
      invocation.worktree,
      ['status', '--porcelain'],
      'checking prepared publication source',
    );
    if (statusAfter) throw new Error('dependency preparation changed tracked publication source files');
    return prepared;
  }

  private publicationPaths(invocationId: string): { logPath: string; receiptPath: string } {
    const root = join(this.options.stateDirectory, 'publication');
    return {
      logPath: join(root, `${invocationId}.log`),
      receiptPath: makeReceiptPath(this.options.stateDirectory, invocationId),
    };
  }

  private eligibleSource(authority: Authority): string {
    const main = resolve(this.options.mainCheckout);
    const source = requireCommit(
      main,
      gitValue(
        main,
        ['rev-parse', `refs/heads/${this.options.integrationBranch}`],
        'reading current integration source',
      ),
      'current integration source',
    );
    const observed = requireCommit(main, String(authority.observedDev), 'authorized observed dev source');
    if (source === observed || !isAncestor(main, observed, source))
      throw new Error('current integration source is not newer than and descended from the authorized dev observation');
    for (const commit of requiredIntegratedCommits(authority)) {
      requireCommit(main, commit, 'required integrated source');
      if (!isAncestor(main, commit, source))
        throw new Error(`eligible dev source is missing required integrated commit ${commit}`);
    }
    return source;
  }

  private ensureSourceRefStillCurrent(ref: string, expected: string): void {
    const current = gitValue(
      this.options.mainCheckout,
      ['rev-parse', '--verify', ref],
      'rechecking publication source ref',
    );
    if (current !== expected) throw new Error('eligible dev source moved while publication custody was being prepared');
  }

  private assertWorkflowBlobs(source: string): void {
    const expected = this.options.workflowBlobs ?? WORKFLOW_BLOBS;
    for (const entry of expected) {
      const actual = gitValue(
        this.options.mainCheckout,
        ['rev-parse', `${source}:${entry.path}`],
        `reading retained workflow blob ${entry.path}`,
      );
      if (actual !== entry.blob) throw new Error(`retained Storybook workflow or smoke changed: ${entry.path}`);
    }
  }

  private assertCadence(now: number): void {
    const previous = this.db
      .query(`SELECT started_at FROM publication_invocations
      WHERE spawn_intent_at IS NOT NULL ORDER BY spawn_intent_at DESC LIMIT 1`)
      .get() as { started_at: string | null } | null;
    const legacy = this.db.query('SELECT last_started_at FROM publication_legacy_cadence WHERE singleton=1').get() as {
      last_started_at: string;
    } | null;
    const values = [previous?.started_at, legacy?.last_started_at].filter((value): value is string => Boolean(value));
    if (!values.length) return;
    const last = Math.max(...values.map((value) => Date.parse(value)));
    if (!Number.isFinite(last) || now - last < HOUR_MS)
      throw new Error('ordinary Storybook publication cadence has not elapsed since the previous workflow invocation');
  }

  private authority(id: string): AuthorityRow {
    const row = this.db.query('SELECT * FROM publication_authorities WHERE id=?').get(id) as AuthorityRow | null;
    if (!row) throw new Error('unknown publication authority; receive the durable Web inbox decision first');
    const current = readRegularFile(this.options.mainCheckout, row.document_path);
    if (current.hash !== row.document_hash || current.text !== row.document)
      throw new Error('received owner decision source changed after durable receiving');
    return row;
  }

  private assertAuthorityUnclaimed(auth: AuthorityRow): void {
    const row = this.db.query('SELECT invocation_id, state FROM publication_authorities WHERE id=?').get(auth.id) as {
      invocation_id: string | null;
      state: string;
    } | null;
    if (!row) throw new Error('publication authority disappeared before its claim');
    if (row.invocation_id || row.state !== 'received')
      throw new Error(
        `publication authority is already reserved by its original invocation ${row.invocation_id ?? '(unknown)'}`,
      );
  }

  private requireBootstrappedInventory(): void {
    this.legacy.assertClear();
    const inventory = this.db
      .query('SELECT digest, body, observed_at FROM publication_inventory WHERE singleton=1')
      .get() as { digest: string; body: string; observed_at: string } | null;
    if (!inventory)
      throw new Error('native publisher/capture inventory is unknown; authenticated publication bootstrap is required');
    let body: unknown;
    try {
      body = JSON.parse(inventory.body) as unknown;
    } catch {
      throw new Error('native publisher/capture inventory record is malformed');
    }
    if (
      !isRecord(body) ||
      body.digest !== inventory.digest ||
      body.visibility !== 'complete-native-publisher-capture-host-inventory' ||
      body.noUnregisteredPublisherOrCaptureGroups !== true
    )
      throw new Error('native publisher/capture inventory is incomplete or malformed');
    const age = this.now() - Date.parse(inventory.observed_at);
    if (!Number.isFinite(age) || age < -30_000 || age > 5 * 60_000)
      throw new Error(
        'native publisher/capture inventory is stale; refresh the authenticated host census before publication',
      );
  }

  private assertAllCustodyClear(): void {
    this.requireBootstrappedInventory();
    const allRows = this.db
      .query('SELECT id, kind, state, invocation_id, identity, members, evidence_path FROM publication_custody')
      .all() as {
      id: string;
      kind: string;
      state: string;
      invocation_id: string | null;
      identity: string | null;
      members: string;
      evidence_path: string;
    }[];
    if (!allRows.length)
      throw new Error(
        'native custody inventory has no retained legacy evidence; an empty registry cannot prove absence',
      );
    for (const row of allRows) {
      if (row.state === 'unknown' || row.state === 'preparing' || row.state === 'launching')
        throw new Error(`${row.kind} custody ${row.id} is ${row.state}; launch is refused`);
      let identity: ProcessIdentity | null;
      let known: ProcessIdentity[];
      try {
        identity = row.identity ? (JSON.parse(row.identity) as ProcessIdentity) : null;
        known = JSON.parse(row.members) as ProcessIdentity[];
      } catch {
        throw new Error(`${row.kind} custody ${row.id} has malformed process ownership`);
      }
      const retainedEvidence = this.db
        .query('SELECT evidence_hash, evidence FROM publication_custody WHERE id=?')
        .get(row.id) as { evidence_hash: string; evidence: string } | null;
      if (!retainedEvidence || sha256(retainedEvidence.evidence) !== retainedEvidence.evidence_hash)
        throw new Error(`${row.kind} custody ${row.id} retained evidence is missing or corrupt`);
      if (!identity && row.kind === 'publisher' && row.state === 'terminal' && row.invocation_id) {
        const invocation = this.db
          .query('SELECT spawn_intent_at, receipt FROM publication_invocations WHERE id=?')
          .get(row.invocation_id) as { spawn_intent_at: string | null; receipt: string | null } | null;
        let receipt: unknown;
        try {
          receipt = invocation?.receipt ? (JSON.parse(invocation.receipt) as unknown) : undefined;
        } catch {}
        if (
          isRecord(receipt) &&
          receipt.process === null &&
          receipt.success === false &&
          ((invocation?.spawn_intent_at === null &&
            receipt.terminalCause === 'preparation-failed-before-workflow-spawn' &&
            receipt.workflowInvocationCount === 0) ||
            (invocation?.spawn_intent_at !== null &&
              receipt.terminalCause === 'spawn-error-after-once-only-intent' &&
              receipt.workflowInvocationCount === 0))
        )
          continue;
      }
      if (!identity || !isIdentity(identity) || !processMembersValid(known))
        throw new Error(`${row.kind} custody ${row.id} has incomplete process ownership`);
      if (row.kind === 'publisher' && row.evidence_path.replaceAll('\\', '/') === CANCELLATION_EVIDENCE_PATH) {
        const wrapper = parseJson(retainedEvidence.evidence, 'retained cancelled-publisher evidence wrapper');
        if (!isRecord(wrapper) || typeof wrapper.identityEvidence !== 'string')
          throw new Error(`publisher custody ${row.id} lost its companion cancellation evidence`);
        const cancellation = parseJson(wrapper.identityEvidence, 'retained cancelled-publisher identity evidence');
        if (!isRecord(cancellation) || !sameIdentity(validateCancelledDuplicate(cancellation), identity))
          throw new Error(`publisher custody ${row.id} no longer matches its cancelled-publisher identity evidence`);
        const expectedIdentity = cancellation.expected;
        if (!isIdentity(expectedIdentity))
          throw new Error(`publisher custody ${row.id} has incomplete pre-change process-group identity`);
        const originalGroup = this.observeGroup(expectedIdentity.group);
        if (!originalGroup.complete)
          throw new Error(`publisher custody ${row.id} pre-change process-group visibility is incomplete`);
        if (originalGroup.members.length)
          throw new Error(`publisher custody ${row.id} pre-change process group has live or unknown members`);
      }
      const observed = this.observeGroup(identity.group);
      if (!observed.complete) throw new Error(`${row.kind} custody ${row.id} process-group visibility is incomplete`);
      if (observed.members.length) {
        if (!exactMemberSet(observed.members, known))
          throw new Error(`${row.kind} custody ${row.id} has unknown or changed process-group members`);
        if (observed.members.some((member) => this.process.same(member)))
          throw new Error(`${row.kind} custody ${row.id} still has a live original process group`);
        throw new Error(`${row.kind} custody ${row.id} process group remains present with an unknown incarnation`);
      }
      if (this.process.same(identity))
        throw new Error(`${row.kind} custody ${row.id} original process identity is live`);
      if (row.state !== 'terminal') throw new Error(`${row.kind} custody ${row.id} has no retained terminal result`);
    }
  }

  private updatePrepared(
    invocationId: string,
    prepared: PreparedPublicationDependencies,
    argv: string[],
    cwd: string,
  ): void {
    const invocation = this.invocation(invocationId);
    const expectedKey = dependencyKey(invocation.worktree);
    const expectedStore = join(dirname(resolve(this.options.worktreeRoot)), 'dependency-stores', expectedKey);
    if (
      prepared.key !== expectedKey ||
      resolve(prepared.store) !== resolve(expectedStore) ||
      !dependencyStoreMatches(expectedStore, expectedKey)
    )
      throw new Error('prepared publication dependency store does not match the immutable source dependency key');
    if (!pathWithin(invocation.worktree, cwd) || !pathWithin(invocation.worktree, prepared.bunExecutable))
      throw new Error('prepared workflow paths do not belong to the immutable publication worktree');
    const worktreeReal = realpathSync(invocation.worktree);
    if (!pathWithin(worktreeReal, realpathSync(dirname(prepared.bunExecutable))) || !existsSync(prepared.bunExecutable))
      throw new Error('pinned Bun executable is unavailable inside the publication worktree');
    this.db
      .transaction(() => {
        this.db
          .query(`UPDATE publication_invocations SET dependency_key=?, dependency_store=?, bun_version=?, bun_executable=?, argv=?, cwd=?, state='prepared'
        WHERE id=? AND spawn_intent_at IS NULL AND state='preparing'`)
          .run(
            prepared.key,
            prepared.store,
            prepared.bunVersion,
            prepared.bunExecutable,
            JSON.stringify(argv),
            cwd,
            invocationId,
          );
        this.db
          .query(
            "UPDATE publication_custody SET state='launching' WHERE invocation_id=? AND kind='publisher' AND state='preparing'",
          )
          .run(invocationId);
      })
      .immediate();
  }

  private markSpawnPossible(invocationId: string, actor: PublicationActor): void {
    const at = new Date(this.now()).toISOString();
    const row = this.invocation(invocationId);
    if (row.state !== 'prepared' || !row.argv || !row.cwd || row.spawn_intent_at)
      throw new Error('publication invocation is not in its single prepared pre-spawn state');
    this.db
      .transaction(() => {
        this.db
          .query(`UPDATE publication_invocations SET state='spawn-possible', spawn_intent_at=?, started_at=?
        WHERE id=? AND state='prepared' AND spawn_intent_at IS NULL`)
          .run(at, at, invocationId);
        this.db
          .query(
            "UPDATE publication_custody SET state='running' WHERE invocation_id=? AND kind='publisher' AND state='launching'",
          )
          .run(invocationId);
      })
      .immediate();
    outputLine(row.log_path, `Starting exact normal workflow as ${actor.id}/${actor.sessionId}`);
  }

  private async spawnAndObserve(invocation: InvocationRow, _actor: PublicationActor): Promise<Record<string, unknown>> {
    const argv = JSON.parse(invocation.argv!) as string[];
    const command = argv[0]!;
    const args = argv.slice(1);
    const fd = openSync(invocation.log_path, 'a', 0o600);
    const env = { ...process.env };
    delete env.GOAL_MANAGER;
    delete env.GOAL_TASK_ID;
    delete env.GOAL_ATTEMPT;
    delete env.CODEX_THREAD_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    return await new Promise<Record<string, unknown>>((resolvePromise) => {
      let child: ProcessLikeChild;
      let logFdOpen = true;
      const closeLog = () => {
        if (!logFdOpen) return;
        logFdOpen = false;
        closeSync(fd);
      };
      try {
        child = spawn(command, args, { cwd: invocation.cwd!, env, detached: true, stdio: ['ignore', fd, fd] });
      } catch (error) {
        closeLog();
        this.completeSpawnFailure(this.invocation(invocation.id), error);
        void this.deliverReceipt(invocation.id).catch((deliveryError) =>
          this.recordDeliveryError(invocation.id, deliveryError),
        );
        resolvePromise(this.status(invocation.id));
        return;
      }
      let identity: ProcessIdentity | null = null;
      let spawnEventSeen = false;
      let visibilityFailure: string | undefined;
      let monitor: ReturnType<typeof setInterval> | undefined;
      const observe = () => {
        if (!identity) return;
        const group = this.observeGroup(identity.group);
        if (!group.complete) {
          visibilityFailure = 'process-group visibility became incomplete';
          this.markVisibilityUnknown(invocation.id, visibilityFailure);
          return;
        }
        if (
          group.members.some(
            (member) =>
              member.boot !== identity!.boot ||
              member.group !== identity!.group ||
              BigInt(member.start) < BigInt(identity!.start),
          )
        ) {
          visibilityFailure = 'process group contained an unknown older, foreign, or changed member';
          this.markVisibilityUnknown(invocation.id, visibilityFailure);
          return;
        }
        this.recordMembers(invocation.id, group.members);
      };
      child.once('spawn', () => {
        spawnEventSeen = true;
        closeLog();
        if (!child.pid) {
          visibilityFailure = 'spawn event had no original child PID';
          this.markVisibilityUnknown(invocation.id, visibilityFailure);
          return;
        }
        identity = this.process.identity(child.pid);
        if (!identity || identity.group !== identity.pid) {
          visibilityFailure = 'spawned workflow has no visible owned detached process-group identity';
          this.markVisibilityUnknown(invocation.id, visibilityFailure);
          return;
        }
        this.recordSpawnedIdentity(invocation.id, identity);
        this.options.afterIdentityRecorded?.(invocation.id, identity);
        observe();
        monitor = setInterval(observe, 100);
        monitor.unref();
      });
      child.once('error', (error) => {
        closeLog();
        if (monitor) clearInterval(monitor);
        if (!identity && !spawnEventSeen) {
          this.completeSpawnFailure(this.invocation(invocation.id), error);
          void this.deliverReceipt(invocation.id).catch(() => {});
          resolvePromise(this.status(invocation.id));
        } else
          this.markVisibilityUnknown(invocation.id, `workflow process emitted an error after spawn: ${String(error)}`);
      });
      child.once('close', (code, signal) => {
        closeLog();
        if (monitor) clearInterval(monitor);
        observe();
        if (!identity || visibilityFailure) {
          this.markVisibilityUnknown(
            invocation.id,
            visibilityFailure ?? 'workflow closed without a durable original process identity',
          );
          resolvePromise(this.status(invocation.id));
          return;
        }
        const finalGroup = this.observeGroup(identity.group);
        if (!finalGroup.complete || finalGroup.members.length) {
          this.markVisibilityUnknown(
            invocation.id,
            'workflow leader exited while recorded process-group members remain or visibility is incomplete',
          );
          resolvePromise(this.status(invocation.id));
          return;
        }
        void this.completeWorkflow(invocation.id, identity, finalGroup.members, code, signal)
          .then(() => this.deliverReceipt(invocation.id))
          .then(() => resolvePromise(this.status(invocation.id)))
          .catch((error) => {
            this.recordDeliveryError(invocation.id, error);
            resolvePromise(this.status(invocation.id));
          });
      });
    });
  }

  private recordSpawnedIdentity(invocationId: string, identity: ProcessIdentity): void {
    const members = this.observeGroup(identity.group);
    const evidence = JSON.stringify({ invocationId, identity, members: members.members });
    this.db
      .transaction(() => {
        this.db
          .query(`UPDATE publication_invocations SET state='running', process_identity=?, process_members=?, process_visibility=?
        WHERE id=? AND spawn_intent_at IS NOT NULL AND process_identity IS NULL`)
          .run(
            JSON.stringify(identity),
            JSON.stringify(members.members),
            members.complete ? 'complete' : 'unknown',
            invocationId,
          );
        this.db
          .query(`UPDATE publication_custody SET state=?, identity=?, members=?, evidence=?, evidence_hash=?
        WHERE invocation_id=? AND kind='publisher'`)
          .run(
            members.complete ? 'running' : 'unknown',
            JSON.stringify(identity),
            JSON.stringify(members.members),
            evidence,
            sha256(evidence),
            invocationId,
          );
      })
      .immediate();
  }

  private recordMembers(invocationId: string, current: ProcessIdentity[]): void {
    const row = this.invocation(invocationId);
    let saved: ProcessIdentity[];
    try {
      saved = JSON.parse(row.process_members) as ProcessIdentity[];
    } catch {
      this.markVisibilityUnknown(invocationId, 'stored process group membership is malformed');
      return;
    }
    const byId = new Map(saved.map((member) => [identityKey(member), member]));
    for (const member of current) byId.set(identityKey(member), member);
    const members = [...byId.values()];
    const evidence = JSON.stringify({ invocationId, members });
    this.db
      .transaction(() => {
        this.db
          .query('UPDATE publication_invocations SET process_members=?, process_visibility=? WHERE id=?')
          .run(JSON.stringify(members), 'complete', invocationId);
        this.db
          .query(
            "UPDATE publication_custody SET members=?, evidence=?, evidence_hash=? WHERE invocation_id=? AND kind='publisher' AND state='running'",
          )
          .run(JSON.stringify(members), evidence, sha256(evidence), invocationId);
      })
      .immediate();
  }

  private markVisibilityUnknown(invocationId: string, reason: string): void {
    const evidence = JSON.stringify({ invocationId, reason });
    this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE publication_invocations SET state='unknown', process_visibility='unknown', terminal_cause=? WHERE id=? AND receipt IS NULL",
          )
          .run(reason, invocationId);
        this.db
          .query(
            "UPDATE publication_custody SET state='unknown', evidence=?, evidence_hash=? WHERE invocation_id=? AND kind='publisher' AND state <> 'terminal'",
          )
          .run(evidence, sha256(evidence), invocationId);
      })
      .immediate();
  }

  private completeSpawnFailure(invocation: InvocationRow, error: unknown): void {
    const at = new Date(this.now()).toISOString();
    const receipt = {
      version: 1,
      invocationId: invocation.id,
      authorityId: invocation.authority_id,
      state: 'failed',
      terminalCause: 'spawn-error-after-once-only-intent',
      workflowInvocationCount: 0,
      error: String(error),
      sourceCommit: invocation.source_commit,
      argv: invocation.argv ? JSON.parse(invocation.argv) : null,
      cwd: invocation.cwd,
      logPath: invocation.log_path,
      process: null,
      exitCode: null,
      signal: null,
      endedAt: at,
      live: { status: 'unavailable', reason: 'workflow process did not produce a terminal result' },
      success: false,
    };
    this.persistReceipt(
      invocation,
      receipt,
      null,
      null,
      'spawn-error-after-once-only-intent',
      'unavailable',
      undefined,
      String(error),
      at,
    );
  }

  private async completeWorkflow(
    invocationId: string,
    identity: ProcessIdentity,
    members: ProcessIdentity[],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const invocation = this.invocation(invocationId);
    const retainedMembers: unknown = JSON.parse(invocation.process_members);
    if (!processMembersValid(retainedMembers)) {
      this.markVisibilityUnknown(invocationId, 'original observed process membership is unavailable at terminal');
      return;
    }
    members = [...new Map([...retainedMembers, ...members].map((member) => [identityKey(member), member])).values()];
    for (const original of [identity, ...members]) {
      const group = this.observeGroup(original.group);
      const current = this.process.identity(original.pid);
      if (
        !group.complete ||
        group.members.length ||
        this.process.same(original) ||
        (current && !sameIdentity(current, original))
      ) {
        this.markVisibilityUnknown(invocationId, 'recorded member or group did not settle with the original workflow');
        return;
      }
    }
    const at = new Date(this.now()).toISOString();
    let live: { status: 'match' | 'mismatch' | 'unavailable'; commit?: string; reason?: string };
    try {
      const result = await (this.options.fetchLiveBuild ?? fetchLiveBuild)();
      if (!result.commit || !/^[0-9a-f]{40}$/i.test(result.commit))
        live = { status: 'unavailable', reason: 'live build metadata did not contain a full commit' };
      else {
        const commit = result.commit.toLowerCase();
        live = { status: commit === invocation.source_commit ? 'match' : 'mismatch', commit };
      }
    } catch (error) {
      live = { status: 'unavailable', reason: safeError(error) };
    }
    const cause = signal
      ? `workflow-exited-by-${signal}`
      : exitCode === 124
        ? 'outer-workflow-deadline-expired'
        : exitCode === 0
          ? 'normal-workflow-terminal-zero'
          : `normal-workflow-terminal-${String(exitCode)}`;
    const success = exitCode === 0 && live.status === 'match';
    const receipt = {
      version: 1,
      invocationId,
      authorityId: invocation.authority_id,
      state: success ? 'success' : live.status === 'unavailable' && exitCode === 0 ? 'unavailable' : 'failed',
      sourceCommit: invocation.source_commit,
      sourceRef: invocation.source_ref,
      process: normalizedIdentity(identity),
      processMembers: members,
      physicalSettlement: {
        kind: 'native-managed-workflow-close',
        leaderClosed: true,
        controllerLogDescriptorClosed: true,
        knownMembers: members,
      },
      argv: JSON.parse(invocation.argv!) as string[],
      cwd: invocation.cwd,
      deadlineSeconds: invocation.deadline_seconds,
      logPath: invocation.log_path,
      exitCode,
      signal,
      terminalCause: cause,
      live,
      endedAt: at,
      success,
    };
    this.persistReceipt(
      invocation,
      receipt,
      exitCode,
      signal,
      cause,
      live.status,
      live.commit,
      live.reason,
      at,
      identity,
      members,
    );
  }

  private persistReceipt(
    invocation: InvocationRow,
    receipt: Record<string, unknown>,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    cause: string,
    liveStatus: string,
    liveCommit: string | undefined,
    liveError: string | undefined,
    endedAt: string,
    identity?: ProcessIdentity | null,
    members?: ProcessIdentity[],
  ): void {
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    this.db
      .transaction(() => {
        this.db
          .query(`UPDATE publication_invocations SET state=?, ended_at=?, exit_code=?, signal=?, terminal_cause=?,
        live_status=?, live_commit=?, live_error=?, receipt=?, process_identity=COALESCE(?, process_identity),
        process_members=COALESCE(?, process_members), process_visibility='complete'
        WHERE id=? AND receipt IS NULL`)
          .run(
            receipt.success === true ? 'terminal-success' : 'terminal-non-green',
            endedAt,
            exitCode,
            signal,
            cause,
            liveStatus,
            liveCommit ?? null,
            liveError ?? null,
            text,
            identity ? JSON.stringify(identity) : null,
            members ? JSON.stringify(members) : null,
            invocation.id,
          );
        this.db
          .query(`UPDATE publication_custody SET state='terminal', members=?, evidence_path=?, evidence_hash=?, evidence=?, terminal_at=?
        WHERE invocation_id=? AND kind='publisher'`)
          .run(
            JSON.stringify(members ?? []),
            relative(this.options.stateDirectory, invocation.receipt_path),
            sha256(text),
            text,
            endedAt,
            invocation.id,
          );
      })
      .immediate();
    writeAtomic(invocation.receipt_path, text);
  }

  private finishPreSpawnFailure(invocation: InvocationRow, error: unknown): void {
    const at = new Date(this.now()).toISOString();
    const receipt = {
      version: 1,
      invocationId: invocation.id,
      authorityId: invocation.authority_id,
      state: 'unavailable',
      terminalCause: 'preparation-failed-before-workflow-spawn',
      error: safeError(error),
      sourceCommit: invocation.source_commit,
      process: null,
      logPath: invocation.log_path,
      endedAt: at,
      workflowInvocationCount: 0,
      success: false,
    };
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    this.db
      .transaction(() => {
        this.db
          .query(`UPDATE publication_invocations SET state='preparation-failed', ended_at=?, terminal_cause=?, live_status='unavailable', live_error=?, receipt=?
        WHERE id=? AND spawn_intent_at IS NULL AND receipt IS NULL`)
          .run(at, 'preparation-failed-before-workflow-spawn', safeError(error), text, invocation.id);
        this.db
          .query(
            "UPDATE publication_custody SET state='terminal', evidence_path=?, evidence_hash=?, evidence=?, terminal_at=? WHERE invocation_id=? AND kind='publisher' AND state <> 'terminal'",
          )
          .run(relative(this.options.stateDirectory, invocation.receipt_path), sha256(text), text, at, invocation.id);
      })
      .immediate();
    try {
      writeAtomic(invocation.receipt_path, text);
    } catch {}
  }

  private async deliverReceipt(invocationId: string): Promise<void> {
    const invocation = this.invocation(invocationId);
    if (!invocation.receipt) return;
    if (!existsSync(invocation.receipt_path)) writeAtomic(invocation.receipt_path, invocation.receipt);
    const receipt = parseJson(invocation.receipt, 'terminal publication receipt');
    if (!isRecord(receipt)) throw new Error('terminal publication receipt is malformed');
    if (!this.db.query('SELECT 1 FROM publication_authorities WHERE id=?').get(invocation.authority_id))
      throw new Error('terminal publication receipt has no durable retained authority');
    const recipients = [...new Set(['web', this.options.operationsManager])];
    try {
      this.db
        .transaction(() => {
          for (const manager of recipients) {
            if (
              this.db
                .query('SELECT 1 FROM publication_receipt_deliveries WHERE invocation_id=? AND manager=?')
                .get(invocationId, manager)
            )
              continue;
            const message: ManagerEvent = {
              managerId: manager,
              kind: 'decision',
              from: this.options.operationsManager,
              summary: `Storybook publication ${String(receipt.state)} for ${String(receipt.sourceCommit)}; receipt ${relative(this.options.stateDirectory, invocation.receipt_path)}`,
              documentRefs: [
                {
                  path: relative(this.options.stateDirectory, invocation.receipt_path),
                  change: 'Immutable native terminal receipt and original process handle',
                },
              ],
            };
            this.inbox.deliver(message);
            const inserted = this.db.query('SELECT last_insert_rowid() AS id').get() as { id: number };
            const messageId = inserted.id;
            this.db
              .query(`INSERT INTO publication_receipt_deliveries(invocation_id, manager, inbox_message_id, delivered_at)
            VALUES (?, ?, ?, ?)`)
              .run(invocationId, manager, messageId || null, new Date(this.now()).toISOString());
          }
          const deliveredAt = new Date(this.now()).toISOString();
          this.db
            .query('UPDATE publication_invocations SET delivered_at=?, delivery_error=NULL WHERE id=?')
            .run(deliveredAt, invocationId);
        })
        .immediate();
    } catch (error) {
      this.recordDeliveryError(invocationId, error);
      throw error;
    }
  }

  private recordDeliveryError(invocationId: string, error: unknown): void {
    this.db.query('UPDATE publication_invocations SET delivery_error=? WHERE id=?').run(safeError(error), invocationId);
  }

  private updateUnknownOnRecovery(row: InvocationRow, reason: string): void {
    this.markVisibilityUnknown(row.id, reason);
  }

  status(id?: string): Record<string, unknown> {
    if (!id) {
      const row = this.db.query('SELECT id FROM publication_invocations ORDER BY created_at DESC LIMIT 1').get() as {
        id: string;
      } | null;
      if (row) return this.status(row.id);
      const authority = this.db
        .query('SELECT id, slot_utc, state, message_id FROM publication_authorities ORDER BY received_at DESC LIMIT 1')
        .get();
      const inventory = this.db
        .query('SELECT digest, observed_at, observed_by, observed_session FROM publication_inventory WHERE singleton=1')
        .get();
      return {
        legacy: this.legacy.status(),
        inventory: inventory ?? { status: 'unknown', reason: 'bootstrap required' },
        authority: authority ?? null,
        invocation: null,
      };
    }
    const invocation = this.db
      .query('SELECT * FROM publication_invocations WHERE id=?')
      .get(id) as InvocationRow | null;
    if (invocation) return this.statusForInvocation(invocation);
    const authority = this.db
      .query(
        'SELECT id, slot_utc, state, message_id, received_at, invocation_id FROM publication_authorities WHERE id=?',
      )
      .get(id);
    if (authority) {
      const retained = authority as { invocation_id?: string | null };
      if (retained.invocation_id) return this.status(retained.invocation_id);
      return { authority, invocation: null, legacy: this.legacy.status() };
    }
    throw new Error(`unknown publication authority or invocation: ${id}`);
  }

  private statusForInvocation(row: InvocationRow): Record<string, unknown> {
    let handle: Record<string, unknown> = { state: row.state, identity: null, members: [] };
    if (row.process_identity) {
      let identity: ProcessIdentity | undefined;
      try {
        identity = JSON.parse(row.process_identity) as ProcessIdentity;
      } catch {}
      if (identity && isIdentity(identity)) {
        const observation = this.observeGroup(identity.group);
        handle = {
          state: row.state,
          identity,
          sameProcess: this.process.same(identity),
          groupMembers: observation.members,
          groupVisibility: observation.complete ? 'complete' : 'unknown',
        };
      } else handle = { state: 'unknown', identity: row.process_identity, groupVisibility: 'unknown' };
    } else if (row.spawn_intent_at)
      handle = { state: 'unknown', identity: null, reason: 'spawn may have happened before its identity was recorded' };
    const terminal = row.receipt ? parseJson(row.receipt, 'terminal publication receipt') : null;
    return {
      legacy: this.legacy.status(),
      authorityId: row.authority_id,
      invocationId: row.id,
      state: row.state,
      slotUtc: row.slot_utc,
      sourceCommit: row.source_commit,
      sourceRef: row.source_ref,
      worktree: row.worktree,
      dependencyKey: row.dependency_key,
      dependencyStore: row.dependency_store,
      bunVersion: row.bun_version,
      argv: row.argv ? JSON.parse(row.argv) : null,
      cwd: row.cwd,
      deadlineSeconds: row.deadline_seconds,
      logPath: row.log_path,
      receiptPath: row.receipt_path,
      originalHandle: handle,
      terminalReceipt: terminal,
      delivery: row.delivered_at
        ? { state: 'delivered', at: row.delivered_at }
        : row.receipt
          ? { state: 'pending', error: row.delivery_error }
          : null,
    };
  }

  recover(invocationId: string, actor: PublicationActor): Promise<Record<string, unknown>> {
    if (actor.id !== this.options.operationsManager)
      throw new Error('only the configured operations manager may recover publication status');
    const lease = this.lease();
    try {
      const row = this.invocation(invocationId);
      if (row.receipt) {
        return this.deliverReceipt(invocationId)
          .catch(() => {})
          .then(() => this.status(invocationId));
      }
      if (row.process_identity) {
        let identity: ProcessIdentity | undefined;
        try {
          identity = JSON.parse(row.process_identity) as ProcessIdentity;
        } catch {}
        if (!identity || !isIdentity(identity)) {
          this.updateUnknownOnRecovery(row, 'stored original process identity is malformed');
          return Promise.resolve(this.status(invocationId));
        }
        const group = this.observeGroup(identity.group);
        if (!group.complete)
          this.updateUnknownOnRecovery(row, 'original process group visibility is incomplete after restart');
        else if (this.process.same(identity)) return Promise.resolve(this.status(invocationId));
        else if (group.members.length)
          this.updateUnknownOnRecovery(row, 'original PID changed or exited while recorded group members remain');
        else
          this.updateUnknownOnRecovery(
            row,
            'original process exited without a durable terminal result; no redispatch is allowed',
          );
      } else if (row.spawn_intent_at) {
        this.updateUnknownOnRecovery(
          row,
          'controller restarted after possible spawn with no durable original process identity',
        );
      } else {
        this.updateUnknownOnRecovery(
          row,
          'controller restarted during preparation; invocation identity is retained and will not be redispatched',
        );
      }
      return Promise.resolve(this.status(invocationId));
    } finally {
      lease.release();
    }
  }

  private invocation(id: string): InvocationRow {
    const row = this.db.query('SELECT * FROM publication_invocations WHERE id=?').get(id) as InvocationRow | null;
    if (!row) throw new Error(`unknown publication invocation: ${id}`);
    return row;
  }
}

function sameIdentity(value: unknown, expected: ProcessIdentity): boolean {
  return (
    isIdentity(value) &&
    value.pid === expected.pid &&
    value.start === expected.start &&
    value.boot === expected.boot &&
    value.group === expected.group
  );
}

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.start}:${identity.boot}:${identity.group}`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function pinnedBunVersion(root: string, executable: string): string {
  const result = runSync(executable, ['--version'], root);
  if (result.code !== 0 || result.error)
    throw new Error(`pinned Bun executable unavailable: ${result.error ?? result.stderr.trim()}`);
  const version = result.stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) throw new Error('pinned Bun executable returned an invalid version');
  return version;
}

function prepareExactDependencies(
  mainCheckout: string,
  sourceTree: string,
  worktreeRoot: string,
): PreparedPublicationDependencies {
  const pinnedFromMain = join(mainCheckout, 'node_modules/.bin/bun');
  if (!existsSync(pinnedFromMain))
    throw new Error('pinned Bun artifact is unavailable in the configured source checkout');
  const mainCompatibility = checkPinnedBunInstallation(mainCheckout);
  if (mainCompatibility.some((check) => check.status !== 'compatible'))
    throw new Error('configured source checkout does not have the exact pinned Bun artifact');
  const expectedVersion = pinnedBunVersion(mainCheckout, pinnedFromMain);
  const systemVersionResult = runSync('bun', ['--version'], mainCheckout);
  if (
    systemVersionResult.code !== 0 ||
    systemVersionResult.error ||
    systemVersionResult.stdout.trim() !== expectedVersion
  )
    throw new Error('system Bun does not match the pinned artifact; system fallback is forbidden');
  const key = dependencyKey(sourceTree);
  const storeRoot = join(dirname(resolve(worktreeRoot)), 'dependency-stores');
  const store = join(storeRoot, key);
  if (!dependencyStoreMatches(store, key))
    throw new Error(`exact immutable dependency store is unavailable for key ${key}; no install fallback is permitted`);
  const worktreeNodeModules = join(sourceTree, 'node_modules');
  if (existsSync(worktreeNodeModules) && !dependencyInstallationMatches(sourceTree))
    throw new Error('publication worktree already has mismatched dependencies; it will not be reset');
  installShared(sourceTree, storeRoot);
  if (!dependencyInstallationMatches(sourceTree))
    throw new Error('prepared publication worktree does not match its exact dependency store');
  const bunExecutable = join(sourceTree, 'node_modules/.bin/bun');
  if (!existsSync(bunExecutable)) throw new Error('shared dependency store did not provide its pinned Bun executable');
  const compatibility = checkPinnedBunInstallation(sourceTree);
  if (compatibility.some((check) => check.status !== 'compatible'))
    throw new Error('publication worktree pinned Bun artifact validation failed');
  const bunVersion = pinnedBunVersion(sourceTree, bunExecutable);
  if (bunVersion !== expectedVersion)
    throw new Error('publication worktree Bun version differs from the configured pinned artifact');
  return { key, store, bunVersion, bunExecutable };
}

async function fetchLiveBuild(): Promise<PublicationLiveBuild> {
  const response = await fetch('https://storybook.rezics.com/build.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`live Storybook metadata HTTP ${response.status}`);
  const value = (await response.json()) as unknown;
  return isRecord(value) && typeof value.commit === 'string' ? { commit: value.commit } : {};
}
