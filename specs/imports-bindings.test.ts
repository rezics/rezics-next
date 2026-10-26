import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  checkBatchWrite,
  checkBatchWriteResult,
  type BatchWriteRequest,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import {
  checkMediaImportRequest,
  checkMediaImportStatus,
  MediaImportAcceptedSchema,
  type MediaImportRequest,
  type MediaImportStatus,
} from '@rezics/definitions/media-import';
import { assertGrowth, type GrowthSample } from '../services/kernel/test/support/growth-bound.ts';
import { createSqliteProbe } from '../services/importer/tests/support/sqlite-growth.ts';
import {
  CAPS,
  MISSING_BINDINGS_DRIVER,
  type OpenRecordBindings,
  type Owner,
  type RecordBindings,
} from './imports-bindings-driver.ts';

// Use the schema engine installed by definitions, without a second validator.
const { Errors } = createRequire(import.meta.resolve('@rezics/definitions/media-import'))('typebox/schema') as {
  Errors(schema: unknown, input: unknown): [unknown, Iterable<unknown>];
};

// These deterministic IDs are fixture public responses at the external boundary.
// They prove local durable observations, never Auth, HTTP/API or kernel authority.
const uuid = (n: number) => `00000000-0000-8000-8000-${n.toString(16).padStart(12, '0')}`;
const SUBJECT = uuid(1),
  CANDIDATE = uuid(2),
  MEDIA = uuid(3);
