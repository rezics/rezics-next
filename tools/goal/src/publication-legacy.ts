import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { migrate } from './db.ts';
import { acquireDirectoryLease } from './lease.ts';
import { authenticatedManager } from './priority-authority.ts';
import type { ProcessIdentity } from './process.ts';
import type { PublicationActor, PublicationControllerOptions } from './publication.ts';

const MAX_BYTES = 1_048_576;
const MAX_RECORDS = 256;
type ObjectValue = Record<string, unknown>;
type Surface = 'publisher' | 'capture' | 'preview';
type Evidence = { path: string; hash: string; raw: string };
type Provenance = {
  messageId: number;
  owner: string;
  ownerSession: string;
  event: string;
  index: string;
  documents: Evidence[];
  relatedEvidence: Array<Evidence | { path: string; unavailable: string }>;
};
type Entry = {
  id: string;
  owner: string;
  surface: Surface;
  key: string;
  evidence: Evidence;
  selector: string;
  original: ObjectValue;
  identity: ProcessIdentity | null;
};
type EntryRow = {
  id: string;
  owner: string;
  surface: Surface;
  original_key: string;
  evidence_hash: string;
  evidence_path: string;
  evidence: string;
  selector: string;
  original: string;
  identity: string | null;
  received_message: number;
  resolution: string | null;
};

const migrations = [
  {
    module: 'publication-legacy-reconciliation',
    version: 1,
    sql: `
    CREATE TABLE publication_legacy_requests (
      message_id INTEGER PRIMARY KEY,
      operation TEXT NOT NULL,
      digest TEXT NOT NULL,
      provenance TEXT NOT NULL,
      actor TEXT NOT NULL,
      received_at TEXT NOT NULL,
      receipt TEXT NOT NULL
    );
    CREATE TABLE publication_legacy_entries (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      surface TEXT NOT NULL CHECK(surface IN ('publisher','capture','preview')),
      original_key TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence TEXT NOT NULL,
      selector TEXT NOT NULL,
      original TEXT NOT NULL,
      identity TEXT,
      received_message INTEGER NOT NULL REFERENCES publication_legacy_requests(message_id),
      resolution TEXT
    );
    CREATE TABLE publication_legacy_preparations (
      id TEXT PRIMARY KEY,
      receipt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE publication_legacy_inventory_inputs (
      message_id INTEGER PRIMARY KEY,
      digest TEXT NOT NULL,
      provenance TEXT NOT NULL
    );
  `,
  },
] as const;

function object(value: unknown): value is ObjectValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function parse(raw: string): ObjectValue {
  const value: unknown = JSON.parse(raw);
  if (!object(value)) throw new Error('legacy reconciliation evidence must be a JSON object');
  return value;
}
function hash(raw: string | Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}
function identity(value: unknown): value is ProcessIdentity {
  return (
    object(value) &&
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
function equal(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.start === b.start && a.boot === b.boot && a.group === b.group;
}
function readIdentity(raw: string): ProcessIdentity {
  const value = parse(raw);
  if (!identity(value)) throw new Error('retained original process identity is malformed');
  return value;
}
function sessionRetained(db: Database, owner: string, session: string): boolean {
  const row = db.query('SELECT state FROM manager_sessions WHERE id=?').get(owner) as { state: string } | null;
  if (!row) return false;
  const state = parse(row.state);
  return (
    (state.kind === undefined || state.kind === 'managed' || state.kind === 'resident-supermanager') &&
    (state.threadId === session ||
      (Array.isArray(state.history) && state.history.some((item) => object(item) && item.threadId === session)))
  );
}
function privateEvidence(root: string, path: string): Evidence {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
    throw new Error('legacy evidence requires a private state-relative path');
  const absolute = resolve(root, path);
  const inside = (candidate: string) => {
    const subpath = relative(realpathSync(root), candidate);
    return subpath !== '..' && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath);
  };
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || !inside(realpathSync(absolute)))
    throw new Error('legacy evidence must be a bounded regular file inside the private state directory');
  const bytes = readFileSync(absolute);
  const raw = bytes.toString('utf8');
  if (bytes.length > MAX_BYTES || !Buffer.from(raw, 'utf8').equals(bytes))
    throw new Error('legacy evidence must contain bounded lossless UTF-8 bytes');
  return { path, hash: hash(bytes), raw };
}
function documentPath(main: string, state: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('invalid owner document path');
  const candidate = relative(resolve(state), resolve(main, path));
  if (!candidate || candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate))
    throw new Error('owner document must be inside the configured private state directory');
  return candidate;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 512) throw new Error(`invalid ${label}`);
  return value;
}

