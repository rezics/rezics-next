import type { Database, SQLQueryBindings, Statement } from 'bun:sqlite';
import { createRequire } from 'node:module';
import { isDeepStrictEqual, types } from 'node:util';
import { FIELD_GROUPS, type BatchWriteRequest, type BatchWriteResult, type FieldGroup } from '@rezics/definitions/bulk';
import {
  checkMediaImportStatus,
  MediaImportAcceptedSchema,
  type MediaImportAccepted,
  type MediaImportRequest,
  type MediaImportStatus,
} from '@rezics/definitions/media-import';
import { checkBatch, checkRequest, checkResult } from './accepted-checks.ts';
import { isImportSourceRecord, isImportSourceRecordMetadataResult } from './source-record-runtime.ts';
import { type ImportSourceRecordMetadataCommand, type ImportSourceRecordMetadataResult } from './import-contract.ts';

const { Errors } = createRequire(import.meta.resolve('@rezics/definitions/media-import'))('typebox/schema') as {
  Errors(schema: unknown, input: unknown): [unknown, Iterable<unknown>];
};

/** Exact source alias and external record key; this identity survives coordinator runs. */
export type Owner = { source: string; external_id: string };
/** Send bytes unchanged with key. Signature is caller-supplied planner identity, not a native ID. */
export type Journal = { key: string; bytes: string; signature: string };
/** A currently owned, acknowledged candidate with its original request attachment. */
export type Candidate = Journal & { candidate: string; subject: string; field_group: FieldGroup };
/** Bootstrap observation only; full record baselines and run acknowledgements belong to RunStore. */
export type Claim = { state: 'pending' } | { state: 'bound'; subject: string } | { state: 'taken-down' };
/** The exact POST and observed responses; a reserved receipt does not make its media available. */
export type PendingMedia = Journal & { accepted: MediaImportAccepted | null; status: MediaImportStatus | null };
export type MetadataJournal = Journal & { result: ImportSourceRecordMetadataResult | null };

type Binding = {
  state: Claim['state'];
  subject: string | null;
  bootstrap_key: string;
  candidate_count: number;
  cover_key: string | null;
};
type Entry = Journal & { acknowledgement: string | null };
type MediaEntry = Journal & { accepted: string | null; status: string | null };
const BYTES = 65536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (): never => {
  throw new TypeError('Invalid record binding operation');
};
function ensure(condition: unknown): asserts condition {
  if (!condition) fail();
}