const owner = (external_id = 'Q1', source = 'wikidata'): Owner => ({ source, external_id });
const PRIVATE = 'PRIVATE_TOKEN_SENTINEL_NEVER_ECHO';
const provenance = (o = owner(), field_group: 'facts' | 'cover' = 'facts') => ({
  ...o,
  record_revision: 'unversioned',
  digest: 'a'.repeat(64),
  converter_revision: 'bindings-fixture-v1',
  field_group,
});
const refs = [
  {
    parts: [
      {
        property: { id: 'schema:sameAs' },
        value: { type: 'value' as const, content: 'https://www.wikidata.org/wiki/Q1' },
      },
    ],
  },
];
const key = (o: Owner, suffix: string) => `${o.source}:${o.external_id}:${suffix}`;
function create(o = owner(), suffix = 'create'): BatchWriteRequest {
  return {
    commands: [
      {
        op: 'create',
        key: key(o, suffix),
        source: provenance(o),
        subject: {
          type: 'schema:Book',
          labels: { en: 'Fixture book' },
          descriptions: { en: 'A book' },
          aliases: { en: ['Fixture'] },
        },
      },
    ],
  };
}
function propose(o = owner(), suffix = 'title', subject = SUBJECT): BatchWriteRequest {
  return {
    commands: [
      {
        op: 'propose',
        key: key(o, suffix),
        source: provenance(o),
        subject,
        statement: {
          property: { id: 'schema:name' },
          value: { type: 'value', content: { language: 'en', text: suffix } },
          references: refs,
        },
      },
    ],
  };
}
function retract(o = owner(), candidate = CANDIDATE, suffix = 'retract'): BatchWriteRequest {
  return {
    commands: [
      { op: 'retract', key: key(o, suffix), source: provenance(o), subject: SUBJECT, candidate, references: refs },
    ],
  };
}
function result(
  k: string,
  value: { id: string; revision: number } | { candidate: string; revision: number } | { revision: number },
  status: 200 | 201 = 201,
): BatchWriteResult {
  const response = { results: [{ key: k, status, value }] };
  expect(checkBatchWriteResult(response)).toEqual([]);
  return response;
}
function media(o = owner()): MediaImportRequest {
  const request = {
    containerId: SUBJECT,
    sourceUrl: 'https://images.example.org/cover.jpg',
    credit: {
      rightsHolder: '(c) rights holder',
      via: { name: 'Wikidata', url: 'https://www.wikidata.org/wiki/Q1' },
      license: 'LicenseRef-unknown',
      obligations: [],
    },
    provenance: { ...provenance(o, 'cover'), field_group: 'cover' as const, references: refs },
  };
  expect(checkMediaImportRequest(request)).toEqual([]);
  return request;
}
function accepted(id = MEDIA) {
  const response = { media: { id, containerId: SUBJECT, purpose: 'cover' as const, state: 'reserved' as const } };
  expect([...Errors(MediaImportAcceptedSchema, response)[1]]).toEqual([]);
  return response;
}
function status(state: 'reserved' | 'uploaded' | 'available' | 'rejected', o = owner()): MediaImportStatus {
  const request = media(o);
  const measured = state === 'uploaded' || state === 'available';
  const response = {
    media: {
      ...accepted().media,
      state,
      credit: request.credit,
      provenance: request.provenance,
      byteCount: measured ? 123 : null,
      mediaType: measured ? 'image/webp' : null,
      sha256: measured ? 'b'.repeat(64) : null,
      ...(state === 'rejected' ? { rejection: { code: 'source-denied' } } : {}),
    },
  };
  expect(checkMediaImportStatus(response)).toEqual([]);
  return response as MediaImportStatus;
}
async function harness(run: (h: Harness) => void) {
  const module = process.env.IMPORT_BINDINGS_DRIVER;
  if (!module) throw new Error(MISSING_BINDINGS_DRIVER);
  const binding = (await import(resolve(module))) as { openRecordBindings: OpenRecordBindings };
  expect(typeof binding.openRecordBindings).toBe('function');
  const directory = mkdtempSync(join(tmpdir(), 'import-bindings-'));
  const h = new Harness(resolve(directory, 'bindings.sqlite'), binding.openRecordBindings);
  try {
    run(h);
  } finally {
    h.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
class Harness {
  db!: Database;
  probe!: ReturnType<typeof createSqliteProbe>;
  d!: RecordBindings;
  constructor(
    readonly path: string,
    readonly open: OpenRecordBindings,
  ) {
    this.reopen();
  }
  reopen() {
    if (this.db) this.close();
    this.db = new Database(this.path, { create: true });
    // Instrument BEFORE constructor preparation; no other handle reaches store.
    this.probe = createSqliteProbe(this.db, { growingTables: [] });
    this.d = this.open(this.probe.database);
  }
  close() {
    this.d?.close();
    this.db?.close();
  }
  prepare(request = create(), o = owner(), signature = 'signature-v1') {
    expect(checkBatchWrite(request)).toEqual([]);
    const journal = this.d.prepare(o, signature, request);
    expect(journal).toEqual({ key: request.commands[0]!.key, signature, bytes: JSON.stringify(request) });
    return journal;
  }
  bind(o = owner(), id = SUBJECT) {
    const journal = this.prepare(create(o), o);
    this.d.acknowledge(o, journal.key, result(journal.key, { id, revision: 1 }));
  }
  /** Privacy-only enumeration; never used for API/CLI counts or measured work. */
  persisted() {
    const tables = this.db
      .query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
    return tables.map(({ name }) => ({
      name,
      rows: this.db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    }));
  }
}
function reject(operation: () => unknown) {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(String(error)).not.toContain(PRIVATE);
}
/** Supplement the shared scan rejection with actual declared-index prefix proof.
 * Introspection runs outside measurement, never supplies substitute cost counters.
 */
function indexedPrefixes(db: Database, executions: ReturnType<ReturnType<typeof createSqliteProbe>['verifyPlans']>) {
  const tables = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
    name: string;
  }[];
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const indexes = tables.flatMap(({ name }) => {
    const columns = db.query(`PRAGMA table_info(${quote(name)})`).all() as { name: string; pk: number; type: string }[];
    const declared = db.query(`PRAGMA index_list(${quote(name)})`).all() as { name: string; unique: number }[];
    return [
      ...declared.map((index) => ({
        name: index.name,
        unique: Boolean(index.unique),
        columns: (db.query(`PRAGMA index_info(${quote(index.name)})`).all() as { name: string }[]).map((c) => c.name),
      })),
      {
        name: `PRIMARY:${name}`,
        unique: true,
        columns: columns
          .filter((c) => c.pk)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name),
      },
    ];
  });
  for (const execution of executions)
    for (const node of execution.plan) {
      if (!/^SEARCH /i.test(node.detail)) continue; // Shared probe rejects all growing SCAN nodes.
      const match = /USING (?:COVERING )?(?:INDEX ([^ ]+)|INTEGER PRIMARY KEY|PRIMARY KEY) \((.+)\)/i.exec(node.detail);
      expect(match).not.toBeNull();
      const constraints = match![2]!;
      if (/INTEGER PRIMARY KEY/.test(node.detail)) {
        expect(constraints).toMatch(/rowid=\?/);
        continue;
      }
      const index = match![1]
        ? indexes.find((i) => i.name === match![1])
        : indexes.find((i) => i.name === `PRIMARY:${node.detail.split(' ')[1]}`);
      expect(index).toBeDefined();
      const equality = (column: string) => constraints.split(' AND ').includes(`${column}=?`);
      expect(equality(index!.columns[0]!)).toBe(true);
      if (!(index!.unique && index!.columns.every(equality))) {
        expect(index!.columns.length).toBeGreaterThanOrEqual(2);
        expect(constraints.split(' AND ').length).toBeGreaterThanOrEqual(2);
        expect(execution.sql).toMatch(/\bLIMIT\s+(?:\?|[:@$]\w+|\d+)/i);
        expect(execution.rows).toBeLessThanOrEqual(CAPS.page);
      }
    }
}
const unsafe = <T>(input: unknown) => input as T;