/** Append-only preparation journal. Receiving truth never certifies host absence or grants an invocation. */
export class PublicationLegacyReconciliation {
  private readonly now: () => number;
  constructor(
    private readonly options: PublicationControllerOptions,
    private readonly specialIdentity: (path: string, body: ObjectValue) => ProcessIdentity | null,
  ) {
    this.now = options.now ?? Date.now;
    migrate(options.db, migrations);
  }
  private get db(): Database {
    return this.options.db;
  }
  private authenticate(actor: PublicationActor): void {
    const current = authenticatedManager(this.db, { CODEX_THREAD_ID: actor.sessionId, GOAL_MANAGER: actor.id });
    if (actor.id !== this.options.operationsManager || current?.id !== actor.id)
      throw new Error('legacy preparation requires the current configured operations provider session');
  }
  private lease() {
    return acquireDirectoryLease(join(this.options.stateDirectory, 'publication', 'custody.lease'));
  }
  private provenance(messageId: number, actor: PublicationActor): Provenance {
    this.authenticate(actor);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('invalid legacy owner inbox message id');
    const row = this.db
      .query(`SELECT manager, sender, kind, event, document_refs, created_at
      FROM manager_inbox WHERE id=?`)
      .get(messageId) as {
      manager: string;
      sender: string | null;
      kind: string | null;
      event: string;
      document_refs: string | null;
      created_at: number;
    } | null;
    if (!row || row.manager !== actor.id || !row.sender || row.kind !== 'decision')
      throw new Error('legacy receiving requires a durable owning-manager decision addressed to operations');
    const event = parse(row.event);
    if (
      event.managerId !== actor.id ||
      event.from !== row.sender ||
      event.kind !== row.kind ||
      typeof event.senderSessionId !== 'string' ||
      !sessionRetained(this.db, row.sender, event.senderSessionId)
    )
      throw new Error('legacy owner inbox decision has no independently authenticated sender session provenance');
    if (!Number.isFinite(row.created_at) || row.created_at > this.now() + 30_000)
      throw new Error('legacy inbox provenance has an invalid observation time');
    const refs: unknown = JSON.parse(row.document_refs ?? 'null');
    if (
      !Array.isArray(refs) ||
      refs.length === 0 ||
      refs.length > 16 ||
      JSON.stringify(event.documentRefs) !== JSON.stringify(refs)
    )
      throw new Error('legacy inbox document provenance is missing or inconsistent');
    const documents = refs.map((ref) => {
      if (!object(ref)) throw new Error('malformed legacy document reference');
      const file = privateEvidence(
        this.options.stateDirectory,
        documentPath(this.options.mainCheckout, this.options.stateDirectory, string(ref.path, 'document path')),
      );
      if (!file.path.startsWith(`${row.sender}/`))
        throw new Error('legacy owner document is outside its owning-manager namespace');
      if (ref.sha256 !== undefined && ref.sha256 !== file.hash) throw new Error('owner document hash mismatch');
      return file;
    });
    const relatedEvidence: Provenance['relatedEvidence'] = [];
    for (const file of documents) {
      const doc = parse(file.raw);
      if (
        doc.owner !== row.sender ||
        doc.disposition !== 'unavailable-exact-capture-terminal-identity; unknown custody remains occupied' ||
        !Array.isArray(doc.legacyKnownCustody)
      )
        continue;
      if (doc.legacyKnownCustody.length > MAX_RECORDS) throw new Error('too many retained source references');
      for (const record of doc.legacyKnownCustody) {
        if (!object(record) || record.file === undefined) continue;
        const path = documentPath(
          this.options.mainCheckout,
          this.options.stateDirectory,
          string(record.file, 'original source reference'),
        );
        if (relatedEvidence.some((item) => item.path === path)) continue;
        if (relatedEvidence.length >= MAX_RECORDS) throw new Error('too many retained source references');
        try {
          relatedEvidence.push(privateEvidence(this.options.stateDirectory, path));
        } catch (error) {
          if (!['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          relatedEvidence.push({
            path,
            unavailable: 'retained original file is unavailable; no identity or terminal settlement inferred',
          });
        }
      }
    }
    const index = JSON.stringify({
      manager: row.manager,
      sender: row.sender,
      kind: row.kind,
      documentRefs: refs,
      createdAt: row.created_at,
    });
    return {
      messageId,
      owner: row.sender,
      ownerSession: event.senderSessionId,
      event: row.event,
      index,
      documents,
      relatedEvidence,
    };
  }
  private requestDigest(provenance: Provenance): string {
    return hash(JSON.stringify(provenance));
  }
  private replay(provenance: Provenance, operation: string): ObjectValue | undefined {
    const previous = this.db
      .query('SELECT operation, digest, receipt FROM publication_legacy_requests WHERE message_id=?')
      .get(provenance.messageId) as { operation: string; digest: string; receipt: string } | null;
    if (!previous) return;
    if (previous.operation !== operation || previous.digest !== this.requestDigest(provenance))
      throw new Error('legacy request conflicts with immutable received provenance or evidence');
    this.materialize(`request-${provenance.messageId}`, previous.receipt);
    return parse(previous.receipt);
  }
  private checkOrder(provenance: Provenance): void {
    const prior = this.db
      .query(`SELECT MAX(message_id) AS latest FROM publication_legacy_requests
      WHERE json_extract(provenance, '$.owner')=?`)
      .get(provenance.owner) as { latest: number | null };
    if (prior.latest !== null && prior.latest > provenance.messageId)
      throw new Error('stale legacy owning-manager provenance cannot supersede a later received decision');
  }
  private materialize(id: string, raw: string): void {
    const directory = join(this.options.stateDirectory, 'publication', 'legacy');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, raw, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  }
  private saveRequest(p: Provenance, actor: PublicationActor, operation: string, receipt: ObjectValue): void {
    this.db
      .query(`INSERT INTO publication_legacy_requests
      (message_id, operation, digest, provenance, actor, received_at, receipt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        p.messageId,
        operation,
        this.requestDigest(p),
        JSON.stringify(p),
        JSON.stringify(actor),
        new Date(this.now()).toISOString(),
        JSON.stringify(receipt),
      );
  }
  private entry(
    owner: string,
    surface: Surface,
    key: string,
    evidence: Evidence,
    selector: string,
    original: ObjectValue,
  ): Entry {
    // Only fixed process fields are interpreted. Partial identities stay raw; preview PIDs never fill capture fields.
    if ('identityField' in original) throw new Error('arbitrary legacy identityField pointers are unsupported');
    const special = this.specialIdentity(evidence.path, original);
    const rawIdentity =
      special ??
      original.process ??
      original.launcher ??
      original.identity ??
      original.nativeProcessIdentity ??
      (original.pid !== undefined ? original : null);
    const known = identity(rawIdentity)
      ? { pid: rawIdentity.pid, start: rawIdentity.start, boot: rawIdentity.boot, group: rawIdentity.group }
      : null;
    if (original.workflowPid !== undefined && (!known || original.workflowPid !== known.pid))
      throw new Error('legacy workflow receipt PID does not match its original process identity');
    return {
      id: `legacy-received-${hash(JSON.stringify([owner, surface, key, evidence.path, evidence.hash, selector]))}`,
      owner,
      surface,
      key,
      evidence,
      selector,
      original,
      identity: known,
    };
  }
  private entries(p: Provenance): Entry[] {
    const result: Entry[] = [];
    for (const evidence of p.documents) {
      const doc = parse(evidence.raw);
      if (doc.owner !== p.owner || (doc.controller !== undefined && doc.controller !== this.options.operationsManager))
        throw new Error('legacy document owner/controller does not match authenticated inbox provenance');
      if (doc.kind === 'publication-legacy-disposition' && doc.version === 1) {
        if (
          doc.controller !== this.options.operationsManager ||
          !Array.isArray(doc.records) ||
          !doc.records.length ||
          doc.records.length > MAX_RECORDS
        )
          throw new Error('legacy disposition requires bounded original records');
        for (const value of doc.records) {
          if (
            !object(value) ||
            !['publisher', 'capture', 'preview'].includes(String(value.surface)) ||
            Object.keys(value).some((key) => !['key', 'surface', 'evidencePath', 'sha256'].includes(key))
          )
            throw new Error('invalid legacy disposition record schema');
          const source = privateEvidence(
            this.options.stateDirectory,
            string(value.evidencePath, 'original evidence path'),
          );
          if (source.hash !== value.sha256) throw new Error('legacy original evidence hash mismatch');
          result.push(
            this.entry(
              p.owner,
              value.surface as Surface,
              string(value.key, 'original key'),
              source,
              '',
              parse(source.raw),
            ),
          );
        }
      } else {
        // The retained unavailable disposition predates the versioned request. Preserve its exact bytes and selectors.
        if (
          doc.disposition !== 'unavailable-exact-capture-terminal-identity; unknown custody remains occupied' ||
          !object(doc.capture) ||
          !object(doc.previewCompanion) ||
          !object(doc.legacyPublisher) ||
          !Array.isArray(doc.legacyKnownCustody) ||
          doc.legacyKnownCustody.length > MAX_RECORDS
        )
          throw new Error('unsupported retained unavailable legacy disposition');
        const agreement = this.db
          .query('SELECT manager, sender, kind, event FROM manager_inbox WHERE id=?')
          .get(typeof doc.reply === 'number' ? doc.reply : -1) as {
          manager: string;
          sender: string;
          kind: string;
          event: string;
        } | null;
        const agreedEvent = agreement ? parse(agreement.event) : null;
        if (
          !agreement ||
          agreement.manager !== p.owner ||
          agreement.sender !== this.options.operationsManager ||
          agreement.kind !== 'decision' ||
          !agreedEvent ||
          agreedEvent.from !== agreement.sender ||
          agreedEvent.managerId !== p.owner ||
          agreedEvent.kind !== 'decision' ||
          typeof agreedEvent.senderSessionId !== 'string' ||
          !sessionRetained(this.db, agreement.sender, agreedEvent.senderSessionId)
        )
          throw new Error('retained unavailable disposition lacks the authenticated operations-to-owner agreement');
        result.push(this.entry(p.owner, 'capture', 'capture', evidence, 'capture', doc.capture));
        result.push(this.entry(p.owner, 'preview', 'preview', evidence, 'previewCompanion', doc.previewCompanion));
        for (const history of ['startupHistory', 'refreshHistory'] as const) {
          const values = doc.previewCompanion[history];
          if (values === undefined) continue;
          if (!Array.isArray(values) || values.length > MAX_RECORDS) throw new Error('invalid preview history');
          values.forEach((item, i) => {
            if (!object(item)) throw new Error('invalid preview history record');
            result.push(
              this.entry(
                p.owner,
                'preview',
                `preview-${history}-${i}`,
                evidence,
                `previewCompanion.${history}.${i}`,
                item,
              ),
            );
          });
        }
        result.push(this.entry(p.owner, 'publisher', 'publisher', evidence, 'legacyPublisher', doc.legacyPublisher));
        doc.legacyKnownCustody.forEach((item, i) => {
          if (!object(item)) throw new Error('invalid retained legacy known custody');
          result.push(this.entry(p.owner, 'publisher', `known-${i}`, evidence, `legacyKnownCustody.${i}`, item));
        });
      }
    }
    if (result.length > MAX_RECORDS) throw new Error('too many legacy records in one receiving request');
    return result;
  }
  receive(messageId: number, actor: PublicationActor): ObjectValue {
    this.authenticate(actor);
    const lease = this.lease();
    try {
      const p = this.provenance(messageId, actor);
      const replay = this.replay(p, 'receive');
      if (replay) return replay;
      this.checkOrder(p);
      const entries = this.entries(p);
      const receipt: ObjectValue = {
        version: 1,
        operation: 'legacy-receive',
        messageId,
        owner: p.owner,
        receivedBy: actor,
        provenanceSha256: this.requestDigest(p),
        state: 'UNKNOWN OCCUPIED',
        entries: entries.map((entry) => ({
          id: entry.id,
          surface: entry.surface,
          evidenceSha256: entry.evidence.hash,
          identity: entry.identity,
          identityStatus: entry.identity ? 'known-unsettled' : 'unavailable-or-partial',
        })),
        launchReady: false,
        authorityChanged: false,
        workflowInvocations: 0,
      };
      this.db
        .transaction(() => {
          this.saveRequest(p, actor, 'receive', receipt);
          for (const entry of entries)
            this.db
              .query(`INSERT INTO publication_legacy_entries
          (id, owner, surface, original_key, evidence_hash, evidence_path, evidence, selector, original, identity, received_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
              .run(
                entry.id,
                entry.owner,
                entry.surface,
                entry.key,
                entry.evidence.hash,
                entry.evidence.path,
                entry.evidence.raw,
                entry.selector,
                JSON.stringify(entry.original),
                entry.identity ? JSON.stringify(entry.identity) : null,
                messageId,
              );
        })
        .immediate();
      this.materialize(`request-${messageId}`, JSON.stringify(receipt));
      return receipt;
    } finally {
      lease.release();
    }
  }
  private rows(): EntryRow[] {
    return this.db.query('SELECT * FROM publication_legacy_entries ORDER BY id').all() as EntryRow[];
  }
  private relatedOriginals(original: ObjectValue): { known: ProcessIdentity[]; incomplete: boolean } {
    const candidates: unknown[] = [];
    for (const key of ['process', 'launcher', 'identity', 'expected', 'observed'])
      if (original[key] !== undefined && original[key] !== null) candidates.push(original[key]);
    let incomplete = false;
    for (const key of ['children', 'members', 'processMembers']) {
      const values = original[key];
      if (values === undefined) continue;
      if (!Array.isArray(values)) {
        incomplete = true;
        continue;
      }
      for (const item of values) candidates.push(object(item) && item.identity !== undefined ? item.identity : item);
    }
    const known: ProcessIdentity[] = [];
    for (const value of candidates) {
      if (identity(value)) known.push({ pid: value.pid, start: value.start, boot: value.boot, group: value.group });
      else incomplete = true;
    }
    return { known, incomplete };
  }
  private partialIdentity(row: EntryRow): ObjectValue {
    const original = parse(row.original);
    const value =
      original.process ?? original.launcher ?? original.identity ?? original.nativeProcessIdentity ?? original;
    if (!object(value)) return {};
    const partial: ObjectValue = {};
    for (const key of ['pid', 'start', 'boot', 'group'])
      if (typeof value[key] === 'number' || typeof value[key] === 'string') partial[key] = value[key];
    return partial;
  }
  status(id?: string): ObjectValue {
    if (id !== undefined) {
      const row = /^[1-9]\d*$/.test(id)
        ? this.db.query('SELECT receipt FROM publication_legacy_requests WHERE message_id=?').get(Number(id))
        : this.db.query('SELECT receipt FROM publication_legacy_preparations WHERE id=?').get(id);
      if (!row) throw new Error('unknown legacy request or preparation receipt');
      return parse((row as { receipt: string }).receipt);
    }
    const rows = this.rows();
    const latest = this.db
      .query('SELECT receipt FROM publication_legacy_preparations ORDER BY rowid DESC LIMIT 1')
      .get() as { receipt: string } | null;
    return {
      state: rows.some((row) => !row.resolution) ? 'UNKNOWN OCCUPIED' : rows.length ? 'settled' : 'unreceived',
      retainedSetSha256: this.setHash(rows),
      entries: rows.map((row) => ({
        id: row.id,
        owner: row.owner,
        surface: row.surface,
        key: row.original_key,
        evidencePath: row.evidence_path,
        evidenceSha256: row.evidence_hash,
        selector: row.selector,
        identity: row.identity ? parse(row.identity) : null,
        partialIdentity: this.partialIdentity(row),
        originalRelatedIdentities: this.relatedOriginals(parse(row.original)),
        state: row.resolution ? 'terminal' : 'UNKNOWN OCCUPIED',
        resolution: row.resolution ? parse(row.resolution) : null,
      })),
      preparation: latest ? parse(latest.receipt) : null,
      launchReady: false,
    };
  }
  private setHash(rows: EntryRow[]): string {
    return hash(
      JSON.stringify(
        rows.map((row) => ({
          id: row.id,
          hash: row.evidence_hash,
          identity: row.identity,
          resolution: row.resolution,
        })),
      ),
    );
  }
  assertClear(): void {
    const row = this.db
      .query('SELECT id, surface FROM publication_legacy_entries WHERE resolution IS NULL LIMIT 1')
      .get() as { id: string; surface: string } | null;
    if (row)
      throw new Error(`legacy ${row.surface} custody ${row.id} is UNKNOWN OCCUPIED; native reconciliation is required`);
    if (this.rows().length)
      throw new Error(
        'reconciled originals do not certify complete native host inventory; native host/child/pipe producer unavailable',
      );
  }
  prepare(actor: PublicationActor, inventoryMessageId?: number): ObjectValue {
    this.authenticate(actor);
    const lease = this.lease();
    try {
      const rows = this.rows();
      const retainedSetSha256 = this.setHash(rows);
      const processApi = this.options.process;
      if (!processApi) throw new Error('native publication process observation API was not supplied');
      const controllerIdentity = processApi.identity();
      const host = hostname();
      const blockers: ObjectValue[] = [];
      const missing = (operation: string, field: string, reason: string, id?: string) =>
        blockers.push({ host, operation, field, reason, ...(id ? { id } : {}) });
      if (!controllerIdentity)
        missing('host-inventory', 'controller.pid/start/boot/group', 'controller incarnation unavailable');
      if (!rows.length) missing('legacy-receive', 'ownerDecision', 'no authenticated original legacy custody received');
      for (const request of this.db.query('SELECT provenance FROM publication_legacy_requests').all() as {
        provenance: string;
      }[]) {
        const provenance = parse(request.provenance);
        if (Array.isArray(provenance.relatedEvidence))
          for (const item of provenance.relatedEvidence)
            if (object(item) && typeof item.unavailable === 'string')
              missing('legacy-receive', String(item.path), item.unavailable);
      }
      for (const row of rows.filter((item) => !item.resolution)) {
        if (hash(row.evidence) !== row.evidence_hash) throw new Error(`corrupt immutable legacy evidence: ${row.id}`);
        const related = this.relatedOriginals(parse(row.original));
        if (related.incomplete)
          missing(
            'legacy-resolve',
            'originalChildren',
            'partial or unknown original incarnation/group membership remains occupied',
            row.id,
          );
        if (!row.identity) {
          missing(
            'legacy-resolve',
            `${row.surface}.originalIdentity`,
            'original PID/start/boot/group unavailable; preview and refresh PIDs cannot fill this field',
            row.id,
          );
        } else {
          for (const original of [readIdentity(row.identity), ...related.known]) {
            try {
              const members = processApi.members(original.group);
              if (!Array.isArray(members) || !members.every(identity)) throw new Error('incomplete group visibility');
              const current = processApi.identity(original.pid);
              if (current && !equal(current, original))
                missing(
                  'legacy-resolve',
                  'originalIncarnation',
                  'PID reused; absence of the original PID is not settlement',
                  row.id,
                );
              if (processApi.same(original) || members.length)
                missing(
                  'legacy-resolve',
                  'groupMembers',
                  'live, foreign or surviving group members remain occupied',
                  row.id,
                );
            } catch {
              missing(
                'host-inventory',
                'groupVisibility',
                'native process group observation unavailable or incomplete',
                row.id,
              );
            }
          }
        }
        missing(
          'legacy-resolve',
          `${row.surface}.originalTerminalHandle`,
          'authenticated original terminal plus complete child/group/pipe settlement is not yet received',
          row.id,
        );
      }
      let inventory: Provenance | undefined;
      if (inventoryMessageId !== undefined) {
        inventory = this.provenance(inventoryMessageId, actor);
        if (inventory.owner !== this.options.operationsManager || inventory.documents.length !== 1)
          throw new Error('native inventory must come from its authenticated operations producer');
        const doc = parse(inventory.documents[0]!.raw);
        if (
          doc.version !== 1 ||
          doc.kind !== 'publication-native-inventory' ||
          doc.owner !== inventory.owner ||
          doc.host !== host ||
          !controllerIdentity ||
          doc.boot !== controllerIdentity.boot ||
          !object(doc.controller) ||
          doc.controller.manager !== actor.id ||
          doc.controller.sessionId !== inventory.ownerSession ||
          doc.controller.sessionId !== actor.sessionId ||
          !identity(doc.controller.identity) ||
          doc.controller.identity.boot !== controllerIdentity.boot ||
          !processApi.same(doc.controller.identity) ||
          doc.retainedSetSha256 !== retainedSetSha256 ||
          typeof doc.observedAt !== 'string'
        )
          throw new Error('native inventory host/boot/controller/retained-set provenance mismatch');
        const age = this.now() - Date.parse(doc.observedAt);
        if (!Number.isFinite(age) || age < -30_000 || age > 300_000)
          throw new Error('native inventory must be no more than five minutes old');
        const previous = this.db
          .query('SELECT digest FROM publication_legacy_inventory_inputs WHERE message_id=?')
          .get(inventory.messageId) as { digest: string } | null;
        if (previous && previous.digest !== this.requestDigest(inventory))
          throw new Error('native inventory input conflicts with its immutable received provenance');
        // A manager-authenticated document is retained input, not an implementation of complete native visibility.
        // process.ts cannot discover identity-less legacy owners or certify descendant pipes. Never bless its flags.
        missing(
          'host-inventory',
          'nativeProducerReceipt',
          'authenticated inventory document retained; no existing native API can certify its complete host/child/pipe visibility',
        );
      }
      missing(
        'host-inventory',
        'nativePublisherCaptureInventoryProducer',
        'process.ts exposes incarnation and group membership only; complete native+legacy host discovery and child/pipe settlement producer unavailable',
      );
      missing(
        'runtime-release',
        'validatedControllerReleaseReceipt',
        'source presence and caller-authored release markers cannot certify installed controller lifecycle/compatibility release',
      );
      missing(
        'storybook:deploy',
        'providerCredential',
        'private Wrangler account credential for versions upload, versions deploy and triggers deploy has not been verified by the released operations runtime; preparation does not read or disclose credentials',
      );
      const id = randomUUID();
      const receipt: ObjectValue = {
        version: 1,
        id,
        operation: 'legacy-prepare',
        state: 'unavailable',
        host,
        controller: { ...actor, identity: controllerIdentity },
        observedAt: new Date(this.now()).toISOString(),
        retainedSetSha256,
        unresolved: rows.filter((row) => !row.resolution).map((row) => row.id),
        knownOriginalIdentities: rows
          .filter((row) => row.identity)
          .map((row) => ({ id: row.id, identity: parse(row.identity!) })),
        inventoryProvenance: inventory
          ? {
              messageId: inventory.messageId,
              owner: inventory.owner,
              ownerSession: inventory.ownerSession,
              provenanceSha256: this.requestDigest(inventory),
              documents: inventory.documents.map((document) => ({ path: document.path, sha256: document.hash })),
            }
          : null,
        blockers,
        launchReady: false,
        authorityChanged: false,
        workflowInvocations: 0,
      };
      const raw = JSON.stringify(receipt);
      this.db
        .transaction(() => {
          if (inventory)
            this.db
              .query(`INSERT INTO publication_legacy_inventory_inputs(message_id, digest, provenance)
          VALUES (?, ?, ?) ON CONFLICT(message_id) DO NOTHING`)
              .run(inventory.messageId, this.requestDigest(inventory), JSON.stringify(inventory));
          this.db
            .query('INSERT INTO publication_legacy_preparations(id, receipt, created_at) VALUES (?, ?, ?)')
            .run(id, raw, new Date(this.now()).toISOString());
        })
        .immediate();
      this.materialize(id, raw);
      return receipt;
    } finally {
      lease.release();
    }
  }
  resolve(messageId: number, actor: PublicationActor): ObjectValue {
    this.authenticate(actor);
    const lease = this.lease();
    try {
      const p = this.provenance(messageId, actor);
      const replay = this.replay(p, 'resolve');
      if (replay) return replay;
      this.checkOrder(p);
      if (p.documents.length !== 1) throw new Error('legacy resolution requires one exact owner document');
      const doc = parse(p.documents[0]!.raw);
      if (
        doc.version !== 1 ||
        doc.kind !== 'publication-legacy-resolution' ||
        doc.owner !== p.owner ||
        doc.controller !== actor.id ||
        !Array.isArray(doc.resolutions) ||
        !doc.resolutions.length ||
        doc.resolutions.length > MAX_RECORDS
      )
        throw new Error('invalid authenticated legacy resolution schema');
      const settled: Array<{ id: string; proof: ObjectValue }> = [];
      const unavailable: ObjectValue[] = [];
      const seen = new Set<string>();
      for (const value of doc.resolutions) {
        if (
          !object(value) ||
          Object.keys(value).some(
            (key) =>
              !['id', 'evidenceSha256', 'originalIdentity', 'nativeInvocationId', 'terminalReceiptSha256'].includes(
                key,
              ),
          )
        )
          throw new Error('invalid legacy resolution fields; arbitrary identity pointers are unsupported');
        const requestedId = string(value.id, 'legacy custody id');
        if (seen.has(requestedId)) throw new Error('duplicate legacy resolution identity in one request');
        seen.add(requestedId);
        const row = this.rows().find((item) => item.id === value.id);
        if (
          !row ||
          row.owner !== p.owner ||
          row.evidence_hash !== value.evidenceSha256 ||
          hash(row.evidence) !== row.evidence_hash
        )
          throw new Error('legacy resolution original evidence/owner binding mismatch');
        if (
          !identity(value.originalIdentity) ||
          Object.keys(value.originalIdentity).some((key) => !['pid', 'start', 'boot', 'group'].includes(key))
        )
          throw new Error('legacy resolution needs the genuine complete original identity');
        const originalIdentity = value.originalIdentity;
        const rawOriginal = parse(row.original);
        if (
          row.surface === 'capture' &&
          this.rows().some((other) => {
            if (other.surface !== 'preview') return false;
            const preview = parse(other.original);
            return (
              preview.pid === originalIdentity.pid ||
              (other.identity && readIdentity(other.identity).pid === originalIdentity.pid)
            );
          })
        )
          throw new Error('preview/refresh identity cannot resolve original capture custody');
        const partial =
          rawOriginal.process ??
          rawOriginal.launcher ??
          rawOriginal.identity ??
          rawOriginal.nativeProcessIdentity ??
          rawOriginal;
        if (
          object(partial) &&
          ['pid', 'start', 'boot', 'group'].some(
            (key) =>
              partial[key] !== undefined &&
              partial[key] !== null &&
              partial[key] !== originalIdentity[key as keyof ProcessIdentity],
          )
        )
          throw new Error('legacy resolution identity contradicts retained original incarnation');
        if (
          (row.identity && !equal(readIdentity(row.identity), originalIdentity)) ||
          (rawOriginal.workflowPid !== undefined && rawOriginal.workflowPid !== originalIdentity.pid)
        )
          throw new Error('legacy resolution workflow PID/original identity mismatch');
        if (row.surface !== 'publisher') {
          unavailable.push({
            id: row.id,
            field: `${row.surface}.nativeTerminalProducer`,
            reason:
              'no existing native managed capture/preview child-and-pipe terminal receipt producer; custody remains UNKNOWN OCCUPIED',
          });
          continue;
        }
        if (!row.identity) {
          unavailable.push({
            id: row.id,
            field: 'publisher.nativeOriginalIdentityBinding',
            reason:
              'no native original producer links this identity-less historical evidence to a managed invocation; supplied identity cannot fill the missing original; custody remains UNKNOWN OCCUPIED',
          });
          continue;
        }
        // Positive settlement accepts only an actual once-only managed workflow result in this controller database.
        // No new process, foreign adoption, historical exit flag or caller noUnknown boolean is a substitute.
        const native = this.db
          .query(`SELECT process_identity, process_members, process_visibility, receipt, source_commit
          FROM publication_invocations WHERE id=?`)
          .get(string(value.nativeInvocationId, 'native invocation id')) as {
          process_identity: string | null;
          process_members: string;
          process_visibility: string;
          receipt: string | null;
          source_commit: string;
        } | null;
        if (
          !native?.process_identity ||
          !native.receipt ||
          native.process_visibility !== 'complete' ||
          !equal(readIdentity(native.process_identity), originalIdentity) ||
          hash(native.receipt) !== value.terminalReceiptSha256
        )
          throw new Error('legacy resolution lacks its exact original native managed terminal result');
        const terminal = parse(native.receipt);
        const members: unknown = JSON.parse(native.process_members);
        const settlement = terminal.physicalSettlement;
        const related = this.relatedOriginals(rawOriginal);
        if (
          !identity(terminal.process) ||
          !equal(terminal.process, originalIdentity) ||
          terminal.invocationId !== value.nativeInvocationId ||
          (!Number.isInteger(terminal.exitCode) && typeof terminal.signal !== 'string') ||
          !Array.isArray(members) ||
          !members.every(identity) ||
          !object(settlement) ||
          settlement.kind !== 'native-managed-workflow-close' ||
          settlement.leaderClosed !== true ||
          settlement.controllerLogDescriptorClosed !== true ||
          JSON.stringify(settlement.knownMembers) !== JSON.stringify(members) ||
          JSON.stringify(terminal.processMembers) !== JSON.stringify(members) ||
          related.incomplete ||
          related.known.some(
            (original) => !equal(original, originalIdentity) && !members.some((member) => equal(original, member)),
          ) ||
          (rawOriginal.invocationId !== undefined && rawOriginal.invocationId !== value.nativeInvocationId) ||
          (rawOriginal.sourceCommit !== undefined && rawOriginal.sourceCommit !== native.source_commit)
        )
          throw new Error('legacy resolution terminal/source/process evidence mismatch');
        const processApi = this.options.process;
        if (!processApi) throw new Error('native process visibility unavailable');
        for (const original of [originalIdentity, ...members]) {
          const current = processApi.identity(original.pid);
          const group = processApi.members(original.group);
          if (
            (current && !equal(current, original)) ||
            processApi.same(original) ||
            !Array.isArray(group) ||
            !group.every(identity) ||
            group.length
          )
            throw new Error('legacy resolution has live/reused/unknown incarnation or surviving group members');
        }
        // The native close event, terminal custody and complete process visibility are checked together.
        const custody = this.db
          .query(`SELECT state, identity, evidence_hash, evidence FROM publication_custody
          WHERE invocation_id=? AND kind='publisher'`)
          .get(String(value.nativeInvocationId)) as {
          state: string;
          identity: string | null;
          evidence_hash: string;
          evidence: string;
        } | null;
        if (
          !custody ||
          custody.state !== 'terminal' ||
          !custody.identity ||
          !equal(readIdentity(custody.identity), originalIdentity) ||
          custody.evidence !== native.receipt ||
          custody.evidence_hash !== hash(native.receipt)
        )
          throw new Error('original native physical terminal custody is unavailable');
        const proof = {
          messageId,
          evidenceSha256: row.evidence_hash,
          originalIdentity,
          nativeInvocationId: value.nativeInvocationId,
          terminalReceiptSha256: value.terminalReceiptSha256,
          owner: p.owner,
          ownerSession: p.ownerSession,
        };
        if (row.resolution && JSON.stringify(parse(row.resolution)) !== JSON.stringify(proof))
          throw new Error('legacy settlement conflicts with its original immutable resolution');
        settled.push({ id: row.id, proof });
      }
      const receipt: ObjectValue = {
        version: 1,
        operation: 'legacy-resolve',
        messageId,
        state: unavailable.length ? 'unavailable' : 'originals-settled',
        settled: settled.map((entry) => entry.id),
        unavailable,
        launchReady: false,
        authorityChanged: false,
        workflowInvocations: 0,
      };
      this.db
        .transaction(() => {
          this.saveRequest(p, actor, 'resolve', receipt);
          for (const entry of settled)
            this.db
              .query('UPDATE publication_legacy_entries SET resolution=? WHERE id=? AND resolution IS NULL')
              .run(JSON.stringify(entry.proof), entry.id);
        })
        .immediate();
      this.materialize(`request-${messageId}`, JSON.stringify(receipt));
      return receipt;
    } finally {
      lease.release();
    }
  }
}