/** Copy data descriptors before any schema engine or serialization can execute user code. */
function snapshot<T>(input: T): { value: T; bytes: string } {
  const ancestors = new Set<object>();
  let budget = BYTES;
  let nodes = 0;
  const charge = (text: string) => {
    budget -= Buffer.byteLength(text, 'utf8');
    ensure(budget >= 0);
  };
  function visit(value: unknown, depth: number): unknown {
    ensure(depth <= 32 && ++nodes <= BYTES);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      charge(value);
      return value;
    }
    if (typeof value === 'number') {
      ensure(Number.isFinite(value));
      return value;
    }
    ensure(typeof value === 'object' && !types.isProxy(value));
    ensure(!ancestors.has(value));
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    ensure(array ? proto === Array.prototype : proto === null || proto === Object.prototype);
    const keys = Reflect.ownKeys(value);
    ensure(keys.length <= BYTES);
    const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    ancestors.add(value);
    let items = 0;
    for (const key of keys) {
      ensure(typeof key === 'string' && key !== 'toJSON');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      ensure('value' in descriptor);
      if (array && key === 'length') {
        ensure(Number.isInteger(descriptor.value) && descriptor.value <= BYTES);
        continue;
      }
      ensure(descriptor.enumerable);
      if (array) ensure(key === String(items++));
      charge(key);
      Object.defineProperty(out, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (array) ensure(items === Object.getOwnPropertyDescriptor(value, 'length')!.value);
    ancestors.delete(value);
    return out;
  }
  const value = visit(input, 0) as T;
  const bytes = JSON.stringify(value);
  ensure(typeof bytes === 'string' && Buffer.byteLength(bytes, 'utf8') <= BYTES);
  return { value, bytes };
}
function text(input: unknown, max: number): asserts input is string {
  ensure(typeof input === 'string' && input.length > 0 && Buffer.byteLength(input, 'utf8') <= max);
}
function ownerInput(input: Owner): Owner {
  const { value } = snapshot(input);
  ensure(value && typeof value === 'object' && Object.keys(value).length === 2);
  text(value.source, 32);
  ensure(/^[a-z][a-z0-9_-]{0,31}$/.test(value.source));
  text(value.external_id, 255);
  return value;
}
function requestKey(owner: Owner, key: unknown): asserts key is string {
  text(key, 255);
  ensure(/^[\x20-\x7e]+$/.test(key) && key.startsWith(`${owner.source}:${owner.external_id}:`));
  ensure(key.length > owner.source.length + owner.external_id.length + 2);
}
function groupInput(group: FieldGroup) {
  ensure(FIELD_GROUPS.includes(group));
}
function journal(entry: Journal): Journal {
  return { key: entry.key, bytes: entry.bytes, signature: entry.signature };
}
function mediaJournal(entry: MediaEntry): PendingMedia {
  return {
    ...journal(entry),
    accepted: entry.accepted === null ? null : JSON.parse(entry.accepted),
    status: entry.status === null ? null : JSON.parse(entry.status),
  };
}

/**
 * Durable request bindings on the caller's SQLite handle; no transport or baseline authority.
 * All methods are synchronous. Prepare returns exact wire bytes to send with its key;
 * acknowledge/accept/observe take validated public responses, never locally allocated IDs.
 * Owner always means the exact source alias and external record identity across runs.
 */
export class RecordBindings {
  private readonly statements = new Map<string, Statement>();
  private closed = false;

  /** Construct after installing any SQLite probe. The caller owns the handle and its lifetime. */
  constructor(private readonly database: Database) {
    // WAL keeps bounded journal transactions practical while FULL retains commit durability.
    // Sidecars stay beside the supplied database; no second handle or external retention.
    database.exec('PRAGMA journal_mode=WAL');
    database.exec('PRAGMA synchronous=FULL');
    database.exec('PRAGMA busy_timeout=5000');
    database.exec(`
      CREATE TABLE IF NOT EXISTS binding_records (
        source TEXT NOT NULL, external_id TEXT NOT NULL, state TEXT NOT NULL,
        subject TEXT, bootstrap_key TEXT NOT NULL, candidate_count INTEGER NOT NULL,
        cover_key TEXT, PRIMARY KEY (source, external_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS binding_groups (
        source TEXT NOT NULL, external_id TEXT NOT NULL, field_group TEXT NOT NULL,
        candidate_count INTEGER NOT NULL, PRIMARY KEY (source, external_id, field_group)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS binding_journal (
        source TEXT NOT NULL, external_id TEXT NOT NULL, key TEXT NOT NULL,
        bytes TEXT NOT NULL, signature TEXT NOT NULL, acknowledgement TEXT,
        PRIMARY KEY (source, external_id, key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS binding_candidates (
        source TEXT NOT NULL, external_id TEXT NOT NULL, field_group TEXT NOT NULL,
        candidate TEXT NOT NULL, subject TEXT NOT NULL, key TEXT NOT NULL,
        bytes TEXT NOT NULL, signature TEXT NOT NULL,
        PRIMARY KEY (source, external_id, field_group, candidate)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS binding_media (
        source TEXT NOT NULL, external_id TEXT NOT NULL, key TEXT NOT NULL,
        bytes TEXT NOT NULL, signature TEXT NOT NULL, accepted TEXT, status TEXT,
        PRIMARY KEY (source, external_id, key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS binding_metadata_journal (
        source TEXT NOT NULL, external_id TEXT NOT NULL, key TEXT NOT NULL,
        bytes TEXT NOT NULL, signature TEXT NOT NULL, acknowledgement TEXT,
        PRIMARY KEY (source, external_id, key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS binding_metadata_current (
        source TEXT NOT NULL, external_id TEXT NOT NULL, key TEXT NOT NULL,
        PRIMARY KEY (source, external_id)
      ) WITHOUT ROWID;
    `);
  }

  /** One exact current intent pointer; historical request/result bytes stay immutable. */
  metadata(owner: Owner): MetadataJournal | null {
    const o = ownerInput(owner);
    const current = this.get<{ key: string }>(
      'SELECT key FROM binding_metadata_current WHERE source=? AND external_id=?',
      o.source,
      o.external_id,
    );
    if (!current) return null;
    const entry = this.get<Entry>(
      'SELECT key,bytes,signature,acknowledgement FROM binding_metadata_journal WHERE source=? AND external_id=? AND key=?',
      o.source,
      o.external_id,
      current.key,
    )!;
    return { ...journal(entry), result: entry.acknowledgement === null ? null : JSON.parse(entry.acknowledgement) };
  }

  prepareMetadata(
    owner: Owner,
    key: string,
    signature: string,
    command: ImportSourceRecordMetadataCommand,
  ): MetadataJournal {
    const o = ownerInput(owner);
    requestKey(o, key);
    const { value, bytes } = snapshot(command);
    ensure(
      Object.keys(value).sort().join(',') === 'expected_metadata_revision,external_id,metadata,source' &&
        value.source === o.source &&
        value.external_id === o.external_id &&
        isImportSourceRecord(value.metadata) &&
        (value.expected_metadata_revision === null ||
          (Number.isSafeInteger(value.expected_metadata_revision) && value.expected_metadata_revision > 0)),
    );
    ensure(/^[a-f0-9]{64}$/.test(signature));
    return this.atomic(() => {
      this.bound(o);
      const previous = this.metadata(o);
      if (previous && !previous.result) {
        ensure(previous.key === key && previous.signature === signature && previous.bytes === bytes);
        return previous;
      }
      ensure(value.expected_metadata_revision === (previous?.result?.metadata_revision ?? null));
      const existing = this.get<Entry>(
        'SELECT key,bytes,signature,acknowledgement FROM binding_metadata_journal WHERE source=? AND external_id=? AND key=?',
        o.source,
        o.external_id,
        key,
      );
      if (existing) ensure(existing.bytes === bytes && existing.signature === signature);
      else
        this.run(
          'INSERT INTO binding_metadata_journal (source,external_id,key,bytes,signature,acknowledgement) VALUES(?,?,?,?,?,?)',
          o.source,
          o.external_id,
          key,
          bytes,
          signature,
          null,
        );
      this.run(
        `INSERT INTO binding_metadata_current VALUES(?,?,?) ON CONFLICT(source,external_id) DO UPDATE SET key=excluded.key`,
        o.source,
        o.external_id,
        key,
      );
      return this.metadata(o)!;
    });
  }

  acknowledgeMetadata(owner: Owner, key: string, result: ImportSourceRecordMetadataResult): void {
    const o = ownerInput(owner);
    requestKey(o, key);
    const observed = snapshot(result);
    ensure(isImportSourceRecordMetadataResult(observed.value));
    this.atomic(() => {
      const pending = this.metadata(o);
      ensure(pending?.key === key);
      const command = JSON.parse(pending.bytes) as ImportSourceRecordMetadataCommand;
      const expected = command.metadata;
      const actual = observed.value.record;
      // Fill may preserve extra optional leaves; correction replaces the entire record.
      ensure(
        command.expected_metadata_revision === null
          ? actual.name === expected.name &&
              actual.url === expected.url &&
              (expected.attribution === undefined || actual.attribution === expected.attribution) &&
              (!expected.licence ||
                (actual.licence?.id === expected.licence.id &&
                  (expected.licence.url === undefined || actual.licence.url === expected.licence.url))) &&
              observed.value.effect !== 'corrected'
          : isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), expected) &&
              observed.value.effect !== 'filled' &&
              observed.value.metadata_revision ===
                command.expected_metadata_revision + (observed.value.effect === 'corrected' ? 1 : 0),
      );
      if (pending.result) ensure(isDeepStrictEqual(pending.result, JSON.parse(observed.bytes)));
      else
        this.run(
          'UPDATE binding_metadata_journal SET acknowledgement=? WHERE source=? AND external_id=? AND key=?',
          observed.bytes,
          o.source,
          o.external_id,
          key,
        );
    });
  }

  private statement(sql: string): Statement {
    ensure(!this.closed);
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private get<T>(sql: string, ...parameters: SQLQueryBindings[]): T | null {
    return this.statement(sql).get(...parameters) as T | null;
  }
  private run(sql: string, ...parameters: SQLQueryBindings[]) {
    return this.statement(sql).run(...parameters);
  }
  private atomic<T>(operation: () => T): T {
    ensure(!this.closed);
    try {
      return this.database.transaction(operation).immediate();
    } catch {
      // Native constraint errors and validator internals must not disclose source bodies.
      return fail();
    }
  }
  private binding(o: Owner): Binding | null {
    return this.get('SELECT * FROM binding_records WHERE source=? AND external_id=?', o.source, o.external_id);
  }
  private bound(o: Owner): Binding & { subject: string } {
    const row = this.binding(o);
    ensure(row?.state === 'bound' && row.subject !== null);
    return row as Binding & { subject: string };
  }
  private entry(o: Owner, key: string): Entry | null {
    return this.get(
      'SELECT key, bytes, signature, acknowledgement FROM binding_journal WHERE source=? AND external_id=? AND key=?',
      o.source,
      o.external_id,
      key,
    );
  }
  private mediaEntry(o: Owner, key: string): MediaEntry | null {
    return this.get(
      'SELECT key, bytes, signature, accepted, status FROM binding_media WHERE source=? AND external_id=? AND key=?',
      o.source,
      o.external_id,
      key,
    );
  }
  private candidate(o: Owner, group: FieldGroup, id: string): Candidate | null {
    return this.get(
      'SELECT key, bytes, signature, candidate, subject, field_group FROM binding_candidates WHERE source=? AND external_id=? AND field_group=? AND candidate=?',
      o.source,
      o.external_id,
      group,
      id,
    );
  }
  private changeCapacity(o: Owner, group: FieldGroup, delta: 1 | -1) {
    this.run(
      'UPDATE binding_groups SET candidate_count=candidate_count+? WHERE source=? AND external_id=? AND field_group=?',
      delta,
      o.source,
      o.external_id,
      group,
    );
    this.run(
      'UPDATE binding_records SET candidate_count=candidate_count+? WHERE source=? AND external_id=?',
      delta,
      o.source,
      o.external_id,
    );
  }

  /**
   * Reserve one create/propose/retract request before sending. Replay must match bytes and signature.
   * Recover an uncertain bootstrap through journal(owner, originalKey), even if source data changed.
   * Pending proposals reserve the same capacity as current acknowledged candidates until retracted.
   */
  prepare(input: Owner, signature: string, request: BatchWriteRequest): Journal {
    const o = ownerInput(input);
    text(signature, 128);
    const { value, bytes } = snapshot(request);
    ensure(checkBatch(value).length === 0 && value.commands.length === 1);
    const command = value.commands[0]!;
    requestKey(o, command.key);
    ensure(command.source.source === o.source && command.source.external_id === o.external_id);
    if (command.op === 'create') ensure(!Object.hasOwn(command.subject, 'statements'));
    return this.atomic(() => {
      const binding = this.binding(o);
      ensure(binding?.state !== 'taken-down');
      const prior = this.entry(o, command.key);
      if (prior) {
        ensure(prior.bytes === bytes && prior.signature === signature);
        return journal(prior);
      }
      if (command.op === 'create') {
        ensure(binding === null);
        this.run(
          'INSERT INTO binding_records (source, external_id, state, subject, bootstrap_key, candidate_count, cover_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
          o.source,
          o.external_id,
          'pending',
          null,
          command.key,
          0,
          null,
        );
      } else {
        ensure(binding?.state === 'bound' && command.subject === binding.subject);
        const group = command.source.field_group;
        if (command.op === 'propose') {
          const capacity = this.get<{ candidate_count: number }>(
            'SELECT candidate_count FROM binding_groups WHERE source=? AND external_id=? AND field_group=?',
            o.source,
            o.external_id,
            group,
          );
          ensure((capacity?.candidate_count ?? 0) < 100 && binding.candidate_count < 300);
          if (!capacity)
            this.run(
              'INSERT INTO binding_groups (source, external_id, field_group, candidate_count) VALUES (?, ?, ?, ?)',
              o.source,
              o.external_id,
              group,
              0,
            );
          this.changeCapacity(o, group, 1);
        } else {
          const current = this.candidate(o, group, command.candidate);
          ensure(current && current.subject === command.subject);
        }
      }
      this.run(
        'INSERT INTO binding_journal (source, external_id, key, bytes, signature, acknowledgement) VALUES (?, ?, ?, ?, ?, ?)',
        o.source,
        o.external_id,
        command.key,
        bytes,
        signature,
        null,
      );
      return { key: command.key, bytes, signature };
    });
  }

  /** Seek the original serialized request by exact owner/key, including retired journals. */
  journal(input: Owner, key: string): Journal | null {
    const o = ownerInput(input);
    requestKey(o, key);
    const row = this.entry(o, key);
    return row ? journal(row) : null;
  }

  /** Bind only a matching successful public command result; exact acknowledgements are replayable. */
  acknowledge(input: Owner, key: string, result: BatchWriteResult): void {
    const o = ownerInput(input);
    requestKey(o, key);
    const { value, bytes } = snapshot(result);
    ensure(checkResult(value).length === 0 && value.results.length === 1);
    const response = value.results[0]!;
    ensure(response.key === key && (response.status === 200 || response.status === 201) && 'value' in response);
    const returned = response.value;
    this.atomic(() => {
      const binding = this.binding(o);
      ensure(binding && binding.state !== 'taken-down');
      const entry = this.entry(o, key);
      ensure(entry);
      const command = (JSON.parse(entry.bytes) as BatchWriteRequest).commands[0]!;
      const member = command.op === 'create' ? 'id' : command.op === 'propose' ? 'candidate' : null;
      ensure(Object.keys(returned).length === (member ? 2 : 1));
      if (member) ensure(member in returned);
      if (entry.acknowledgement !== null) {
        ensure(isDeepStrictEqual(snapshot(JSON.parse(entry.acknowledgement)).value, value));
        return;
      }
      if (command.op === 'create') {
        ensure(binding.state === 'pending' && binding.bootstrap_key === key && 'id' in returned);
        this.run(
          'UPDATE binding_records SET state=?, subject=? WHERE source=? AND external_id=?',
          'bound',
          returned.id,
          o.source,
          o.external_id,
        );
      } else {
        ensure(binding.state === 'bound' && binding.subject === command.subject);
        const group = command.source.field_group;
        if (command.op === 'propose') {
          ensure('candidate' in returned && !this.candidate(o, group, returned.candidate));
          this.run(
            'INSERT INTO binding_candidates (source, external_id, field_group, candidate, subject, key, bytes, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            o.source,
            o.external_id,
            group,
            returned.candidate,
            command.subject,
            key,
            entry.bytes,
            entry.signature,
          );
        } else {
          const current = this.candidate(o, group, command.candidate);
          ensure(current && current.subject === command.subject);
          this.run(
            'DELETE FROM binding_candidates WHERE source=? AND external_id=? AND field_group=? AND candidate=?',
            o.source,
            o.external_id,
            group,
            command.candidate,
          );
          this.changeCapacity(o, group, -1);
        }
      }
      this.run(
        'UPDATE binding_journal SET acknowledgement=? WHERE source=? AND external_id=? AND key=?',
        bytes,
        o.source,
        o.external_id,
        key,
      );
    });
  }

  /** Read the durable bootstrap observation, with no current-record baseline metadata. */
  claim(input: Owner): Claim | null {
    const row = this.binding(ownerInput(input));
    if (!row) return null;
    return row.state === 'bound' ? { state: 'bound', subject: row.subject! } : { state: row.state };
  }

  /** Record an actual remote 404. Terminal claims cannot be recreated or acknowledged. */
  takenDown(input: Owner, response: { status: 404 }): void {
    const o = ownerInput(input);
    const { value } = snapshot(response);
    ensure(Object.keys(value).length === 1 && value.status === 404);
    this.atomic(() => {
      const row = this.binding(o);
      ensure(row && (row.state === 'bound' || row.state === 'taken-down'));
      this.run(
        'UPDATE binding_records SET state=? WHERE source=? AND external_id=?',
        'taken-down',
        o.source,
        o.external_id,
      );
    });
  }

  /** Keyset page of current owned candidates for exactly this record/group, at most 100. */
  candidates(input: Owner, group: FieldGroup, page: { after?: string; limit: number }): Candidate[] {
    const o = ownerInput(input);
    groupInput(group);
    const { value } = snapshot(page);
    ensure(Object.keys(value).every((key) => key === 'after' || key === 'limit'));
    ensure(Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 100);
    if (value.after !== undefined) ensure(typeof value.after === 'string' && UUID.test(value.after));
    return this.statement(
      'SELECT key, bytes, signature, candidate, subject, field_group FROM binding_candidates WHERE source=? AND external_id=? AND field_group=? AND candidate>? ORDER BY candidate LIMIT ?',
    ).all(o.source, o.external_id, group, value.after ?? '', value.limit) as Candidate[];
  }

  /** Persist the complete portable media POST body and caller key before transport. A new key selects a new current job. */
  prepareMedia(input: Owner, key: string, signature: string, request: MediaImportRequest): PendingMedia {
    const o = ownerInput(input);
    requestKey(o, key);
    text(signature, 128);
    const { value, bytes } = snapshot(request);
    ensure(checkRequest(value).length === 0);
    ensure(value.provenance.source === o.source && value.provenance.external_id === o.external_id);
    return this.atomic(() => {
      const binding = this.bound(o);
      ensure(value.containerId === binding.subject);
      const prior = this.mediaEntry(o, key);
      if (prior) {
        ensure(prior.bytes === bytes && prior.signature === signature);
        return mediaJournal(prior);
      }
      this.run(
        'INSERT INTO binding_media (source, external_id, key, bytes, signature, accepted, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        o.source,
        o.external_id,
        key,
        bytes,
        signature,
        null,
        null,
      );
      this.run('UPDATE binding_records SET cover_key=? WHERE source=? AND external_id=?', key, o.source, o.external_id);
      return { key, bytes, signature, accepted: null, status: null };
    });
  }

  /** Store the actual HTTP 202 reserved receipt; acceptance never exposes an available media ID. */
  acceptMedia(input: Owner, key: string, response: MediaImportAccepted): void {
    const o = ownerInput(input);
    requestKey(o, key);
    const { value, bytes } = snapshot(response);
    ensure([...Errors(MediaImportAcceptedSchema, value)[1]].length === 0);
    this.atomic(() => {
      const binding = this.bound(o);
      const entry = this.mediaEntry(o, key);
      ensure(entry && value.media.containerId === binding.subject);
      const request = JSON.parse(entry.bytes) as MediaImportRequest;
      ensure(value.media.containerId === request.containerId);
      if (entry.accepted !== null) {
        ensure(isDeepStrictEqual(snapshot(JSON.parse(entry.accepted)).value, value));
        return;
      }
      this.run(
        'UPDATE binding_media SET accepted=? WHERE source=? AND external_id=? AND key=?',
        bytes,
        o.source,
        o.external_id,
        key,
      );
    });
  }

  /** Store a typed poll snapshot preserving reserved identity, original credit and provenance. Rejection is terminal. */
  observeMedia(input: Owner, key: string, response: MediaImportStatus): void {
    const o = ownerInput(input);
    requestKey(o, key);
    const { value, bytes } = snapshot(response);
    ensure(checkMediaImportStatus(value).length === 0);
    this.atomic(() => {
      this.bound(o);
      const entry = this.mediaEntry(o, key);
      ensure(entry && entry.accepted !== null);
      const accepted = JSON.parse(entry.accepted) as MediaImportAccepted;
      const request = JSON.parse(entry.bytes) as MediaImportRequest;
      ensure(
        value.media.id === accepted.media.id &&
          value.media.containerId === accepted.media.containerId &&
          value.media.purpose === accepted.media.purpose &&
          isDeepStrictEqual(value.media.credit, snapshot(request.credit).value) &&
          isDeepStrictEqual(value.media.provenance, snapshot(request.provenance).value),
      );
      if (entry.status !== null) {
        const prior = JSON.parse(entry.status) as MediaImportStatus;
        if (prior.media.state === 'rejected') {
          ensure(isDeepStrictEqual(snapshot(prior).value, value));
          return;
        }
      }
      this.run(
        'UPDATE binding_media SET status=? WHERE source=? AND external_id=? AND key=?',
        bytes,
        o.source,
        o.external_id,
        key,
      );
    });
  }

  /** Exact durable request/receipt/status lookup; no journal history enumeration. */
  mediaPending(input: Owner, key: string): PendingMedia | null {
    const o = ownerInput(input);
    requestKey(o, key);
    const entry = this.mediaEntry(o, key);
    return entry ? mediaJournal(entry) : null;
  }

  /** Exact current-intent points keep an unadmitted asset eligible on an unchanged source refresh. */
  hasUnsubmittedMedia(input: Owner, digest: string): boolean {
    const o = ownerInput(input);
    ensure(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
    const binding = this.binding(o);
    if (!binding?.cover_key) return false;
    const entry = this.mediaEntry(o, binding.cover_key);
    return entry?.accepted === null && (JSON.parse(entry.bytes) as MediaImportRequest).provenance.digest === digest;
  }

  /** The current job contributes a cover ID only after a real matching available snapshot. */
  mediaIds(input: Owner): { cover?: string } {
    const o = ownerInput(input);
    const binding = this.binding(o);
    if (binding?.state !== 'bound' || !binding.cover_key) return {};
    const entry = this.mediaEntry(o, binding.cover_key);
    if (!entry?.status) return {};
    const status = JSON.parse(entry.status) as MediaImportStatus;
    return status.media.state === 'available' ? { cover: status.media.id } : {};
  }

  /** Finalize this instance's statements. Never closes the caller's DB or deletes durable observations. */
  close(): void {
    if (this.closed) return;
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    this.closed = true;
  }
}