test('claim candidate and media bindings are durable bounded public-result observations', async () =>
  harness((h) => {
    const o = owner();
    const pending = h.prepare();
    expect(h.d.claim(o)).toEqual({ state: 'pending' });
    h.reopen();
    expect(h.d.journal(o, pending.key)).toEqual(pending);
    const changed = create();
    if (changed.commands[0]!.op === 'create') changed.commands[0]!.subject.labels.en = 'Changed during uncertainty';
    reject(() => h.d.prepare(o, 'changed', changed));
    reject(() => h.d.prepare(o, 'changed-key', create(o, 'changed-key')));
    expect(h.d.journal(o, pending.key)).toEqual(pending);
    for (const bad of [
      result('wrong-key', { id: SUBJECT, revision: 1 }),
      result(pending.key, { candidate: CANDIDATE, revision: 1 }),
      { results: [] },
    ])
      reject(() => h.d.acknowledge(o, pending.key, unsafe(bad)));
    expect(h.d.claim(o)).toEqual({ state: 'pending' });
    const ack = result(pending.key, { id: SUBJECT, revision: 1 }, 200);
    h.d.acknowledge(o, pending.key, ack);
    h.reopen();
    h.d.acknowledge(o, pending.key, ack);
    expect(h.d.claim(o)).toEqual({ state: 'bound', subject: SUBJECT });
    reject(() => h.d.acknowledge(o, pending.key, result(pending.key, { id: uuid(99), revision: 1 })));
    reject(() => h.d.prepare(o, 'another-create', create(o, 'another-create')));
    // A refresh proposes against the actual resolved subject without a new create.
    const proposal = h.prepare(propose(), o, 'title-signature');
    const proposalAck = result(proposal.key, { candidate: CANDIDATE, revision: 2 });
    h.d.acknowledge(o, proposal.key, proposalAck);
    h.reopen(); // crash after remote success; replay original journal/result.
    h.d.acknowledge(o, proposal.key, proposalAck);
    const current = [{ ...proposal, candidate: CANDIDATE, subject: SUBJECT, field_group: 'facts' as const }];
    expect(h.d.candidates(o, 'facts', { limit: 10 })).toEqual(current);
    expect(h.d.candidates(o, 'facts', { after: CANDIDATE, limit: 10 })).toEqual([]);
    for (const other of [owner('Q2'), owner('Q1', 'wikidata_alias')]) {
      expect(h.d.claim(other)).toBeNull();
      expect(h.d.candidates(other, 'facts', { limit: 10 })).toEqual([]);
      reject(() => h.d.acknowledge(other, proposal.key, proposalAck));
      h.bind(other, uuid(90));
      expect(h.d.claim(other)).toEqual({ state: 'bound', subject: uuid(90) });
      expect(h.d.candidates(other, 'facts', { limit: 10 })).toEqual([]);
    }
    reject(() => h.d.prepare(o, 'wrong-subject', propose(o, 'wrong-subject', uuid(99))));
    reject(() => h.d.prepare(o, 'wrong-source', propose(owner('Q2'))));
    const wrongGroup = propose(o, 'wrong-group');
    wrongGroup.commands[0]!.source.field_group = 'summary';
    reject(() => h.d.prepare(o, 'wrong-group', wrongGroup));
    reject(() => h.d.acknowledge(o, proposal.key, result(proposal.key, { candidate: uuid(99), revision: 2 })));
    reject(() => h.d.prepare(o, 'community', retract(o, uuid(99), 'community')));
    const wrongRemoval = retract(o, CANDIDATE, 'wrong-group-remove');
    wrongRemoval.commands[0]!.source.field_group = 'summary';
    expect(checkBatchWrite(wrongRemoval)).toEqual([]);
    reject(() => h.d.prepare(o, 'wrong-group-remove', wrongRemoval));
    const removal = h.prepare(retract(), o, 'remove-signature');
    expect(h.d.candidates(o, 'facts', { limit: 10 })).toEqual(current);
    reject(() => h.d.acknowledge(o, removal.key, result(removal.key, { id: SUBJECT, revision: 3 })));
    const removed = result(removal.key, { revision: 3 }, 200);
    h.d.acknowledge(o, removal.key, removed);
    h.reopen();
    h.d.acknowledge(o, removal.key, removed);
    expect(h.d.candidates(o, 'facts', { limit: 10 })).toEqual([]);
    expect(h.d.journal(o, proposal.key)).toEqual(proposal);
    h.d.takenDown(o, { status: 404 });
    h.reopen();
    expect(h.d.claim(o)).toEqual({ state: 'taken-down' });
    reject(() => h.d.prepare(o, 'resurrect', create(o, 'resurrect')));
    reject(() => h.d.acknowledge(o, pending.key, ack));
  }));

