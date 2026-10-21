import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import type { DatasetRecord } from '../../../scripts/datasets/types.ts';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { composeMain, type ComposeMainOverrides } from '../src/composition.ts';
import { mainConfig } from '../src/config.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { grantFixtureAuthority, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from '../src/modules/classification/context.ts';
import { commandReceiptIri } from '../src/modules/context/command.ts';
import { SourceFieldProblem, type RetainedConversionRequest, type RetainedSupportRequest } from '../src/modules/source/field-support-contract.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { SourceRetainedRecordStore } from '../src/modules/source/retained-record.ts';
import { canonicalDigest, sourceDigest } from '../src/modules/source/retained-record-normalization.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { familyReceiptIri, sealComponentState } from '../src/modules/semantic/command.ts';
import type { NativeBasisVerificationInput } from '../src/modules/semantic/native-basis.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { semanticValueRdf } from '../src/modules/semantic/value.ts';
import { RELATION_CHANGE_FAMILY, type OccurrenceState } from '../src/modules/relation/change.ts';
import { RELATION_V2_PROFILE } from '../src/modules/relation/v2-schema.ts';
import { RightsDenied, RightsStore } from '../src/modules/rights/store.ts';
import { STATEMENT_FAMILIES } from '../src/modules/statement/receipt-family.ts';
import { readSubjectStatements } from '../src/modules/statement/subject-read.ts';
import { ReadingBoundary } from '../src/modules/reading-position/boundary.ts';
import * as targetOwner from '../src/modules/target/resolve.ts';
import { decisionSlotIri } from '../src/modules/statement/schema.ts';
import { OCCURRENCE_ASSERTION_NOTATION, STATEMENT_V2_PROFILE, statementMeaningKeyV2,
  type StatementMeaningV2 } from '../src/modules/statement/v2-schema.ts';
import { hash, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadSession, WorkReadMoved, withWorkReadSession } from '../src/modules/work/read-session.ts';
import { nativeEpoch, nativeId, nativePrincipal, semanticFixture, statementFixture } from './support/source-field-native-fixture.ts';

