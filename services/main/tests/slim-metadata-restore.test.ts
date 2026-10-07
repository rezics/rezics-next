import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { CommandOutcomeUnknown, FusekiClient, type CommandEnvelope, type CommandHealth,
  type CommandResult, type CommandValidation, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { ReceiptCustody, type CustodyRow, type PreparedCommand, type ReceiptCustodySession,
  type ReceiptCustodyStore } from '../src/modules/outbox/receipt-custody.ts';
import * as relay from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { DATASET, GRAPHS, hash, prepareWorkComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { workEditReceiptIri } from '../src/modules/work/edit.ts';
import { METADATA_DETAILS_V2, METADATA_PROFILE, checkedEditionV2, checkedMetadataState, editionV2Digest, metadataDigest,
  type MetadataEditionState, type MetadataEditionStateV2 } from '../src/modules/work/metadata-schema.ts';
import { reconcileRetainedSlimMetadata } from '../src/modules/work/reconcile-slim-metadata.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const retainedEpoch = 'retained-epoch', epoch = 'restored-epoch', routingEpoch = 'restored-routing';
const diagnostic = '900', mainSequence = '4';
const prefix = 'urn:rezics:name-migration:metadata-restore:';
const rows = (values: Record<string, string>[]): SparqlResult => ({ results: { bindings: values.map(value =>
  Object.fromEntries(Object.entries(value).map(([key, text]) => [key, { type: 'literal' as const, value: text }]))) } });

class MemoryObjects implements ImmutableObjects {
  bytes = new Map<string, Uint8Array>();
  puts = 0;
  gets: string[] = [];
  async put(bytes: Uint8Array): Promise<string> {
    this.puts++; const digest = hash(bytes); this.bytes.set(digest, Uint8Array.from(bytes)); return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    this.gets.push(digest);
    const bytes = this.bytes.get(digest);
    if (!bytes) throw new ObjectUnavailable('exact source object missing');
    return Uint8Array.from(bytes);
  }
}

/** A read-only source fixture: restore is never allowed to reconcile live custody. */
class MemoryCustody implements ReceiptCustodyStore {
  row: CustodyRow | null = null;
  mutations = 0;
  async receiptAt(dataEpoch: string, streamSequence: string): Promise<string | null> {
    return this.row?.terminal?.dataEpoch === dataEpoch && this.row.terminal.streamSequence === streamSequence
      ? this.row.receipt : null;
  }
  async withReceipt<T>(receipt: string, operation: (session: ReceiptCustodySession) => Promise<T>): Promise<T> {
    const refuse = async () => { this.mutations++; throw new Error('committed source must remain read-only'); };
    return operation({ read: async () => this.row?.receipt === receipt ? this.row : null,
      prepare: refuse, reconcile: refuse, retire: refuse });
  }
}

class RestoreNative extends FusekiClient {
  commands: CommandEnvelope[] = [];
  queries: string[] = [];
  proof: CommandEnvelope | null = null;
  interrupt = false;
  loseResponse = false;
  stale = false;
  erased = false;
  ledgerErased = false;
  workSuppressed = false;
  rawUpdates = 0;
  diagnosticCursor = '700';
  mainCursor = '3';
  metadataHead: string | null = null;
  revision = id(4);
  component = id(3);
  manifest = '';
  model = METADATA_PROFILE;
  healthProfiles: Record<string, string> = Object.fromEntries(Object.entries(profileRegistry).map(([name, profile]) => [name, profile.sha256]));
  constructor() { super('http://localhost:1/product'); }
  override async update(): Promise<void> { this.rawUpdates++; throw new Error('raw update endpoint unavailable'); }
  override async commandHealth(): Promise<CommandHealth> {
    return { moduleVersion: COMMAND_MODULE_VERSION, instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false, profiles: this.healthProfiles };
  }
  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    if (this.interrupt) { this.interrupt = false; throw new CommandOutcomeUnknown('interrupted before restore commit'); }
    if (this.stale) return { status: 'guard-unmatched' };
    if (envelope.validations.some(validation => this.healthProfiles[validation.profile] !== validation.sha256)) {
      return { status: 'unknown-profile' };
    }
    if (this.erased) return { status: 'guard-unmatched' };
    this.proof = envelope;
    this.metadataHead = this.revision; this.diagnosticCursor = diagnostic; this.mainCursor = mainSequence;
    if (this.loseResponse) { this.loseResponse = false; throw new CommandOutcomeUnknown('lost committed restore response'); }
    return { status: 'committed', position: { datasetId: DATASET, dataEpoch: epoch, sequence: '0' } };
  }
  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('ASK') && sparql.includes('CreativeWork')) return { boolean: !this.erased && !this.workSuppressed };
    if (sparql.includes('ASK') && sparql.includes('a rv:ErasedRevision')) return { boolean: this.erased };
    if (sparql.includes('SELECT ?saved ?savedMain ?last ?lastMain')) {
      return rows([{ saved: '700', savedMain: '3',
        ...this.proof ? { last: this.diagnosticCursor, lastMain: this.mainCursor } : {} }]);
    }
    if (sparql.includes('ASK') && sparql.includes('rv:commandFamily "metadata-restore-v1"')) {
      return { boolean: !!this.proof && sparql.includes(`<${this.proof.receipt}>`)
        && sparql.includes(JSON.stringify(this.proof.digest)) };
    }
    if (sparql.includes('SELECT ?head ?work')) {
      return rows(this.metadataHead ? [{ head: this.metadataHead, work: id(5) }] : []);
    }
    if (sparql.includes('ASK') && sparql.includes('rv:sourcePayloadDigest')) {
      return { boolean: !!this.proof && this.diagnosticCursor === diagnostic && this.mainCursor === mainSequence };
    }
    if (sparql.includes('ASK') && sparql.includes('rv:metadataHead') && sparql.includes('rv:manifest')) {
      return { boolean: this.metadataHead === this.revision && sparql.includes(`<${this.manifest}>`)
        && sparql.includes(`<${this.model}>`) };
    }
    throw new Error(`Unconfigured native query: ${sparql}`);
  }
}