test('media journals retain exact public requests and only available matching snapshots feed conversion', async () =>
  harness((h) => {
    const o = owner();
    h.bind();
    const request = media();
    const k = key(o, 'cover-v1');
    const pending = h.d.prepareMedia(o, k, 'image-url-version-v1', request);
    expect(pending).toEqual({
      key: k,
      signature: 'image-url-version-v1',
      bytes: JSON.stringify(request),
      accepted: null,
      status: null,
    });
    h.reopen();
    expect(h.d.mediaPending(o, k)).toEqual(pending);
    expect(h.d.mediaIds(o)).toEqual({});
    const changed = { ...request, sourceUrl: 'https://images.example.org/changed.jpg' };
    reject(() => h.d.prepareMedia(o, k, 'changed', changed));
    for (const bad of [
      { media: { ...accepted().media, containerId: uuid(99) } },
      { media: { ...accepted().media, purpose: 'avatar' } },
      {},
    ]) {
      reject(() => h.d.acceptMedia(o, k, unsafe(bad)));
    }
    reject(() => h.d.observeMedia(o, k, status('available')));
    expect(h.d.mediaPending(o, k)).toEqual(pending);
    const receipt = accepted();
    h.d.acceptMedia(o, k, receipt);
    h.reopen();
    h.d.acceptMedia(o, k, receipt);
    expect(h.d.mediaPending(o, k)).toEqual({ ...pending, accepted: receipt });
    reject(() => h.d.acceptMedia(o, k, accepted(uuid(99))));
    reject(() => h.d.acceptMedia(owner('Q2'), k, receipt));
    reject(() => h.d.acceptMedia(o, 'wrong-key', receipt));
    for (const state of ['reserved', 'uploaded'] as const) {
      const snapshot = status(state);
      h.d.observeMedia(o, k, snapshot);
      h.reopen();
      expect(h.d.mediaPending(o, k)?.status).toEqual(snapshot);
      expect(h.d.mediaIds(o)).toEqual({});
    }
    const available = status('available');
    for (const bad of [
      { media: { ...available.media, id: uuid(99) } },
      { media: { ...available.media, containerId: uuid(99) } },
      { media: { ...available.media, purpose: 'avatar' } },
      { media: { ...available.media, provenance: provenance(owner('Q2'), 'cover') } },
      { media: { ...available.media, credit: { ...request.credit, license: 'CC0-1.0' } } },
      { media: { ...available.media, byteCount: null } },
      { media: { ...available.media, sha256: 'invented' } },
      { media: { ...available.media, privateToken: PRIVATE } },
    ])
      reject(() => h.d.observeMedia(o, k, unsafe(bad)));
    expect(h.d.mediaPending(o, k)?.status).toEqual(status('uploaded'));
    h.d.observeMedia(o, k, available);
    h.reopen();
    expect(h.d.mediaPending(o, k)?.status).toEqual(available);
    expect(h.d.mediaIds(o)).toEqual({ cover: MEDIA });
    expect(h.d.mediaIds(owner('Q1', 'wikidata_alias'))).toEqual({});
    // Coordinator supplies a fresh URL/version identity; store does not decide it.
    const next = key(o, 'cover-v2');
    h.d.prepareMedia(o, next, 'image-url-version-v2', changed);
    h.d.acceptMedia(o, next, accepted(uuid(4)));
    const rejected = status('rejected');
    rejected.media.id = uuid(4);
    h.d.observeMedia(o, next, rejected);
    h.reopen();
    h.d.observeMedia(o, next, rejected);
    expect(h.d.mediaPending(o, next)?.status).toEqual(rejected);
    expect(h.d.mediaIds(o)).toEqual({});
    const resurrection = status('available');
    resurrection.media.id = uuid(4);
    reject(() => h.d.observeMedia(o, next, resurrection));
    expect(h.d.mediaPending(o, next)?.status).toEqual(rejected);
    expect(JSON.stringify(h.persisted())).not.toContain(PRIVATE);
  }));