let cluster: PostgresCluster, contentPool: Pool, accessPool: Pool;
const directory = resolve('.temp', `composition-source-native-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
beforeAll(async () => {
  cluster = await startPostgresCluster();
  contentPool = new Pool({ ...cluster.connection, max: 4 });
  accessPool = new Pool({ ...cluster.connection, max: 8 });
  await migrateContent(contentPool);
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(resolve(import.meta.dir, '../../..'), 'access')) {
      await client.query(readFileSync(join(import.meta.dir, '../migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } finally { client.release(); }
}, 120_000);
const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
afterAll(async () => {
  await contentPool?.end(); await accessPool?.end(); await cluster?.stop();
  rmSync(directory, { recursive: true, force: true });
}, 120_000);

/** Real composition, Access/Content owners and retained Source bytes. Only the
 * immutable-object/graph transports and native reference visibility are controlled;
 * no Semantic/Statement verifier or acknowledgement is replaced. */
async function composition(fixture: Awaited<ReturnType<typeof semanticFixture>> | Awaited<ReturnType<typeof statementFixture>>
  | Awaited<ReturnType<typeof occurrenceFixture>>, overrides?: ComposeMainOverrides) {
  const initialize = spyOn(S3ImmutableObjects.prototype, 'initialize').mockResolvedValue();
  restores.push(() => initialize.mockRestore());
  const objects = spyOn(S3ImmutableObjects.prototype, 'get').mockImplementation(async digest =>
    new Uint8Array(readFileSync(join(fixture.work.environment.objectDirectory, digest))));
  restores.push(() => objects.mockRestore());
  const fuseki = new FusekiClient('http://native-composition.test/rezics/');
  const statementHeads = new Map<string, string>();
  if (fixture.input.native.kind === 'statement') statementHeads.set(fixture.input.native.statement, fixture.input.native.revision);
  if ('assertion' in fixture) statementHeads.set(fixture.assertion.statement, fixture.assertion.revision);
  const graph = spyOn(fuseki, 'query').mockImplementation(query => {
    // The captured native resources have no Work ancestry. Their ordinary
    // rv:head values still reach the real composed Access disclosure reader.
    if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
      const resources = [...(query.match(/VALUES \?work \{([^}]*)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
        .map(match => match[1]!);
      return Promise.resolve(rows(resources.map(work => ({ work: uri(work),
        ...(statementHeads.has(work) ? { head: uri(statementHeads.get(work)!) } : {}) }))));
    }
    return fixture.work.environment.fuseki.query(query);
  });
  restores.push(() => graph.mockRestore());
  const config = mainConfig({
    NODE_ENV: 'test', FUSEKI_URL: 'http://native-composition.test/rezics/',
    FUSEKI_MAINTENANCE_TOKEN: 'a'.repeat(64), FUSEKI_COMMAND_TOKEN: 'b'.repeat(64),
    FUSEKI_TITLE_ADMISSION_KEY: 'c'.repeat(64),
    MAIN_DATA_EPOCH: fixture.work.environment.lineage.dataEpoch, MAIN_ROUTING_EPOCH: '1',
    ACCESS_DATABASE_URL: 'postgres://fixture@localhost/access', CONTENT_DATABASE_URL: 'postgres://fixture@localhost/content',
    MAIN_OBJECT_DIRECTORY: fixture.work.environment.objectDirectory,
    MAIN_S3_ENDPOINT: 'http://immutable-composition.test', MAIN_S3_BUCKET: 'native-fixture',
    MAIN_S3_REGION: 'us-east-1', MAIN_S3_ACCESS_KEY: 'fixture', MAIN_S3_SECRET_KEY: 'fixture',
    ACCOUNT_ISSUER: nativePrincipal.issuer, ACCOUNT_MAIN_RESOURCE: 'https://main.test',
    ACCOUNT_JWKS_URL: 'https://account.test/jwks', ACCOUNT_INTROSPECT_URL: 'https://account.test/introspect',
    ACCOUNT_MAIN_CLIENT_ID: 'fixture-main', ACCOUNT_MAIN_CLIENT_SECRET: 'fixture-secret',
  });
  const result = await composeMain({ config, fuseki, accessPool, contentPool, overrides });
  const visible = spyOn(result.access, 'canReadSemanticResource').mockImplementation(async principal =>
    principal?.issuer === nativePrincipal.issuer && principal?.subject === nativePrincipal.subject);
  restores.push(() => visible.mockRestore());
  const principalId = randomUUID(), principal = { ...nativePrincipal, subject: randomUUID() };
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN');
    // Each composition uses a distinct Account; an existing native actor can
    // retain its independently granted mandate between the captured scenarios.
    const existing = (await client.query('SELECT id FROM access.authority_subject WHERE id=$1', [fixture.input.actingSubject])).rowCount;
    if (existing) {
      await registerFixtureIdentity(client, { principalId, issuer: principal.issuer, subject: principal.subject,
        actor: nativeId(Number.parseInt(randomUUID().slice(0, 6), 16)) });
    } else {
      await registerFixtureIdentity(client, { principalId, issuer: principal.issuer, subject: principal.subject, actor: fixture.input.actingSubject });
    }
    for (const [scope, action] of [['work:create:root', 'work.create'],
      [fixture.input.native.kind === 'statement' ? `statement:speak:${fixture.input.actingSubject}` : 'semantic:create:root',
        fixture.input.native.kind === 'statement' ? 'statement.record' : 'semantic.change']] as const) {
      await grantFixtureAuthority(client, { scope, requireDispatch: true,
        representations: [{ principalId, actor: fixture.input.actingSubject, action, lifetime: 'infinity' }],
        grant: { actor: fixture.input.actingSubject, action, lifetime: 'infinity' } });
    }
    await client.query('COMMIT');
  } finally { client.release(); }
  visible.mockImplementation(async viewer => viewer?.issuer === principal.issuer && viewer?.subject === principal.subject);
  return { ...result, principal, principalId, store: result.dependencies.sourceRetainedFieldSupports! };
}

/** Same retained MusicBrainz alias shape as the native-basis owner fixture;
 * conversion is explicit test preparation, never triggered by a native read. */
async function retained(principalId: string, basis: NativeBasisVerificationInput) {
  const externalId = randomUUID(), text = '原作';
  const record: DatasetRecord = { key: `musicbrainz:artist:${externalId}`, provider: 'musicbrainz', kind: 'artist', externalId,
    title: text, language: 'ja', sourceUrl: `https://musicbrainz.org/artist/${externalId}`, native: 'person',
    data: { id: externalId, name: text, aliases: [{ name: text, locale: 'ja' }] } };
  const snapshot = { id: 'composition-native-shape', digest: 'a'.repeat(64), fileSha256: 'b'.repeat(64) };
  const bytes = Buffer.from(canonicalJson({ format: 'rezics-dataset-record-v1', snapshot: snapshot.id,
    digest: snapshot.digest, record, edges: [], images: [] }));
  const intake = new SourceIntakeStore(contentPool);
  const observation = (await intake.submit(principalId, randomUUID(), {
    provider: record.provider, namespace: record.kind, externalId, sourceRevision: snapshot.digest,
    mediaType: 'application/json', retention: 'retained', rawBytesBase64: bytes.toString('base64'),
    coverage: { scope: 'captured-shape', complete: true, omittedFields: [] }, rightsEvidence: { basis: 'facts', note: 'Owner composition shape' },
  })).observation;
  const request: RetainedConversionRequest = { profile: 'source-retained-record-conversion-v1',
    mappingRevision: 'musicbrainz-artist-retained-map-v1', retained: {
      identity: { key: record.key, provider: record.provider, namespace: record.kind, externalId }, snapshot, record,
      recordDigest: canonicalDigest(record), payload: { format: 'json', byteDigest: sourceDigest(bytes), byteLength: bytes.length },
      intakes: [{ index: 0, record: observation.record, observation: observation.observation, byteDigest: observation.byteDigest! }],
    } };
  const records = new SourceRetainedRecordStore(contentPool, intake);
  const converted = await records.convert(principalId, observation.observation.slice(-36), request);
  const binding = converted.conversion.retainedRecord;
  const input: RetainedSupportRequest = { profile: 'source-field-support-attachment-v2', target: basis.native.target,
    slot: basis.native.kind === 'statement' ? 'statement-v1#value' : `component-property-v1#${basis.native.property.predicate}`,
    occurrence: basis.native.kind === 'statement' && basis.native.coverage && basis.native.coverage.kind !== 'subject-global'
      ? basis.native.coverage.occurrence : null,
    context: 'global', sourceRecord: binding.sourceRecord, conversion: binding.conversion,
    grain: record.kind, sourceField: 'aliases/0/name', sourceOccurrence: null, expectedHead: basis.native.revision,
    actingSubject: basis.actingSubject, native: basis.native, evidence: { binding: binding.binding, recordDigest: binding.recordDigest,
      mappingRevision: binding.mappingRevision, field: { pointer: '/data/aliases/0/name', presence: 'value',
        valueDigest: canonicalDigest(text), language: 'ja' } } };
  return input;
}