type EditionFixtureState = MetadataEditionState | MetadataEditionStateV2;
interface EditionFixtureOptions {
  state?: (state: EditionFixtureState) => EditionFixtureState;
  /** Adversarial source has exact object hashes but cannot have been admitted. */
  uncheckedState?: boolean;
}

async function fixture(version: 1 | 2 = 1, status: 'active' | 'withdrawn' = 'active',
  expectedHead: string | null = null, options: EditionFixtureOptions = {}) {
  const objects = new MemoryObjects(), store = new MemoryCustody(), native = new RestoreNative();
  const work = id(5), component = native.component, revision = native.revision, actingSubject = id(6);
  const admissionId = '00000000-0000-4000-8000-000000000007';
  let state: EditionFixtureState = version === 1
    ? { kind: 'edition', id: component, status, title: { value: 'Exact retained edition', language: 'ja' },
      contentLanguage: 'ja', editionStatement: 'First edition', publisher: 'Fixture Press', publicationYear: 2026,
      isbn13: '9780306406157' }
    : { kind: 'edition', id: component, status, title: { value: 'Exact retained bilingual edition', language: 'ja' },
      contentLanguages: ['en', 'ja'], isTranslation: true, originalLanguages: ['ja'], titleLanguage: 'ja',
      tracklistLanguage: null, editionStatement: null, publisher: 'Fixture Press', publicationYear: 2026, isbn13: null };
  state = options.state?.(state) ?? state;
  if (!options.uncheckedState) {
    const checked = version === 1 ? checkedMetadataState(state) : checkedEditionV2(state);
    if (checked.kind !== 'edition') throw new Error('Edition fixture requires edition state');
    state = checked;
  }
  const model = version === 1 ? METADATA_PROFILE : METADATA_DETAILS_V2;
  const digest = options.uncheckedState ? hash(JSON.stringify({ profile: model, work, expectedHead, state }))
    : version === 1 ? metadataDigest({ work, expectedHead, state: state as MetadataEditionState })
    : editionV2Digest({ work, expectedHead, state: state as MetadataEditionStateV2 });
  const receipt = workEditReceiptIri(admissionId);
  const manifestSha256 = await prepareWorkComponent(objects, component, { revision, intent: { work, expectedHead, state } }, model);
  const manifest = `urn:rezics:sha256:${manifestSha256}`;
  const manifestValue = JSON.parse(Buffer.from(await objects.get(manifestSha256)).toString('utf8')) as { payload: string };
  const componentPayloadSha256 = manifestValue.payload.slice(7);
  const validations: CommandValidation[] = [
    { profile: 'work-metadata-details-v1', sha256: profileRegistry['work-metadata-details-v1'].sha256,
      shape: `${METADATA_PROFILE}/work-shape`, focus: [work], graphs: [GRAPHS.current, GRAPHS.revisions] },
    ...['component', 'revision'].map(role => ({ profile: `work-metadata-details-v${version}`,
      sha256: profileRegistry[`work-metadata-details-v${version}`].sha256,
      shape: `${model}/${role}-shape`, focus: [role === 'component' ? component : revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] })),
  ];
  const shapeDigests = [...new Set(validations.map(value => value.sha256))];
  for (const profile of new Set(validations.map(value => value.profile))) {
    const entry = profileRegistry[profile as keyof typeof profileRegistry];
    const bytes = readFileSync(new URL(`../../../generated/model/${entry.file}`, import.meta.url));
    expect(await objects.put(bytes)).toBe(entry.sha256);
  }
  const prepared: PreparedCommand = { format: 'rezics-owner-command-v1', component, revision, manifest: manifestSha256,
    routingEpoch: 'retained-routing', state,
    envelope: { receipt, digest, update: 'INSERT DATA {}', validations, deadlineMs: 10_000 },
    receipt: { outcome: 'succeeded', receipt, admissionId, requestDigest: digest, authorityEpoch: '8',
      scope: `work:edit:${work}`, dataEpoch: retainedEpoch, work, component, revision,
      predecessor: expectedHead ?? component } };
  const commandBytes = Buffer.from(JSON.stringify(prepared)), payloadSha256 = await objects.put(commandBytes);
  const terminal = { ...prepared.receipt, sequence: diagnostic, streamSequence: mainSequence };
  const batchId = `urn:rezics:outbox:${hash(receipt)}`, eventId = `urn:rezics:event:${hash(receipt)}`;
  const event: relay.MainCloudEvent = { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
    type: version === 1 ? 'com.rezics.work.metadata-changed.v1' : 'com.rezics.work.metadata-revised.v1',
    datacontenttype: 'application/json', data: { batchId, routingEpoch: prepared.routingEpoch, ordinal: 0,
      sourcePosition: { datasetId: 'product', dataEpoch: retainedEpoch, sequence: diagnostic },
      relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: retainedEpoch, sequence: mainSequence },
      receipt: { id: receipt, action: 'work.edit', outcome: 'succeeded', admissionId, requestDigest: digest,
        authorityEpoch: '8', scope: prepared.receipt.scope,
        ...(version === 1 ? { metadata: { work, component, revision, manifest } }
          : { work, component, revision, contentLanguages: (state as MetadataEditionStateV2).contentLanguages }) } } };
  const outbox = { batchId, streamScope: MAIN_RELAY_STREAM_SCOPE as typeof MAIN_RELAY_STREAM_SCOPE,
    dataEpoch: retainedEpoch, sequence: mainSequence, graphSequence: diagnostic,
    routingEpoch: prepared.routingEpoch, eventCount: 1, events: [event] };
  store.row = { receipt, requestDigest: digest, payloadSha256, payload: commandBytes, revision, terminal,
    reconciled: true, retired: true, outbox };
  let sourceQueries = 0;
  const custody = new ReceiptCustody(store, objects, { query: async () => {
    sourceQueries++; throw new Error('retired committed source must not probe native live proof');
  } }, 'a'.repeat(64), async () => { throw new Error('restore cannot retire original source'); });
  native.manifest = manifest; native.model = model;
  const env: WorkActivationEnvironment = { fuseki: native, lineage: { dataEpoch: epoch, routingEpoch },
    objectDirectory: '.temp/slim-metadata-restore-unused', workObjects: objects, receiptCustody: custody };
  const coverage: relay.RelayCoverage = { streamScope: MAIN_RELAY_STREAM_SCOPE, consumer: 'product', dataEpoch: retainedEpoch,
    sequence: mainSequence, batchCount: '4', eventCount: '4', batchDigest: 'b'.repeat(64), eventDigest: 'c'.repeat(64) };
  const retained = spyOn(relay, 'relayRetainedEventAt').mockResolvedValue({ eventId, envelope: event,
    batch: { batchId, routingEpoch: prepared.routingEpoch, eventCount: 1 } });
  const admission = { action: 'work.edit', state: 'sealed', scope_id: prepared.receipt.scope,
    request_digest: digest, authority_epoch: '8', acting_subject: actingSubject,
    graph_receipt: receipt, graph_outcome: 'succeeded', graph_data_epoch: retainedEpoch, graph_sequence: diagnostic };
  let admissions = [admission], fenceRows = [{ open: false }];
  const sql: string[] = [];
  const query = async (text: string) => {
    sql.push(text);
    if (text.includes('SELECT open')) return { rows: fenceRows, rowCount: fenceRows.length };
    if (text.includes('FROM access.admission')) return { rows: admissions, rowCount: admissions.length };
    if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected Access SQL: ${text}`);
  };
  const pool = { connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
  const erasureReads: unknown[][] = [];
  const relayPool = { query: async (text: string, values: unknown[] = []) => {
    if (!text.includes('relay.erasure_target')) throw new Error(`Unexpected relay SQL: ${text}`);
    erasureReads.push(values); return { rows: native.ledgerErased ? [{}] : [], rowCount: native.ledgerErased ? 1 : 0 };
  } } as unknown as Pool;
  return { custody, store, objects, native, env, prepared, terminal, event, outbox, receipt, state, model, manifest, admission, sql,
    pool, relayPool, coverage,
    payloadSha256, manifestSha256, componentPayloadSha256, shapeDigests,
    sourceQueries: () => sourceQueries, erasureReads,
    reconcile: (position = mainSequence) => reconcileRetainedSlimMetadata(env, pool, relayPool, coverage, position),
    fence: (open: boolean | null) => { fenceRows = open === null ? [] : [{ open }]; },
    admissions: (values: typeof admission[]) => { admissions = values; },
    replaceCommand: async (change: (value: PreparedCommand) => void) => {
      const value = JSON.parse(Buffer.from(store.row!.payload).toString('utf8')) as PreparedCommand;
      change(value); const payload = Buffer.from(JSON.stringify(value)), payloadSha256 = await objects.put(payload);
      store.row = { ...store.row!, payload, payloadSha256 };
    },
    stop: () => retained.mockRestore() };
}

test('committed retired slim custody reads the original bare manifest digest without dispatch or rewriting source', async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(f.store.row), puts = f.objects.puts;
    const source = await f.custody.readCommitted(f.receipt);
    expect(f.prepared.manifest).toBe(f.manifestSha256);
    expect(source?.prepared.manifest).toBe(f.manifestSha256);
    expect(source).toMatchObject({ prepared: f.prepared, terminal: f.terminal, payloadSha256: f.payloadSha256,
      manifestSha256: f.manifestSha256, componentPayloadSha256: f.componentPayloadSha256, model: f.model });
    expect(source?.objectReferences).toEqual(expect.arrayContaining([
      { digest: f.payloadSha256, kind: 'command' }, { digest: f.manifestSha256, kind: 'manifest' },
      { digest: f.componentPayloadSha256, kind: 'payload' }, ...f.shapeDigests.map(digest => ({ digest, kind: 'shape' })),
    ]));
    expect(source?.outbox).toEqual(f.outbox);
    expect(JSON.stringify(f.store.row)).toBe(before);
    expect(f.objects.puts).toBe(puts);
    expect(f.store.mutations).toBe(0); expect(f.sourceQueries()).toBe(0); expect(f.native.commands).toEqual([]);
  } finally { f.stop(); }
});

for (const version of [1, 2] as const) {
  for (const tag of ['en-US', 'zh-Hans', 'sr-Latn']) {
    test(`retired v${version} edition restores canonical ${tag} owner meaning with identical custody bytes and pins`, async () => {
      const f = await fixture(version, 'active', null, { state: state => 'contentLanguage' in state
        ? { ...state, title: { ...state.title, language: tag }, contentLanguage: tag }
        : { ...state, title: { ...state.title, language: tag }, contentLanguages: [tag],
          originalLanguages: [tag], titleLanguage: tag, tracklistLanguage: tag } });
      try {
        const original = JSON.stringify(f.store.row), puts = f.objects.puts;
        const storedBytes = [...f.objects.bytes].map(([digest, bytes]) => [digest, Buffer.from(bytes).toString('hex')]);
        const source = await f.custody.readCommitted(f.receipt);
        expect(source?.prepared.state).toEqual(f.state);
        expect(source?.prepared.envelope.digest).toBe(f.admission.request_digest);
        expect(source?.prepared.envelope.validations).toEqual(f.prepared.envelope.validations);
        expect(f.state.title.language).toBe(tag.toLowerCase());
        if ('contentLanguages' in f.state) {
          expect(f.state.contentLanguages).toEqual([tag]);
          expect(f.state.originalLanguages).toEqual([tag]);
          expect(f.state.titleLanguage).toBe(tag); expect(f.state.tracklistLanguage).toBe(tag);
        } else expect(f.state.contentLanguage).toBe(tag.toLowerCase());
        expect(await f.reconcile()).toMatchObject({ component: f.prepared.component,
          revision: f.prepared.revision, replayed: false });
        const command = f.native.commands[0]!;
        expect(command.validations).toEqual(f.prepared.envelope.validations);
        expect(command.update).toContain(JSON.stringify(JSON.stringify(f.state)));
        expect(command.update).toContain(`rv:sourceDigest "${f.prepared.envelope.digest}"`);
        expect(command.update).toContain(`rv:sourcePayloadDigest "${f.payloadSha256}"`);
        expect(command.update).toContain(`rv:metadataManifest <${f.manifest}>`);
        expect(JSON.stringify(f.store.row)).toBe(original);
        expect([...f.objects.bytes].map(([digest, bytes]) => [digest, Buffer.from(bytes).toString('hex')])).toEqual(storedBytes);
        expect(f.objects.puts).toBe(puts); expect(f.store.mutations).toBe(0); expect(f.sourceQueries()).toBe(0);
        expect(await f.reconcile()).toMatchObject({ replayed: true });
        expect(f.native.commands).toHaveLength(1); expect(f.objects.puts).toBe(puts);
      } finally { f.stop(); }
    });
  }
}

for (const tag of ['en_US', 'zh--Hans', 'sr-Latn-']) {
  test(`retired exact custody with malformed ${tag} language stays held before native dispatch`, async () => {
    const f = await fixture(2, 'active', null, { uncheckedState: true,
      state: state => ({ ...state as MetadataEditionStateV2, contentLanguages: [tag] }) });
    try {
      const original = JSON.stringify(f.store.row), puts = f.objects.puts;
      expect(hash(f.store.row!.payload)).toBe(f.payloadSha256);
      expect(hash(await f.objects.get(f.payloadSha256))).toBe(f.payloadSha256);
      await expect(f.custody.readCommitted(f.receipt)).rejects.toThrow();
      await expect(f.reconcile()).rejects.toThrow();
      expect(f.native.commands).toHaveLength(0); expect(f.sql).toHaveLength(0);
      expect(f.native.diagnosticCursor).toBe('700'); expect(f.native.mainCursor).toBe('3');
      expect(JSON.stringify(f.store.row)).toBe(original); expect(f.objects.puts).toBe(puts);
      expect(f.store.mutations).toBe(0); expect(f.sourceQueries()).toBe(0);
    } finally { f.stop(); }
  });
}

for (const kind of ['command', 'manifest', 'payload', 'shape'] as const) {
  for (const corrupt of [false, true]) {
    test(`committed slim custody refuses ${corrupt ? 'corrupt' : 'missing'} ${kind} source object`, async () => {
      const f = await fixture();
      try {
        const digest = kind === 'command' ? f.payloadSha256 : kind === 'manifest' ? f.manifestSha256
          : kind === 'payload' ? f.componentPayloadSha256 : f.shapeDigests[0]!;
        if (corrupt) f.objects.bytes.set(digest, Buffer.from('altered source bytes'));
        else f.objects.bytes.delete(digest);
        await expect(f.custody.readCommitted(f.receipt)).rejects.toBeInstanceOf(corrupt ? ObjectIntegrityError : ObjectUnavailable);
        await expect(f.reconcile()).rejects.toThrow();
        expect(f.store.mutations).toBe(0); expect(f.sourceQueries()).toBe(0);
        expect(f.native.commands).toHaveLength(0);
      } finally { f.stop(); }
    });
  }
}

test('committed slim custody never reconciles a pending owner effect as restore source', async () => {
  const f = await fixture(); f.store.row = { ...f.store.row!, reconciled: false, retired: false };
  try {
    await expect(f.custody.readCommitted(f.receipt)).rejects.toThrow();
    await expect(f.reconcile()).rejects.toThrow();
    expect(f.store.mutations).toBe(0); expect(f.sourceQueries()).toBe(0);
  } finally { f.stop(); }
});

test('held slim restore refuses absent original custody rather than redispatching the owner command', async () => {
  const f = await fixture(); f.store.row = null;
  try {
    expect(await f.custody.readCommitted(f.receipt)).toBeNull();
    await expect(f.reconcile()).rejects.toThrow();
    expect(f.native.commands).toHaveLength(0); expect(f.store.mutations).toBe(0);
    expect(f.native.mainCursor).toBe('3'); expect(f.sourceQueries()).toBe(0);
  } finally { f.stop(); }
});

test('held slim restore cannot use diagnostic sequence 900 as Main position 4', async () => {
  const f = await fixture();
  try {
    await expect(f.reconcile(diagnostic)).rejects.toThrow();
    expect(f.native.commands).toHaveLength(0); expect(f.native.queries).toHaveLength(0);
    expect(f.sql).toHaveLength(0); expect(f.native.mainCursor).toBe('3');
  } finally { f.stop(); }
});

for (const change of ['digest', 'focus', 'count'] as const) {
  test(`committed slim custody refuses unsafe selected validation ${change}`, async () => {
    const f = await fixture();
    try {
      await f.replaceCommand(value => {
        if (change === 'digest') value.envelope.validations[0]!.sha256 = hash('foreign selected shape');
        if (change === 'focus') value.envelope.validations[0]!.focus = [id(99)];
        if (change === 'count') value.envelope.validations.pop();
      });
      await expect(f.custody.readCommitted(f.receipt)).rejects.toThrow();
      expect(f.store.mutations).toBe(0); expect(f.native.commands).toHaveLength(0);
    } finally { f.stop(); }
  });
}

for (const changed of ['terminal', 'outbox', 'SQL-command'] as const) {
  test(`committed slim custody refuses altered ${changed} while keeping source final`, async () => {
    const f = await fixture();
    try {
      const original = f.store.row!;
      if (changed === 'terminal') f.store.row = { ...original, terminal: { ...original.terminal!, streamSequence: '900' } };
      if (changed === 'outbox') f.store.row = { ...original, outbox: { ...original.outbox, eventCount: 2 } };
      if (changed === 'SQL-command') f.store.row = { ...original, payload: Buffer.from('altered SQL bytes') };
      await expect(f.custody.readCommitted(f.receipt)).rejects.toBeInstanceOf(ObjectIntegrityError);
      expect(f.store.mutations).toBe(0); expect(f.sourceQueries()).toBe(0);
    } finally { f.stop(); }
  });
}

for (const version of [1, 2] as const) {
  for (const status of ['active', 'withdrawn'] as const) {
    test(`held restore reconstructs exact retired v${version} ${status} edition and unequal source cursors`, async () => {
      const f = await fixture(version, status);
      try {
        const original = JSON.stringify(f.store.row), puts = f.objects.puts;
        expect(await f.reconcile()).toEqual({ receipt: f.receipt, component: f.prepared.component,
          revision: f.prepared.revision, replayed: false });
        expect(f.native.commands).toHaveLength(1);
        const command = f.native.commands[0]!;
        expect(command.receipt).toMatch(/^urn:rezics:name-migration:metadata-restore:[a-f0-9]{64}$/);
        expect(command.receipt).toBe(`${prefix}${command.digest}`);
        expect(command.digest).toBe(hash(JSON.stringify(['held-slim-metadata-restore-v1', epoch, routingEpoch,
          f.receipt, f.prepared.envelope.digest, f.payloadSha256, retainedEpoch, diagnostic, mainSequence,
          f.prepared.component, f.prepared.revision])));
        expect(command.validations).toEqual(f.prepared.envelope.validations);
        expect(command.update).toContain('rv:commandFamily "metadata-restore-v1"');
        expect(command.update).toContain(`rv:sourceReceipt <${f.receipt}>`);
        expect(command.update).toContain(`rv:sourcePayloadDigest "${f.payloadSha256}"`);
        expect(command.update).toContain(`rv:metadataManifest <urn:rezics:sha256:${f.manifestSha256}>`);
        expect(f.prepared.manifest).toBe(f.manifestSha256);
        expect(f.native.manifest).toBe(f.manifest);
        expect(command.update).toContain(`rv:metadataModel <${f.model}>`);
        expect(command.update).toContain(`rv:sourceSequence ${diagnostic}`);
        expect(command.update).toContain(`rv:sourceMainSequence ${mainSequence}`);
        expect(command.update).toContain(`rv:reconciledPriorSequence ${diagnostic}`);
        expect(command.update).toContain(`rv:reconciledPriorMainSequence ${mainSequence}`);
        expect(command.update).toContain('rv:restoreHold true');
        expect(command.update).toContain(JSON.stringify(JSON.stringify(f.state)));
        expect(command.update).not.toContain('rv:sequence ?next');
        expect(command.update).not.toContain(GRAPHS.outbox);
        expect(command.update).not.toContain('CommitProof');
        expect(f.native.diagnosticCursor).toBe(diagnostic); expect(f.native.mainCursor).toBe(mainSequence);
        expect(f.native.metadataHead).toBe(f.prepared.revision);
        expect(f.erasureReads).toHaveLength(1);
        expect(f.erasureReads[0]![0]).toEqual(expect.arrayContaining([
          f.terminal.work, f.prepared.component, f.prepared.revision,
          `sha256:${f.payloadSha256}`, `sha256:${f.manifestSha256}`, `sha256:${f.componentPayloadSha256}`,
          ...f.shapeDigests.map(value => `sha256:${value}`),
        ]));
        expect(f.native.rawUpdates).toBe(0); expect(f.store.mutations).toBe(0); expect(f.sourceQueries()).toBe(0);
        expect(f.objects.puts).toBe(puts); expect(JSON.stringify(f.store.row)).toBe(original);
        expect(f.sql.at(-1)).toBe('COMMIT');
      } finally { f.stop(); }
    });
  }
}

for (const fence of [true, null]) {
  test(`held slim restore refuses ${fence === null ? 'missing' : 'open'} Access fence`, async () => {
    const f = await fixture(); f.fence(fence);
    try {
      await expect(f.reconcile()).rejects.toThrow();
      expect(f.native.commands).toHaveLength(0); expect(f.native.mainCursor).toBe('3');
      expect(f.sql.at(-1)).toBe('ROLLBACK');
    } finally { f.stop(); }
  });
}

for (const key of ['authority_epoch', 'request_digest', 'state', 'acting_subject', 'graph_receipt', 'graph_sequence', 'scope_id'] as const) {
  test(`held slim restore refuses sealed admission ${key} mismatch`, async () => {
    const f = await fixture(); f.admission[key] = key === 'state' ? 'registered' : 'wrong';
    try {
      await expect(f.reconcile()).rejects.toThrow();
      expect(f.native.commands).toHaveLength(0); expect(f.native.diagnosticCursor).toBe('700');
      expect(f.native.mainCursor).toBe('3'); expect(f.store.mutations).toBe(0);
    } finally { f.stop(); }
  });
}

for (const count of [0, 2]) {
  test(`held slim restore refuses ${count === 0 ? 'absent' : 'duplicate'} sealed admission`, async () => {
    const f = await fixture(); f.admissions(count === 0 ? [] : [f.admission, { ...f.admission }]);
    try {
      await expect(f.reconcile()).rejects.toThrow(); expect(f.native.commands).toHaveLength(0);
      expect(f.native.mainCursor).toBe('3'); expect(f.store.mutations).toBe(0);
    } finally { f.stop(); }
  });
}

test('held slim restore recomputes the original request digest even when every retained authority copy matches', async () => {
  const f = await fixture();
  try {
    const digest = hash('different original intent');
    await f.replaceCommand(value => { value.envelope.digest = digest; value.receipt.requestDigest = digest; });
    f.admission.request_digest = digest; f.event.data.receipt.requestDigest = digest;
    f.store.row = { ...f.store.row!, requestDigest: digest,
      terminal: { ...f.store.row!.terminal!, requestDigest: digest } };
    await expect(f.custody.readCommitted(f.receipt)).rejects.toThrow();
    await expect(f.reconcile()).rejects.toThrow();
    expect(f.native.commands).toHaveLength(0); expect(f.native.mainCursor).toBe('3');
    expect(f.store.mutations).toBe(0);
  } finally { f.stop(); }
});

for (const failure of ['stale', 'concurrent', 'erased', 'ledger-erased', 'work-suppressed', 'selected-pin'] as const) {
  test(`held slim restore remains held after ${failure} native refusal`, async () => {
    const f = await fixture();
    try {
      if (failure === 'stale') f.native.metadataHead = id(99);
      if (failure === 'concurrent') f.native.stale = true;
      if (failure === 'erased') f.native.erased = true;
      if (failure === 'ledger-erased') f.native.ledgerErased = true;
      if (failure === 'work-suppressed') f.native.workSuppressed = true;
      if (failure === 'selected-pin') f.native.healthProfiles['work-metadata-details-v1'] = hash('changed selected model');
      await expect(f.reconcile()).rejects.toThrow();
      expect(f.native.mainCursor).toBe('3'); expect(f.native.diagnosticCursor).toBe('700');
      expect(f.native.proof).toBeNull(); expect(f.store.mutations).toBe(0);
      expect(f.sql.at(-1)).toBe('ROLLBACK');
    } finally { f.stop(); }
  });
}

test('held slim restore guards the local edition predecessor and writes the exact resulting Work pointer', async () => {
  const f = await fixture(2, 'active', id(20)); f.native.metadataHead = id(20);
  try {
    await f.reconcile();
    const update = f.native.commands[0]!.update;
    expect(update).toContain(`rv:metadataHead <${id(20)}>`);
    expect(update).toContain(`rv:sourcePredecessor <${id(20)}>`);
    expect(update).toContain(`<${f.terminal.work}> rv:editionsRevision <${f.prepared.revision}>`);
    expect(update).not.toContain('ModelGeneration');
    expect(update).not.toContain('modelGenerationHead');
    expect(update).not.toContain('moduleVersion');
  } finally { f.stop(); }
});

test('held slim restore keeps selected shape SHA when an unrelated global Current model changes', async () => {
  const f = await fixture(2);
  try {
    const puts = f.objects.puts;
    f.native.healthProfiles['statement-v1'] = hash('unrelated changed global model');
    await f.reconcile();
    expect(f.native.commands[0]!.validations).toEqual(f.prepared.envelope.validations);
    expect(f.native.queries.some(query => /modelGeneration|currentModel|ModelGeneration/.test(query))).toBe(false);
    expect(f.objects.puts).toBe(puts);
  } finally { f.stop(); }
});

test('held slim restore interruption retries the same source-bound maintenance identity without regenerating objects', async () => {
  const f = await fixture(); f.native.interrupt = true;
  try {
    const puts = f.objects.puts, original = JSON.stringify(f.store.row);
    await expect(f.reconcile()).rejects.toThrow();
    expect(f.native.mainCursor).toBe('3'); expect(f.native.diagnosticCursor).toBe('700');
    expect(await f.reconcile()).toMatchObject({ replayed: false });
    expect(f.native.commands).toHaveLength(2);
    expect(f.native.commands[1]).toEqual(f.native.commands[0]);
    expect(f.objects.puts).toBe(puts); expect(JSON.stringify(f.store.row)).toBe(original);
    expect(f.store.mutations).toBe(0);
  } finally { f.stop(); }
});

test('held slim restore verifies an immediate lost acknowledgement and then replays saved proof', async () => {
  const f = await fixture(); f.native.loseResponse = true;
  try {
    const puts = f.objects.puts, original = JSON.stringify(f.store.row);
    expect(await f.reconcile()).toMatchObject({ replayed: false });
    expect(f.native.mainCursor).toBe(mainSequence); expect(f.native.diagnosticCursor).toBe(diagnostic);
    expect(await f.reconcile()).toMatchObject({ replayed: true });
    expect(f.native.commands).toHaveLength(1); expect(f.objects.puts).toBe(puts);
    expect(JSON.stringify(f.store.row)).toBe(original); expect(f.store.mutations).toBe(0);
  } finally { f.stop(); }
});

test('held slim restore replay after a later local head keeps source objects and saved receipt', async () => {
  const f = await fixture();
  try {
    await f.reconcile();
    const puts = f.objects.puts, queryCount = f.native.queries.length;
    f.native.metadataHead = id(99); f.native.mainCursor = '5'; f.native.diagnosticCursor = '901';
    expect(await f.reconcile()).toMatchObject({ replayed: true });
    expect(f.native.commands).toHaveLength(1); expect(f.objects.puts).toBe(puts);
    expect(f.native.metadataHead).toBe(id(99)); expect(f.store.mutations).toBe(0);
    expect(f.native.queries.slice(queryCount).some(query => query.includes('SELECT ?head ?work'))).toBe(false);
  } finally { f.stop(); }
});

test('slim metadata restore uses authenticated maintenance command transport', async () => {
  const f = await fixture();
  const requests: { url: string; authorization: string | null }[] = [];
  const transport = Object.assign(async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    return Response.json({ status: 'committed', position: { datasetId: DATASET, dataEpoch: epoch, sequence: '0' } });
  }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(transport);
  try {
    await f.reconcile();
    const command = f.native.commands[0]!;
    await new FusekiClient('http://localhost/product', 'b'.repeat(64), 'c'.repeat(64)).command(command);
    expect(requests).toEqual([{ url: 'http://localhost/product/command', authorization: `Bearer ${'b'.repeat(64)}` }]);
    await expect(new FusekiClient('http://localhost/product', '', 'c'.repeat(64)).command(command))
      .rejects.toThrow('maintenance capability is required');
    expect(requests).toHaveLength(1);
  } finally { fetch.mockRestore(); f.stop(); }
});

function heldCustodyClient(f: Awaited<ReturnType<typeof fixture>>) {
  const queries: { text: string; values: unknown[] }[] = [];
  let releases = 0;
  let alter = (value: Record<string, unknown>) => [value];
  const client = { query: async (text: string, values: unknown[] = []) => {
    queries.push({ text,values });
    if (!text.startsWith('SELECT ') || !text.includes('FROM access.command_custody')) {
      throw new Error('historical reader cannot own the held transaction');
    }
    const row = f.store.row;
    if (!row) return { rows: [] };
    return { rows: alter({ receipt: row.receipt,request_digest: row.requestDigest,payload_sha256: row.payloadSha256,
      payload: row.payload,revision: row.revision,terminal: row.terminal,outbox: row.outbox,
      reconciled: row.reconciled,retired: row.retired,data_epoch: retainedEpoch,stream_sequence: mainSequence }) };
  }, release: () => { releases++; throw new Error('historical reader cannot release the held client'); } } as unknown as PoolClient;
  return { client,queries,releases: () => releases,alter: (change: typeof alter) => { alter = change; } };
}

test('supplied-client historical read verifies retired superseded custody closure and distinct graph900/Main4 without lifecycle or proof', async () => {
  const f = await fixture(2,'withdrawn',id(20)), held = heldCustodyClient(f);
  const acquire = spyOn(f.store,'withReceipt').mockImplementation(async () => { throw new Error('no pool checkout through custody store'); });
  const indexed = spyOn(f.store,'receiptAt').mockImplementation(async () => { throw new Error('use only supplied Access client'); });
  try {
    f.native.metadataHead = id(99); // A later head cannot replace this historical source.
    const original = JSON.stringify(f.store.row), puts = f.objects.puts;
    f.objects.gets = [];
    const result = await f.custody.readHistorical({ dataEpoch: retainedEpoch,streamSequence: mainSequence },held.client);
    expect(result?.outbox).toEqual({ batch: { batchId: f.outbox.batchId,streamScope: MAIN_RELAY_STREAM_SCOPE,
      dataEpoch: retainedEpoch,sequence: '4',graphSequence: '900',routingEpoch: f.prepared.routingEpoch,
      eventIds: [f.event.id],custodiedReceipt: f.receipt },events: f.outbox.events });
    const closure = [f.payloadSha256,f.manifestSha256,f.componentPayloadSha256,...f.shapeDigests];
    expect([...result!.objectDigests].sort()).toEqual([...new Set(closure)].sort());
    expect([...new Set(f.objects.gets)].sort()).toEqual([...new Set(closure)].sort());
    expect(held.queries).toHaveLength(1);
    expect(held.queries[0]!.values).toEqual([retainedEpoch,'4']);
    expect(held.releases()).toBe(0); expect(acquire).not.toHaveBeenCalled(); expect(indexed).not.toHaveBeenCalled();
    expect(f.sourceQueries()).toBe(0); expect(f.native.queries).toHaveLength(0);
    expect(JSON.stringify(f.store.row)).toBe(original); expect(f.objects.puts).toBe(puts); expect(f.store.mutations).toBe(0);
  } finally { acquire.mockRestore(); indexed.mockRestore(); f.stop(); }
});

for (const kind of ['command','manifest','payload','shape'] as const) for (const corrupt of [false,true]) {
  test(`supplied-client historical read refuses ${corrupt ? 'corrupt' : 'missing'} original ${kind} without repairing it`, async () => {
    const f = await fixture(2), held = heldCustodyClient(f);
    try {
      const digest = kind === 'command' ? f.payloadSha256 : kind === 'manifest' ? f.manifestSha256
        : kind === 'payload' ? f.componentPayloadSha256 : f.shapeDigests[0]!;
      if (corrupt) f.objects.bytes.set(digest,Buffer.from('altered original bytes'));
      else f.objects.bytes.delete(digest);
      const puts = f.objects.puts, original = JSON.stringify(f.store.row);
      await expect(f.custody.readHistorical({ dataEpoch: retainedEpoch,streamSequence: mainSequence },held.client)).rejects.toThrow();
      expect(JSON.stringify(f.store.row)).toBe(original); expect(f.objects.puts).toBe(puts);
      expect(held.queries).toHaveLength(1); expect(held.releases()).toBe(0);
      expect(f.sourceQueries()).toBe(0); expect(f.store.mutations).toBe(0);
    } finally { f.stop(); }
  });
}

for (const changed of ['data_epoch','stream_sequence','terminal','outbox','pending','duplicate'] as const) {
  test(`supplied-client historical read refuses ${changed} inconsistency under the original position`, async () => {
    const f = await fixture(), held = heldCustodyClient(f);
    try {
      held.alter(value => {
        if (changed === 'duplicate') return [value,value];
        if (changed === 'pending') return [{ ...value,reconciled: false }];
        if (changed === 'terminal') return [{ ...value,terminal: { ...f.terminal,streamSequence: '900' } }];
        if (changed === 'outbox') return [{ ...value,outbox: { ...f.outbox,graphSequence: '4' } }];
        return [{ ...value,[changed]: changed === 'stream_sequence' ? '900' : 'foreign-epoch' }];
      });
      await expect(f.custody.readHistorical({ dataEpoch: retainedEpoch,streamSequence: mainSequence },held.client)).rejects.toThrow();
      expect(held.queries).toHaveLength(1); expect(held.releases()).toBe(0);
      expect(f.sourceQueries()).toBe(0); expect(f.store.mutations).toBe(0);
    } finally { f.stop(); }
  });
}

test('supplied-client historical read returns absence without a native fallback', async () => {
  const f = await fixture(), held = heldCustodyClient(f); f.store.row = null;
  try {
    expect(await f.custody.readHistorical({ dataEpoch: retainedEpoch,streamSequence: mainSequence },held.client)).toBeNull();
    expect(held.queries).toHaveLength(1); expect(held.releases()).toBe(0); expect(f.sourceQueries()).toBe(0);
  } finally { f.stop(); }
});