test('bounded sanitized JSON rejects hostile objects atomically without private diagnostics', async () =>
  harness((h) => {
    h.bind();
    const o = owner();
    const before = h.persisted();
    let invoked = 0;
    const accessor = propose();
    Object.defineProperty(accessor, 'commands', {
      get() {
        invoked++;
        throw new Error(PRIVATE);
      },
    });
    const toJSON = {
      ...propose(),
      toJSON() {
        invoked++;
        throw new Error(PRIVATE);
      },
    };
    const hidden = propose();
    Object.defineProperty(hidden, 'secret', { value: PRIVATE, enumerable: false });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = PRIVATE;
    for (let i = 0; i < CAPS.depth + 1; i++) deep = { nested: deep };
    for (const bad of [
      accessor,
      toJSON,
      hidden,
      { ...propose(), cycle },
      { ...propose(), deep },
      { ...propose(), number: Infinity },
      { ...propose(), number: NaN },
      { ...propose(), private: PRIVATE.repeat(CAPS.requestBytes) },
      { commands: Array.from({ length: 101 }, () => propose().commands[0]) },
    ]) {
      reject(() => h.d.prepare(o, 'unsafe', unsafe(bad)));
      expect(h.persisted()).toEqual(before);
    }
    expect(invoked).toBe(0);
    for (const badOwner of [
      owner('x'.repeat(CAPS.externalId + 1)),
      owner('Q1', 'x'.repeat(CAPS.source + 1)),
      owner(PRIVATE),
    ]) {
      reject(() => h.d.prepare(badOwner, 'unsafe', create()));
      expect(h.persisted()).toEqual(before);
    }
    const randomKey = propose();
    randomKey.commands[0]!.key = uuid(50);
    reject(() => h.d.prepare(o, 'random-native-key', randomKey));
    const longKey = propose();
    longKey.commands[0]!.key = 'x'.repeat(CAPS.key + 1);
    reject(() => h.d.prepare(o, 'unsafe', longKey));
    reject(() => h.d.prepare(o, 'x'.repeat(CAPS.signature + 1), propose()));
    const withStatements = create();
    Object.assign(withStatements.commands[0]!.subject, { statements: {} });
    reject(() => h.d.prepare(o, 'unsupported-bootstrap', withStatements));
    const journal = h.prepare(propose(), o);
    const checkpoint = h.persisted();
    for (const bad of [
      { results: [], private: PRIVATE.repeat(CAPS.responseBytes) },
      { results: [{ key: journal.key, status: 201, value: { candidate: CANDIDATE, revision: NaN } }] },
      Object.defineProperty({}, 'results', {
        enumerable: true,
        get() {
          invoked++;
          throw new Error(PRIVATE);
        },
      }),
    ]) {
      reject(() => h.d.acknowledge(o, journal.key, unsafe(bad)));
      expect(h.persisted()).toEqual(checkpoint);
    }
    const mk = key(o, 'media');
    const request = media();
    for (const bad of [
      { ...request, sourceUrl: `https://example.org/${PRIVATE.repeat(4096)}` },
      Object.assign(Object.create({ inherited: PRIVATE }), request),
      {
        ...request,
        toJSON() {
          invoked++;
          throw new Error(PRIVATE);
        },
      },
    ])
      reject(() => h.d.prepareMedia(o, mk, 'media', unsafe(bad)));
    expect(h.persisted()).toEqual(checkpoint);
    expect(invoked).toBe(0);
    // Sanitized null-prototype JSON must remain accepted as ordinary JSON.
    const clean = JSON.parse(JSON.stringify(propose(o, 'null-prototype')), (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) return Object.assign(Object.create(null), v);
      return v;
    });
    expect(checkBatchWrite(clean)).toEqual([]);
    const sanitized = h.d.prepare(o, 'null-prototype', clean);
    expect(sanitized.bytes).toBe(JSON.stringify(clean));
    expect(JSON.stringify(h.persisted())).not.toContain(PRIVATE);
  }));