/** Keep target inventory and reading position outside this owner regression.
 * Native property/receipt reads, Source SQL settlement, public Rights projection
 * and selected-dependency rereads all use the actual composed owners. */
function propertyReader(composed: Awaited<ReturnType<typeof composition>>, native: Awaited<ReturnType<typeof semanticFixture>>) {
  const target = native.input.native.target;
  const resolved = spyOn(targetOwner, 'resolveTargets').mockResolvedValue([
    { resource: target, base: 'resource', types: [], work: null, revision: native.revision, disclosure: 'public' },
  ]);
  const require = spyOn(ReadingBoundary.prototype, 'require').mockResolvedValue();
  const binding = spyOn(ReadingBoundary.prototype, 'binding').mockResolvedValue(['fixture-reading-boundary']);
  const visible = spyOn(ReadingBoundary.prototype, 'visible').mockImplementation(async records => new Set(records));
  const fence = spyOn(ReadingBoundary.prototype, 'fence').mockResolvedValue();
  const seek = composed.dependencies.statementSeek!;
  const coverage = spyOn(seek, 'coverage').mockResolvedValue({ complete: true, through_sequence: '4' });
  const publication = spyOn(seek, 'capturePublicationBasis').mockResolvedValue(null);
  const candidates = spyOn(seek, 'seek').mockResolvedValue({ candidates: [], visitedRows: 0 });
  for (const mock of [resolved, require, binding, visible, fence, coverage, publication, candidates]) {
    restores.push(() => mock.mockRestore());
  }
  return async (signed = false) => {
    const session = new WorkReadSession(composed.dependencies,
      new Request(`http://main.test/v1/resources/${target.slice(-36)}/statements`),
      signed ? { actingSubject: native.input.actingSubject } : {}, { dataEpoch: nativeEpoch, sequence: '4' });
    session.principal = signed ? composed.principal : null;
    session.query = async query => {
      if (query.includes('SELECT ?policy ?realm')) return [];
      throw new Error('Unexpected public property reader query: ' + query);
    };
    const result = await withWorkReadSession(session, () => readSubjectStatements(session, target));
    return { session, items: result.groups.flatMap(group => group.items) };
  };
}