test('current owned candidate pages have hard per-group and per-record caps without retained current history', async () =>
  harness((h) => {
    h.bind();
    const o = owner();
    const expected = [];
    for (let i = 0; i < CAPS.groupCandidates; i++) {
      const journal = h.prepare(propose(o, `title-${i}`), o, `signature-${i}`);
      const candidate = uuid(1000 + i);
      h.d.acknowledge(o, journal.key, result(journal.key, { candidate, revision: i + 2 }));
      expected.push({ ...journal, candidate, subject: SUBJECT, field_group: 'facts' as const });
    }
    reject(() => h.d.prepare(o, 'over-cap', propose(o, 'over-cap')));
    for (const limit of [0, -1, 101, Infinity, NaN]) reject(() => h.d.candidates(o, 'facts', { limit }));
    const actual = [];
    let after: string | undefined;
    for (let n = 0; n < 16; n++) {
      const page = h.d.candidates(o, 'facts', { ...(after === undefined ? {} : { after }), limit: 7 });
      expect(page.length).toBeLessThanOrEqual(7);
      actual.push(...page);
      if (!page.length) break;
      after = page.at(-1)!.candidate;
    }
    expect(actual).toEqual(expected);
    for (const c of actual) {
      const removal = h.prepare(retract(o, c.candidate, `remove-${c.candidate}`), o, c.signature);
      h.d.acknowledge(o, removal.key, result(removal.key, { revision: 200 }, 200));
    }
    h.reopen();
    expect(h.d.candidates(o, 'facts', { limit: 100 })).toEqual([]);
    // Retired history does not consume the current capacity.
    const replacement = h.prepare(propose(o, 'replacement'), o);
    h.d.acknowledge(o, replacement.key, result(replacement.key, { candidate: uuid(9999), revision: 201 }));
    expect(h.d.candidates(o, 'facts', { limit: 100 })).toHaveLength(1);
  }));