test('composed native properties cite only their exact settled Source value for signed and visitor reads', async () => {
  const predicate = 'https://schema.org/alternateName';
  const native = await semanticFixture([
    { predicate, value: { kind: 'language-string', lexical: '原作', language: 'ja' } },
    { predicate, value: { kind: 'language-string', lexical: '別名', language: 'ja' } },
  ]);
  const composed = await composition(native), input = await retained(composed.principalId, native.input);
  const attached = await composed.store.attach(composed.principal, composed.principalId, randomUUID(), input);
  expect((await composed.store.read(composed.principalId, attached.support, attached.step, composed.principal))
    ?.publicEvidence?.id).toBe(input.sourceRecord);
  const read = propertyReader(composed, native);
  for (const signed of [true, false]) {
    const { session, items } = await read(signed);
    expect(items).toHaveLength(2);
    expect(items).toContainEqual(expect.objectContaining({ kind: 'component-property', revision: native.revision,
      predicate, value: { kind: 'language-string', lexical: '原作', language: 'ja' }, sources: [input.sourceRecord] }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'component-property', revision: native.revision,
      predicate, value: { kind: 'language-string', lexical: '別名', language: 'ja' }, sources: [] }));
    await session.fenceDependencies();
  }
});

test('composed native property citations fence changed native heads and preserve historical Source custody', async () => {
  const native = await semanticFixture(), composed = await composition(native);
  const input = await retained(composed.principalId, native.input);
  const attached = await composed.store.attach(composed.principal, composed.principalId, randomUUID(), input);
  const read = propertyReader(composed, native), captured = await read();
  expect(captured.items[0]!.sources).toEqual([input.sourceRecord]);
  native.finalHeadMatches(false);
  await expect(captured.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  expect((await read()).items[0]!.sources).toEqual([]);
  native.finalHeadMatches(true);
  const beforeHeadChange = await read();
  native.head(nativeId(99));
  await expect(beforeHeadChange.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  expect((await read()).items[0]).toMatchObject({ revision: nativeId(99), sources: [] });
  expect((await composed.store.read(composed.principalId, attached.support, attached.step, composed.principal))
    ?.publicEvidence).toBeNull();
});

test('composed native property citations retain withdrawal fences for visitors', async () => {
  const native = await semanticFixture(), composed = await composition(native);
  const input = await retained(composed.principalId, native.input);
  const attached = await composed.store.attach(composed.principal, composed.principalId, randomUUID(), input);
  const read = propertyReader(composed, native), beforeWithdrawal = await read();
  expect(beforeWithdrawal.items[0]!.sources).toEqual([input.sourceRecord]);
  const savedSupport = (await composed.store.read(composed.principalId, attached.support, attached.step, composed.principal))!;
  await composed.dependencies.sourceFieldWithdrawals!.withdraw(composed.principalId, randomUUID(), {
    support: attached.support, expectedSupport: savedSupport.supportIdentity, reason: 'Withdraw this exact field evidence',
  });
  expect((await read()).items[0]!.sources).toEqual([]);
  await expect(beforeWithdrawal.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

async function saved(principalId: string) {
  return (await contentPool.query('SELECT native_acknowledgement FROM source.field_support_step WHERE principal_id=$1', [principalId])).rows;
}

for (const [name, fixture] of [['Semantic', semanticFixture], ['Statement', statementFixture]] as const) {
  test(`production composition attaches the actual ${name} terminal receipt with retained Source evidence`, async () => {
    const native = await fixture(), composed = await composition(native), input = await retained(composed.principalId, native.input);
    expect(composed.notificationStore['pool']).toBe(composed.pool);
    expect(composed.dependencies.access).toBe(composed.access);
    expect(composed.dependencies.relationAttribution).toBeDefined();
    await composed.store.attach(composed.principal, composed.principalId, randomUUID(), input);
    expect(await saved(composed.principalId)).toEqual([{ native_acknowledgement: expect.objectContaining({ receipt: native.receipt,
      admissionId: native.admissionId, semantic: expect.objectContaining({ commandReceipt: expect.objectContaining({
        outcome: 'succeeded', receipt: native.receipt, component: native.input.native.kind === 'statement'
          ? native.input.native.statement : native.input.native.component, revision: native.revision, operation: native.operation }),
        headGuarantee: 'verified-before-commit' }) }) }]);
  });
}

test('composed native receipt, target, value, head, authority and Rights refusals create no Source settlement', async () => {
  const native = await semanticFixture(), composed = await composition(native), input = await retained(composed.principalId, native.input);
  const refuse = async (request: RetainedSupportRequest, expected: object) => {
    await expect(composed.store.attach(composed.principal, composed.principalId, randomUUID(), request)).rejects.toMatchObject(expected);
    expect(await saved(composed.principalId)).toEqual([]);
  };
  native.receiptAvailable(false);
  await refuse(input, { status: 503, code: 'source_support_unavailable' });
  native.receiptAvailable(true); native.receiptRevision(nativeId(99));
  await refuse(input, { status: 409, basis: 'native-head' });
  native.receiptRevision(native.revision); native.head(nativeId(99));
  await refuse(input, { status: 409, basis: 'native-head' });
  native.head(native.revision);
  await refuse({ ...input, native: { ...input.native, target: nativeId(99) } }, { status: 409, basis: 'native-target' });
  if (input.native.kind !== 'component-property' || input.native.owner !== 'semantic') throw new Error('Semantic fixture required');
  await refuse({ ...input, native: { ...input.native, property: { ...input.native.property,
    value: { kind: 'language-string', lexical: '改作', language: 'ja' } } } }, { status: 409, basis: 'native-value' });
  const rights = spyOn(RightsStore.prototype, 'retainedFieldReusePermitted').mockResolvedValue(false);
  restores.push(() => rights.mockRestore());
  await expect(composed.store.attach(composed.principal, composed.principalId, randomUUID(), input))
    .rejects.toBeInstanceOf(RightsDenied);
  expect(await saved(composed.principalId)).toEqual([]);
  expect(rights).toHaveBeenCalled();
  rights.mockRestore();
  const authority = spyOn(composed.access, 'withOwnerAuthority').mockRejectedValue(new SourceFieldProblem(403, 'authority_denied', 'Authority withdrawn'));
  restores.push(() => authority.mockRestore());
  await refuse(input, { status: 403, code: 'authority_denied' });
  expect(authority).toHaveBeenCalled();
});

test('admitted Source overrides replace only the named production owner', async () => {
  const native = await statementFixture();
  const semantic = async () => { throw new SourceFieldProblem(403, 'fixture_override', 'Explicit override'); };
  const composed = await composition(native, { sourceRetainedOwners: { semantic } });
  expect(composed.store['owners'].semantic).toBe(semantic);
  expect(composed.store['owners'].statement).toBeFunction();
  expect(composed.store['owners'].authorizeReuse).toBeFunction();
  expect(composed.store['owners'].publicEvidence).toBeFunction();
  await composed.store.attach(composed.principal, composed.principalId, randomUUID(), await retained(composed.principalId, native.input));
  expect(await saved(composed.principalId)).toHaveLength(1);
});

// Captured occurrence/participation transport from semantic-native-basis-occurrence;
// the trait uses the same retained alias value as the Source owner fixture.
const id = nativeId;
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
async function occurrenceFixture(attributed = false) {
  const occurrence = id(100), occurrenceRevision = id(101), workId = id(102), subject = id(103),
    definition = id(104), definitionRevision = id(105), property = id(106), propertyRevision = id(107), actor = id(112);
  const generation = `urn:rezics:model-generation:${hash('native-coverage-model')}`;
  const relationAdmission = Bun.randomUUIDv7(), relationReceipt = familyReceiptIri(relationAdmission, RELATION_CHANGE_FAMILY);
  const occurrenceState: OccurrenceState = { profile: 'relation-change-v2', definition: definitionRevision,
    lifecycle: 'active', applicability: [],
    // A sealed historical citation identifies the old assertion, but supplies
    // no current authority. The production citation delegate is absent and must
    // refuse it before Source writes a new settlement.
    attributionProofs: attributed ? [{ participation: id(121), proof: {
      basis: { kind: 'source-binding', binding: id(160) }, receipt: `urn:rezics:receipt:${hash('captured-source-binding')}`,
      revision: id(162), validationToken: hash('captured-source-binding-validation'), state: 'current',
      fields: { creditedName: { lexical: '原作', language: 'ja' } }, evidence: [id(161)],
      participant: { kind: 'resource', ref: subject },
    } }] : [], participations: [
      { iri: id(120), role: `${definition}/role/work`, participant: { kind: 'resource', ref: workId }, attributionSupports: [] },
      { iri: id(121), role: `${definition}/role/subject`, participant: { kind: 'resource', ref: subject }, position: 0,
        creditedName: { lexical: '原作', language: 'ja' }, attributionSupports: attributed
          ? [{ basis: { kind: 'source-binding', binding: id(160) }, fields: ['creditedName'], evidence: [id(161)] }] : [] },
      // The same subject may occupy another declared role. Repetition within a
      // single role remains invalid under the existing occurrence contract.
      { iri: id(122), role: `${definition}/role/alternate`, participant: { kind: 'resource', ref: subject }, position: 0, attributionSupports: [] },
    ] };
  const records = [
    { statement: id(108), revision: id(109), operation: id(115), decision: id(113), admission: Bun.randomUUIDv7(),
      meaning: { subject: { kind: 'resource', ref: occurrence }, predicate: property, relationDefinition: propertyRevision,
        value: { kind: 'resource', ref: occurrenceRevision }, applicability: [], interpretationDefinitions: [],
        coverage: { kind: 'occurrence', occurrence, occurrenceRevision } } as StatementMeaningV2 },
    { statement: id(110), revision: id(111), operation: id(116), decision: id(114), admission: Bun.randomUUIDv7(),
      meaning: { subject: { kind: 'resource', ref: subject }, predicate: 'https://schema.org/alternateName', relationDefinition: id(124),
        value: { kind: 'language-string', lexical: '原作', language: 'ja' }, applicability: [], interpretationDefinitions: [],
        coverage: { kind: 'participation', occurrence, occurrenceRevision, participation: id(121) } } as StatementMeaningV2 },
  ].map(record => ({ ...record, receipt: commandReceiptIri(record.admission, STATEMENT_FAMILIES.record),
    key: statementMeaningKeyV2(record.meaning), manifest: '' }));
  const [assertion, trait] = records as [typeof records[number], typeof records[number]];
  let occurrenceManifest = '', definitionManifest = '', propertyManifest = '';
  let occurrenceActive = true, assertionVisible = true, assertionAdopted = true, relationAcknowledged = true,
    finalHeadMatches = true;
  let inventory: Row[] | null = null;
  const queries: string[] = [];
  const env = { objectDirectory: directory, lineage: { dataEpoch: nativeEpoch, routingEpoch: '1' }, fuseki: {
    query: async (query: string): Promise<SparqlResult> => {
      queries.push(query);
      const record = records.find(record => query.includes(`<${record.statement}>`));
      if (query.includes('SELECT DISTINCT ?statement ?revision')) return rows(inventory ?? (assertionVisible
        ? [{ statement: uri(assertion.statement), revision: uri(assertion.revision) }] : []));
      if (query.includes('SELECT ?model ?manifest ?admission')) {
        if (!record) throw new Error('Missing exact Statement selector');
        return rows([{ model: uri(STATEMENT_V2_PROFILE), manifest: uri(record.manifest), admission: literal(record.admission),
          operation: uri(record.operation), head: uri(record.revision) }]);
      }
      if (query.includes('SELECT ?outcome ?reason ?digest')) {
        const acknowledged = records.find(record => query.includes(`<${record.receipt}>`))!;
        return rows([{ outcome: uri(RV + 'Succeeded'), digest: literal(hash(acknowledged.statement)), id: literal(acknowledged.admission),
          epoch: literal('7'), scope: literal(`statement:speak:${actor}`), dataEpoch: literal(nativeEpoch), sequence: literal('4'),
          operation: uri(acknowledged.operation), component: uri(acknowledged.statement), revision: uri(acknowledged.revision) }]);
      }
      if (query.includes('SELECT ?manifest ?model ?generation')) {
        if (!record) throw new Error('Missing exact Statement snapshot');
        return rows([{ manifest: uri(record.manifest), model: uri(STATEMENT_V2_PROFILE), generation: uri(generation),
          state: uri(RV + 'Active'), operation: uri(record.operation), recordedBy: uri(actor), epoch: literal(nativeEpoch),
          sequence: literal('4'), head: uri(record.revision), currentState: uri(RV + 'Active'), receipt: uri(record.receipt),
          family: literal(STATEMENT_FAMILIES.record), admission: literal(record.admission), digest: literal(hash(record.statement)),
          authority: literal('7'), scope: literal(`statement:speak:${actor}`) }]);
      }
      if (query.includes('SELECT ?epoch ?sequence ?head')) return rows([{ epoch: literal(nativeEpoch), sequence: literal('9'), head: uri(record!.revision) }]);
      if (query.includes('SELECT ?epoch ?sequence ?context ?policy')) return rows([{ epoch: literal(nativeEpoch), sequence: literal('9'),
        context: uri(GLOBAL_CLASSIFICATION_CONTEXT), policy: uri(CLASSIFICATION_ISOLATE_POLICY) }]);
      if (query.includes('SELECT ?epoch ?sequence ?statement ?localSlot')) {
        if (!record) throw new Error('Missing exact adoption selector');
        const adopted = record !== assertion || assertionAdopted;
        return rows([{ statement: uri(record.statement), epoch: literal(nativeEpoch), sequence: literal('9'),
          globalSlot: uri(decisionSlotIri({ kind: 'statement', statement: record.statement }, GLOBAL_CLASSIFICATION_CONTEXT)),
          globalDecision: uri(record.decision), globalOutcome: uri(RV + (adopted ? 'Accepted' : 'Rejected')) },
          { statement: uri(record.key), epoch: literal(nativeEpoch), sequence: literal('9') }]);
      }
      if (query.includes('SELECT ?manifest ?predecessor')) return rows([{ manifest: uri(occurrenceManifest),
        epoch: literal(nativeEpoch), sequence: literal('2'), model: uri(RELATION_V2_PROFILE), generation: uri(generation), operation: uri(id(117)) }]);
      if (query.includes('SELECT ?definition ?manifest')) {
        const isProperty = query.includes(`<${propertyRevision}>`);
        return rows([{ definition: uri(isProperty ? property : definition), manifest: uri(isProperty ? propertyManifest : definitionManifest),
          kind: uri(RV + (isProperty ? 'PropertyDefinition' : 'RelationDefinition')), model: uri(PROFILES.definitionV2) }]);
      }
      if (query.includes('SELECT ?definition ?head')) return rows([{ definition: uri(property), head: uri(propertyRevision) }]);
      if (query.includes('SELECT ?receipt ?admission')) return rows(relationAcknowledged
        ? [{ receipt: uri(relationReceipt), admission: literal(relationAdmission) }] : []);
      if (query.includes('SELECT ?outcome ?reason ?kind')) return rows([{ outcome: uri(RV + 'Succeeded'), digest: literal(hash('relation-request')),
        admissionId: literal(relationAdmission), authorityEpoch: literal('7'), scope: literal('relation:write'),
        sequence: literal('2'), epoch: literal(nativeEpoch), component: uri(occurrence), revision: uri(occurrenceRevision) }]);
      if (query.includes('SELECT ?context ?disclosure')) return rows([{ context: uri(id(131)), disclosure: uri(RV + 'Private') }]);
      if (query.includes('ASK')) return { boolean: query.includes('rv:OperationReceipt') ? finalHeadMatches
        : query.includes('rv:occurrenceHead') ? occurrenceActive : true };
      throw new Error(`Unexpected native coverage owner query: ${query.slice(0, 100)}`);
    },
  } } as unknown as WorkActivationEnvironment;
  occurrenceManifest = await sealComponentState(env, occurrence, RELATION_V2_PROFILE, occurrenceState);
  definitionManifest = await sealComponentState(env, definition, PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'relation', roles: [{ key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
      { key: 'subject', minParticipants: 1, maxParticipants: 4, ordered: true },
      { key: 'alternate', minParticipants: 1, maxParticipants: 4, ordered: true }], workSubjectRole: 'work',
    association: { kind: 'appearance', workRole: 'work', subjectRoles: ['subject', 'alternate'] },
  }, 'semantic-change-v2'));
  propertyManifest = await sealComponentState(env, property, PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'property', roles: [], notation: OCCURRENCE_ASSERTION_NOTATION,
  }, 'semantic-change-v2'));
  for (const record of records) record.manifest = await sealComponentState(env, record.statement, STATEMENT_V2_PROFILE, {
    revision: record.revision, meaning: record.meaning, meaningKey: record.key, speaker: actor,
    semanticContextRevision: null, state: 'active', evidence: [], recordedBy: actor,
    modelGeneration: generation, subjectRdf: semanticValueRdf(record.meaning.subject, () => id(140)),
    valueRdf: semanticValueRdf(record.meaning.value, () => id(141)),
  });
  const work = { environment: env };
  const input: NativeBasisVerificationInput = { actingSubject: actor, native: { kind: 'statement', owner: 'statement',
    target: subject, statement: trait.statement, revision: trait.revision, receipt: trait.receipt,
    predicate: trait.meaning.predicate, relationDefinition: trait.meaning.relationDefinition, value: trait.meaning.value,
    context: 'global', qualifiers: { applicability: [], interpretationDefinitions: [] }, coverage: trait.meaning.coverage,
    acceptance: { context: GLOBAL_CLASSIFICATION_CONTEXT, decision: trait.decision, source: 'global' } },
    selected: { value: '原作', language: { state: 'value', value: 'ja' } } };
  return { work, input, assertion, trait, occurrence, occurrenceRevision, queries,
    assertionVisible: (value: boolean) => { assertionVisible = value; }, assertionAdopted: (value: boolean) => { assertionAdopted = value; },
    occurrenceActive: (value: boolean) => { occurrenceActive = value; }, relationAcknowledged: (value: boolean) => { relationAcknowledged = value; },
    finalHeadMatches: (value: boolean) => { finalHeadMatches = value; }, inventory: (value: Row[]) => { inventory = value; } };
}


test('composed participation attachment retains its terminal receipt and independently adopted occurrence', async () => {
  const native = await occurrenceFixture(), composed = await composition(native), input = await retained(composed.principalId, native.input);
  await composed.store.attach(composed.principal, composed.principalId, randomUUID(), input);
  expect(await saved(composed.principalId)).toEqual([{ native_acknowledgement: expect.objectContaining({
    receipt: native.trait.receipt, semantic: expect.objectContaining({
      commandReceipt: expect.objectContaining({ receipt: native.trait.receipt, component: native.trait.statement }),
      occurrenceAdoption: expect.objectContaining({
        commandReceipt: expect.objectContaining({ receipt: native.assertion.receipt, component: native.assertion.statement }),
      }),
    }),
  }) }]);
  native.assertionAdopted(false);
  await expect(composed.store.attach(composed.principal, composed.principalId, randomUUID(), input))
    .rejects.toMatchObject({ status: 503, code: 'source_support_unavailable' });
  expect(await saved(composed.principalId)).toHaveLength(1);
});

test('Source native verification uses the same exposed attribution owner and refuses an absent citation delegate', async () => {
  const native = await occurrenceFixture(true), composed = await composition(native), input = await retained(composed.principalId, native.input);
  const attribution = spyOn(composed.dependencies.relationAttribution!, 'verify');
  restores.push(() => attribution.mockRestore());
  await expect(composed.store.attach(composed.principal, composed.principalId, randomUUID(), input))
    .rejects.toMatchObject({ status: 503, code: 'source_support_unavailable' });
  expect(attribution).toHaveBeenCalled();
  expect(attribution.mock.calls[0]![0]).toMatchObject({ principal: composed.principal,
    requests: [expect.objectContaining({ support: { basis: { kind: 'source-binding', binding: id(160) },
      fields: ['creditedName'], evidence: [id(161)] } })] });
  expect(await saved(composed.principalId)).toEqual([]);
});