test(
  'same-source growing SQLite history keeps fixed binding operations indexed with actual execution and row costs',
  async () =>
    harness((h) => {
      h.bind();
      const o = owner();
      const journal = h.prepare(propose(), o);
      const ack = result(journal.key, { candidate: CANDIDATE, revision: 2 });
      h.d.acknowledge(o, journal.key, ack);
      const mk = key(o, 'cover');
      h.d.prepareMedia(o, mk, 'cover-v1', media());
      h.d.acceptMedia(o, mk, accepted());
      const samples = new Map<string, GrowthSample[]>();
      let seeded = 0;
      for (const scale of [32, 128, 512]) {
        // One monotonically grown seed, SAME source/tables, including live mappings,
        // retired candidate journals and media history, outside measured operations.
        for (; seeded < scale; seeded++) {
          const other = owner(`unrelated-${seeded}`);
          h.bind(other, SUBJECT);
          for (let j = 0; j < 2; j++) {
            const p = h.prepare(propose(other, `history-${j}`), other, `signature-${j}`);
            const id = uuid(10000 + seeded * 2 + j);
            h.d.acknowledge(other, p.key, result(p.key, { candidate: id, revision: 2 }));
            if (j === 0) {
              const r = h.prepare(retract(other, id), other);
              h.d.acknowledge(other, r.key, result(r.key, { revision: 3 }, 200));
            }
            const k = key(other, `cover-${j}`);
            h.d.prepareMedia(other, k, `cover-${j}`, media(other));
            h.d.acceptMedia(other, k, accepted());
            h.d.observeMedia(other, k, status('rejected', other));
          }
        }
        h.db.exec('ANALYZE'); // Real statistics at EACH scale, outside measurement.
        const operations: [string, () => unknown][] = [
          ['get claim', () => h.d.claim(o)],
          ['candidate page M=1', () => h.d.candidates(o, 'facts', { limit: 1 })],
          ['pending media', () => h.d.mediaPending(o, mk)],
          ['replayed acknowledgement', () => h.d.acknowledge(o, journal.key, ack)],
        ];
        for (const [name, operation] of operations) {
          const measured = h.probe.measure(operation);
          expect(measured.cost.statements).toBeGreaterThan(0);
          expect(measured.cost.statements).toBeLessThanOrEqual(32);
          expect(measured.cost.rows).toBeLessThanOrEqual(32); // Fixed M, never U*t.
          expect(measured.cost.blocks).toBe(0); // SQLite buffer counters unavailable.
          expect(measured.cost.rows).toBe(measured.statements.reduce((sum, s) => sum + s.rows, 0));
          expect(measured.cost.statements).toBe(measured.statements.length);
          for (const execution of measured.statements) {
            expect(execution.parameters).toBeArray(); // Raw actual bindings, not flags.
            expect(execution.sql).not.toMatch(/\b(?:OFFSET|COUNT\s*\()/i);
          }
          if (name === 'get claim') expect(measured.value).toEqual({ state: 'bound', subject: SUBJECT });
          if (name === 'candidate page M=1')
            expect(measured.value).toEqual([
              { ...journal, candidate: CANDIDATE, subject: SUBJECT, field_group: 'facts' as const },
            ]);
          if (name === 'pending media') expect(measured.value).toMatchObject({ key: mk, accepted: accepted() });
          if (!samples.has(name)) samples.set(name, []);
          samples.get(name)!.push({ scale, cost: measured.cost });
        }
        // Shared real probe explains every executed SQL with its actual parameters,
        // including UPDATE/DELETE. It rejects scans/automatic indexes/temp B-trees.
        indexedPrefixes(h.db, h.probe.verifyPlans());
        expect(JSON.stringify(h.persisted())).not.toContain(PRIVATE);
      }
      for (const sample of samples.values()) {
        assertGrowth(sample, { rows: 'constant', blocks: 'constant', statements: 'constant' });
        expect(new Set(sample.map((s) => s.cost.statements)).size).toBe(1);
      }
    }),
  120_000,
);
