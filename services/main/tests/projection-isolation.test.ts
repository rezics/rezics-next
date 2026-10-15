import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { ContentCore, ContentUnavailable, type ProjectionPublication, type VariantIdentity } from '../../content/src/core.ts';
import { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { relayContentProjectionOnce } from '../src/modules/content-publication/relay.ts';
import { ReadRankingProjection, RankingProjectionUnavailable } from '../src/modules/rankings/projection.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri } from '../src/modules/content-publication/eligibility.ts';
import { contentPublicationDecisionIri, contentPublicationReceiptIri }
  from '../src/modules/content-publication/publish.ts';
import { DATASET, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

const root = resolve(import.meta.dir, '../../..');
const id = () => `https://rezics.com/id/${crypto.randomUUID()}`;
const binding = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
const graphEpoch = '11111111-1111-4111-8111-111111111111';

type OwnerRow = Record<string, { type: string; value: string }>;
type ProjectionOwnerRecord = { variant: string; resource: string; revision: string; publication: string;
  eligibility: string; publicationRow: OwnerRow; eligibilityRow: OwnerRow };

function projectionOwnerRecord(publication: ProjectionPublication, eligibilityAdmission: string): ProjectionOwnerRecord {
  const ref = publication.reference;
  const publicationAdmission = publication.preparationId;
  const decision = contentPublicationDecisionIri(publicationAdmission);
  const publicationReceipt = contentPublicationReceiptIri(publicationAdmission);
  const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmission);
  const eligibilityReceipt = contentSearchEligibilityReceiptIri(eligibilityAdmission);
  const revision = `urn:rezics:content:revision:${ref.revisionId}`;
  const actor = 'urn:rezics:actor:content-search-reviewer';
  const preparation = publication.preparationId;
  const eligibilityInput = { resourceId: ref.resourceId, variantId: ref.variantId,
    publicationDecision: decision, expectedEligibilityHead: null, actingSubject: actor,
    rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };
  const makeRow = (key: string, id: string, receipt: string,
    fields: Array<[string, string | undefined, 'uri' | 'literal']>) => {
    const row: OwnerRow = { [key]: uri(id), decisionTypeCount: binding('1'), anchorTypeCount: binding('1'),
      receiptCount: binding('1'), receipt: uri(receipt), receiptTypeCount: binding('1') };
    for (const [name, value, type] of fields) {
      row[`${name}Count`] = binding(value === undefined ? '0' : '1');
      if (value !== undefined) row[name] = type === 'uri' ? uri(value) : binding(value);
    }
    return row;
  };
  const publicationRow = makeRow('publication', decision, publicationReceipt, [
    ['dComponent', ref.variantId, 'uri'], ['dResource', ref.resourceId, 'uri'], ['dRevision', revision, 'uri'],
    ['dDigest', ref.byteDigest, 'literal'], ['dOwnerEpoch', publication.preparationPosition.dataEpoch, 'literal'],
    ['dOwnerSequence', publication.preparationPosition.sequence, 'literal'], ['dDataEpoch', graphEpoch, 'literal'],
    ['dSequence', publication.graph.sequence, 'literal'],
    ['dModel', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dPreparation', preparation, 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'], ['rRequestDigest', 'b'.repeat(64), 'literal'],
    ['rAdmissionId', publicationAdmission, 'literal'], ['rAuthorityEpoch', '2', 'literal'],
    ['rScope', `content:publish:${ref.variantId}`, 'literal'], ['rPreparation', preparation, 'literal'],
    ['rRevision', revision, 'uri'], ['rVariant', ref.variantId, 'uri'], ['rResource', ref.resourceId, 'uri'],
    ['rByteDigest', ref.byteDigest, 'literal'], ['rOwnerEpoch', publication.preparationPosition.dataEpoch, 'literal'],
    ['rOwnerSequence', publication.preparationPosition.sequence, 'literal'], ['rExpectedHead', 'urn:rezics:none', 'uri'],
    ['rDataset', DATASET, 'uri'], ['rDataEpoch', graphEpoch, 'literal'],
    ['rSequence', publication.graph.sequence, 'literal'], ['rDecision', decision, 'uri'],
  ]);
  const eligibilitySequence = String(BigInt(publication.graph.sequence) + 1n);
  const eligibilityRow = makeRow('eligibility', eligibility, eligibilityReceipt, [
    ['dComponent', ref.variantId, 'uri'], ['dVariant', ref.variantId, 'uri'], ['dResource', ref.resourceId, 'uri'],
    ['dPublication', decision, 'uri'], ['dRightsBasis', `${RV}OriginalContribution`, 'uri'],
    ['dAssessment', undefined, 'uri'], ['dDisclosure', `${RV}Public`, 'uri'],
    ['dAdmissionId', eligibilityAdmission, 'literal'], ['dAuthorityEpoch', '2', 'literal'],
    ['dScope', `content:search-eligibility:${ref.variantId}`, 'literal'], ['dActor', actor, 'uri'],
    ['dModel', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dDataEpoch', graphEpoch, 'literal'], ['dSequence', eligibilitySequence, 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', contentSearchEligibilityDigest(eligibilityInput), 'literal'],
    ['rAdmissionId', eligibilityAdmission, 'literal'], ['rAuthorityEpoch', '2', 'literal'],
    ['rScope', `content:search-eligibility:${ref.variantId}`, 'literal'], ['rActor', actor, 'uri'],
    ['rResource', ref.resourceId, 'uri'], ['rVariant', ref.variantId, 'uri'], ['rPublication', decision, 'uri'],
    ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rRightsBasis', `${RV}OriginalContribution`, 'uri'],
    ['rAssessment', undefined, 'uri'], ['rDisclosure', `${RV}Public`, 'uri'], ['rDataset', DATASET, 'uri'],
    ['rDataEpoch', graphEpoch, 'literal'], ['rSequence', eligibilitySequence, 'literal'],
    ['rEligibility', eligibility, 'uri'],
  ]);
  return { variant: ref.variantId, resource: ref.resourceId, revision,
    publication: decision, eligibility, publicationRow, eligibilityRow };
}

/** Graph faults are injected at the owner boundary; durability uses real PostgreSQL. */
class ProjectionGraph extends FusekiClient {
  publications: ProjectionPublication[] = [];
  heads = new Map<string, string>();
  eligibilityAdmissions = new Map<string, string>();
  ownerRecords = new Map<string, ProjectionOwnerRecord>();
  eligibilityHeads = new Map<string, ProjectionOwnerRecord | null>();
  failed = new Set<string>();
  commands = new Set<string>();
  attempts = 0;
  healthReads = 0;
  structures = new Map<string, string>();
  constructor() { super('http://localhost:1/rezics'); }
  override async commandHealth() {
    this.healthReads++;
    return { moduleVersion: 'test', instanceId: graphEpoch, publicSearchWriteEpoch: '0',
      publicSearchWriteActive: false, profiles: Object.fromEntries(Object.entries(profileRegistry).map(([name, p]) => [name, p.sha256])) };
  }
  override async query(sparql: string): Promise<SparqlResult> {
    // The relay first asks whether public search is open (the anchor is present).
    if (sparql.includes('SearchGraphAnchor')) return { boolean: true } as unknown as SparqlResult;
    if (sparql.includes('SELECT ?work WHERE')) {
      const entry = [...this.structures].find(([structure]) => sparql.includes(`<${structure}>`));
      return { results: { bindings: entry && !this.failed.has(entry[0]) ? [{ work: binding(entry[1]) }] : [] } };
    }
    if (sparql.includes('SELECT DISTINCT ?work ?main')) return { results: { bindings: [] } };
    if (sparql.includes('SELECT ?epoch ?routing ?sequence WHERE')) {
      return { results: { bindings: [{ epoch: binding(graphEpoch), routing: binding('1'), sequence: binding('100') }] } };
    }
    const currentOwners = [...new Set(this.publications.map(item => item.reference.variantId))]
      .map(variant => this.currentOwnerRecord(variant)).filter((record): record is ProjectionOwnerRecord => Boolean(record));
    const allOwners = this.publications.map(publication => this.ownerRecord(publication));
    if (sparql.includes('(COUNT(DISTINCT ?resource) AS ?resourceCount)')) {
      return { results: { bindings: currentOwners.filter(record => sparql.includes(`<${record.variant}>`)).map(record => ({
        variant: uri(record.variant), resourceCount: binding('1'), resource: uri(record.resource),
        publicationCount: binding('1'), publication: uri(record.publication),
        eligibilityCount: binding(this.eligibilityRecord(record.variant) ? '1' : '0'),
        ...(this.eligibilityRecord(record.variant) ? { eligibility: uri(this.eligibilityRecord(record.variant)!.eligibility) } : {}),
      })) } };
    }
    if (sparql.includes('SELECT ?eligibility') && sparql.includes('?decisionTypeCount')) {
      return { results: { bindings: allOwners.filter(record => sparql.includes(`<${record.eligibility}>`))
        .map(record => record.eligibilityRow) } };
    }
    if (sparql.includes('SELECT ?publication') && sparql.includes('?decisionTypeCount')) {
      return { results: { bindings: allOwners.filter(record => sparql.includes(`<${record.publication}>`))
        .map(record => record.publicationRow) } };
    }
    const publication = this.publications.find(p => sparql.includes(`<${p.graph.receipt}>`));
    if (!publication) throw new Error('unexpected graph proof');
    if (this.failed.has(publication.reference.variantId)) throw new Error('target unavailable');
    const { reference: r, preparationPosition: at, preparationId } = publication;
    const decision = contentPublicationDecisionIri(preparationId);
    const current = this.eligibilityRecord(r.variantId);
    return { results: { bindings: [{ epoch: binding(graphEpoch), routing: binding('1'), sequence: binding('100'),
      outcome: binding(`${RV}Succeeded`), receiptEpoch: binding(graphEpoch), receiptSequence: binding(publication.graph.sequence),
      decision: binding(decision), head: binding(this.heads.get(r.variantId) ?? decision),
      ...(current ? { eligibility: uri(current.eligibility), eligibleDecision: uri(current.publication) } : {}),
      revision: binding(`urn:rezics:content:revision:${r.revisionId}`), digest: binding(r.byteDigest),
      ownerEpoch: binding(at.dataEpoch), ownerSequence: binding(at.sequence), resource: binding(r.resourceId), variant: binding(r.variantId),
      decisionRevision: binding(`urn:rezics:content:revision:${r.revisionId}`), decisionDigest: binding(r.byteDigest),
      decisionEpoch: binding(at.dataEpoch), decisionSequence: binding(at.sequence),
    }] } };
  }
  private currentOwnerRecord(variant: string): ProjectionOwnerRecord | undefined {
    const currentDecision = this.heads.get(variant);
    const publication = [...this.publications].reverse().find(item => item.reference.variantId === variant
      && (!currentDecision || contentPublicationDecisionIri(item.preparationId) === currentDecision));
    if (!publication) return undefined;
    return this.ownerRecord(publication);
  }
  private eligibilityRecord(variant: string): ProjectionOwnerRecord | undefined | null {
    return this.eligibilityHeads.has(variant) ? this.eligibilityHeads.get(variant) : this.currentOwnerRecord(variant);
  }
  ownerRecord(publication: ProjectionPublication): ProjectionOwnerRecord {
    const retained = this.ownerRecords.get(publication.preparationId);
    if (retained) return retained;
    let admission = this.eligibilityAdmissions.get(publication.preparationId);
    if (!admission) { admission = crypto.randomUUID(); this.eligibilityAdmissions.set(publication.preparationId, admission); }
    const record = projectionOwnerRecord(publication, admission);
    this.ownerRecords.set(publication.preparationId, record);
    return record;
  }
  async deliverApproval(content: ContentCore, publication: ProjectionPublication) {
    const record = this.ownerRecord(publication);
    const expected = await content.readEligibilityDeliveryProgress(MAIN_RELAY_STREAM_SCOPE, graphEpoch);
    const sequence = (BigInt(expected.sequence) + 1n).toString();
    const delivered = await content.ingestEligibilityDeliveryPage({ expected, batches: [{
      sequence, id: `batch-${sequence}`, digest: 'a'.repeat(64), events: [{
        id: `urn:rezics:event:${crypto.randomUUID()}`, type: 'com.rezics.content.search-eligible.v1', ordinal: 0,
        sourcePosition: { dataEpoch: graphEpoch, sequence: record.eligibilityRow.dSequence!.value },
        receipt: { id: record.eligibilityRow.receipt!.value, action: 'content.search-eligibility', outcome: 'succeeded',
          requestDigest: record.eligibilityRow.rRequestDigest!.value, resource: record.resource, variant: record.variant,
          publicationDecision: record.publication, eligibilityDecision: record.eligibility, disclosure: 'public' },
        publication: { preparationId: publication.preparationId, revisionId: publication.reference.revisionId },
      }],
    }] });
    return (await content.readOutbox(expected.contentDataEpoch, '0', 100))
      .find(event => event.operationId === delivered.events[0]!.operationId)!;
  }
  override async command(command: Parameters<FusekiClient['command']>[0]) {
    this.attempts++;
    this.commands.add(command.receipt);
    return { status: 'committed' as const, receipt: command.receipt, replayed: false,
      position: { datasetId: 'urn:rezics:dataset:product', dataEpoch: graphEpoch, sequence: '100' } };
  }
}

async function postgres(run: (pool: Pool) => Promise<void>) {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 4 });
  try { await migrateContent(pool); await run(pool); }
  finally { await pool.end(); cluster.remove(); }
}

async function publishProjection(content: ContentCore, graph: ProjectionGraph, variant: VariantIdentity,
  body: string, predecessor: string | null = null, model = 'content-shape-v1', approve = true) {
  const saved = await content.saveDraft({ operationId: crypto.randomUUID(), variant, model, expectedHead: predecessor,
    sourceRevision: null, provenance: {}, serializedJson: JSON.stringify({ body }) });
  const exact = (await content.readExactBatch([saved.revisionId!], async ids => new Set(ids)))[0];
  if (exact?.status !== 'available') throw new Error('source missing');
  const preparationId = crypto.randomUUID();
  await content.preparePublication(preparationId, saved.revisionId!, exact.reference.byteDigest, true, saved.position.dataEpoch);
  const settled = await content.settlePublication(crypto.randomUUID(), preparationId, { outcome: 'active', revisionId: saved.revisionId!,
    receipt: `urn:rezics:receipt:${preparationId}`, dataEpoch: graphEpoch,
    sequence: String(graph.publications.length * 10 + 7) }, saved.position.dataEpoch);
  if (!settled.position) throw new Error('terminal source missing');
  const event = (await content.readOutbox(saved.position.dataEpoch, String(BigInt(settled.position.sequence) - 1n), 1))[0]!;
  const publication = await content.readProjectionPublication(event);
  graph.publications.push(publication); graph.heads.set(variant.id, contentPublicationDecisionIri(preparationId));
  if (approve) await graph.deliverApproval(content, publication);
  return { revision: saved.revisionId!, event, publication };
}

test('Content retains failed A while B projects, survives restart, supersedes in order and replays a graph commit', async () => {
  await postgres(async pool => {
    const content = new ContentCore(pool), graph = new ProjectionGraph();
    const env: WorkActivationEnvironment = { fuseki: graph, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' }, objectDirectory: '.temp/unused' };
    const cursor = new ContentProjectionCursor(pool), consumer = 'isolation';
    await cursor.initialize(consumer);
    const publish = (variant: VariantIdentity, body: string, predecessor: string | null = null, model = 'content-shape-v1') =>
      publishProjection(content, graph, variant, body, predecessor, model);
    const variant = (language = 'en'): VariantIdentity => ({ id: `urn:rezics:variant:${crypto.randomUUID()}`, resourceId: id(),
      language: { kind: 'tag', tag: language, originalTag: language }, direction: 'ltr' });
    const a = variant('zh-Hans-u-nu-hanidec'), b = variant();
    const first = await publish(a, '中'.repeat(30_000));
    graph.failed.add(a.id);
    await publish(b, '... !!!');
    const later = await publish(a, '后来', first.revision);
    for (let n = 0; n < 12; n++) await relayContentProjectionOnce(env, content, cursor, consumer);
    expect(graph.commands.size).toBe(1);
    expect((await cursor.readScan(consumer)).sequence).toBe('12');
    expect((await cursor.read(consumer)).sequence).toBe('2');
    expect(await pool.query('DELETE FROM content.outbox WHERE id=$1', [first.event.id]).then(() => false, () => true)).toBe(true);
    const restarted = new ContentProjectionCursor(pool);
    expect(await restarted.retries(consumer)).toHaveLength(1);
    graph.failed.clear();
    const unavailableOldBody = Object.create(content) as ContentCore;
    unavailableOldBody.readProjectionPublication = async (event, metadataOnly) => {
      if (event.id === first.event.id && !metadataOnly) throw new ContentUnavailable('old body unavailable');
      return content.readProjectionPublication(event, metadataOnly);
    };
    expect((await relayContentProjectionOnce(env, unavailableOldBody, restarted, consumer))?.disposition).toBe('superseded');
    expect((await relayContentProjectionOnce(env, content, restarted, consumer))?.disposition).toBe('superseded');
    expect((await relayContentProjectionOnce(env, content, restarted, consumer))?.disposition).toBe('superseded');
    expect((await relayContentProjectionOnce(env, content, restarted, consumer))?.disposition).toBe('projected');
    expect((await restarted.read(consumer)).sequence).toBe('12');
    expect(graph.commands.size).toBe(2);
    expect(later.event.position.sequence).toBe('11');

    // A crash after graph commit leaves the source unacknowledged. Restart
    // executes the same receipt and never creates another graph effect.
    await publish(b, 'new body', graph.publications.find(p => p.reference.variantId === b.id)!.reference.revisionId);
    await relayContentProjectionOnce(env, content, restarted, consumer);
    await relayContentProjectionOnce(env, content, restarted, consumer);
    await relayContentProjectionOnce(env, content, restarted, consumer);
    await pool.query(`CREATE FUNCTION content.fail_projection_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'crash before acknowledgement'; END $$;
      CREATE TRIGGER fail_projection_ack BEFORE UPDATE ON content.projection_checkpoint
      FOR EACH ROW EXECUTE FUNCTION content.fail_projection_ack()`);
    await expect(relayContentProjectionOnce(env, content, restarted, consumer)).rejects.toThrow('crash before acknowledgement');
    expect((await restarted.readScan(consumer)).sequence).toBe('15');
    const effects = graph.commands.size;
    await pool.query('DROP TRIGGER fail_projection_ack ON content.projection_checkpoint');
    await relayContentProjectionOnce(env, content, new ContentProjectionCursor(pool), consumer);
    expect(graph.commands.size).toBe(effects);
    expect((await restarted.read(consumer)).sequence).toBe('16');

    const organization = variant();
    await publish(organization, 'Organization description', null, 'catalog-description-v1');
    for (let n = 0; n < 4; n++) await relayContentProjectionOnce(env, content, restarted, consumer);
    expect(graph.commands.size).toBe(effects);
    expect((await restarted.read(consumer)).sequence).toBe('20');
    const unknown = await content.saveDraft({ operationId: crypto.randomUUID(), variant: variant(), expectedHead: null,
      model: 'content-shape-v1', sourceRevision: null, provenance: {}, serializedJson: '{"body":"valid"}' });
    const event = (await content.readOutbox(unknown.position.dataEpoch, '20', 1))[0]!;
    const corrupt = Object.create(content) as ContentCore;
    corrupt.readOutbox = async () => [{ ...event, eventType: 'malformed' }];
    await expect(relayContentProjectionOnce(env, corrupt, restarted, consumer)).rejects.toThrow('unrecognized Content event');
    expect((await restarted.readScan(consumer)).sequence).toBe('20');
  });
}, 60_000);

test('Content completes proved closed states without bytes while corrupt predecessors and unproved erasure stay pending', async () => {
  await postgres(async pool => {
    const content = new ContentCore(pool), graph = new ProjectionGraph(), cursor = new ContentProjectionCursor(pool);
    const consumer = 'closed-evaluation';
    await cursor.initialize(consumer);
    const env: WorkActivationEnvironment = { fuseki: graph, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' },
      objectDirectory: '.temp/unused' };
    const variant = (): VariantIdentity => ({ id: `urn:rezics:variant:${crypto.randomUUID()}`, resourceId: id(),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' });
    const a = variant(), b = variant();
    graph.eligibilityHeads.set(a.id, null);
    const first = await publishProjection(content, graph, a, 'closed body', null, 'content-shape-v1', false);
    const metadataOnly = Object.create(content) as ContentCore;
    metadataOnly.readProjectionPublication = async (event, allowUnavailable) => {
      if (!allowUnavailable) throw new ContentUnavailable('closed body must not be read');
      return content.readProjectionPublication(event, true);
    };
    metadataOnly.readExactBatch = async () => { throw new ContentUnavailable('closed bytes must not be read'); };
    await relayContentProjectionOnce(env, metadataOnly, cursor, consumer);
    await relayContentProjectionOnce(env, metadataOnly, cursor, consumer);
    const erasureRefusal = Object.create(metadataOnly) as ContentCore;
    erasureRefusal.readPublicationErasureSupersession = async () => ({ revisionId: first.revision,
      erasureId: crypto.randomUUID(), erasureEpoch: '1', graphReceipt: 'urn:unproven-erasure',
      graphDataEpoch: graphEpoch, graphSequence: '9' });
    expect((await relayContentProjectionOnce(env, erasureRefusal, cursor, consumer))?.disposition).toBe('deferred');
    expect((await cursor.read(consumer)).sequence).toBe('2');
    expect((await relayContentProjectionOnce(env, metadataOnly, cursor, consumer))?.disposition).toBe('ignored');
    expect(await cursor.read(consumer)).toEqual(await content.ownerPosition());
    expect(graph.healthReads).toBe(0);
    expect(graph.commands.size).toBe(0);

    graph.eligibilityHeads.delete(a.id);
    await graph.deliverApproval(content, first.publication);
    expect((await relayContentProjectionOnce(env, content, cursor, consumer))?.disposition).toBe('projected');
    const approval = graph.ownerRecord(first.publication);
    graph.eligibilityHeads.set(a.id, approval);
    await publishProjection(content, graph, a, 'replacement closed body', first.revision, 'content-shape-v1', false);
    await relayContentProjectionOnce(env, metadataOnly, cursor, consumer);
    await relayContentProjectionOnce(env, metadataOnly, cursor, consumer);
    const profilesBeforeClosed = graph.healthReads;
    await pool.query(`CREATE FUNCTION content.fail_closed_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'lost closed evaluation acknowledgement'; END $$;
      CREATE TRIGGER fail_closed_ack BEFORE UPDATE ON content.projection_checkpoint
      FOR EACH ROW EXECUTE FUNCTION content.fail_closed_ack()`);
    try {
      await expect(relayContentProjectionOnce(env, metadataOnly, cursor, consumer))
        .rejects.toThrow('lost closed evaluation acknowledgement');
      expect((await cursor.read(consumer)).sequence).toBe('6');
    } finally { await pool.query('DROP TRIGGER fail_closed_ack ON content.projection_checkpoint'); }

    // A present retained approval with damaged authority cannot count as closed.
    approval.eligibilityRow.dDisclosure = uri(`${RV}Private`);
    expect((await relayContentProjectionOnce(env, content, cursor, consumer))?.disposition).toBe('deferred');
    await publishProjection(content, graph, b, 'unrelated public body');
    for (let n = 0; n < 4; n++) await relayContentProjectionOnce(env, content, cursor, consumer);
    expect(graph.commands.size).toBe(2);
    expect((await cursor.read(consumer)).sequence).toBe('6');
    expect((await cursor.readScan(consumer)).sequence).toBe('11');
    expect(await cursor.retries(consumer)).toHaveLength(1);
    approval.eligibilityRow.dDisclosure = uri(`${RV}Public`);
    const profilesBeforeRetry = graph.healthReads;
    expect((await relayContentProjectionOnce(env, metadataOnly, cursor, consumer))?.disposition).toBe('ignored');
    expect(graph.healthReads).toBe(profilesBeforeRetry);
    expect(profilesBeforeClosed).toBe(1);
    expect(await cursor.read(consumer)).toEqual(await content.ownerPosition());
    expect(await cursor.retries(consumer)).toHaveLength(0);
  });
}, 60_000);

test('Content re-evaluates a lost closed acknowledgement after a durable later Public approval', async () => {
  await postgres(async pool => {
    const content = new ContentCore(pool), graph = new ProjectionGraph(), cursor = new ContentProjectionCursor(pool);
    const consumer = 'closed-approval-race';
    await cursor.initialize(consumer);
    const env: WorkActivationEnvironment = { fuseki: graph, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' },
      objectDirectory: '.temp/unused' };
    const variant: VariantIdentity = { id: `urn:rezics:variant:${crypto.randomUUID()}`, resourceId: id(),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' };
    graph.eligibilityHeads.set(variant.id, null);
    const published = await publishProjection(content, graph, variant, 'later approved body', null, 'content-shape-v1', false);
    await relayContentProjectionOnce(env, content, cursor, consumer);
    await relayContentProjectionOnce(env, content, cursor, consumer);
    await pool.query(`CREATE FUNCTION content.fail_closed_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'lost closed evaluation acknowledgement'; END $$;
      CREATE TRIGGER fail_closed_ack BEFORE UPDATE ON content.projection_checkpoint
      FOR EACH ROW EXECUTE FUNCTION content.fail_closed_ack()`);
    try {
      await expect(relayContentProjectionOnce(env, content, cursor, consumer))
        .rejects.toThrow('lost closed evaluation acknowledgement');
    } finally { await pool.query('DROP TRIGGER fail_closed_ack ON content.projection_checkpoint'); }
    expect((await cursor.read(consumer)).sequence).toBe('2');
    graph.eligibilityHeads.delete(variant.id);
    await graph.deliverApproval(content, published.publication);
    expect((await relayContentProjectionOnce(env, content, cursor, consumer))?.disposition).toBe('superseded');
    expect((await relayContentProjectionOnce(env, content, cursor, consumer))?.disposition).toBe('projected');
    expect(await cursor.read(consumer)).toEqual(await content.ownerPosition());
    expect(await relayContentProjectionOnce(env, content, cursor, consumer)).toBeNull();
    expect(graph.commands.size).toBe(1);
  });
}, 60_000);

test('Read ranking upgrades populated coverage and retains each failed Structure independently', async () => {
  await postgres(async pool => {
    const files = schemaFiles(root, 'access');
    const upgrade = files.indexOf('1399_read_rankings.sql');
    expect(upgrade).toBeGreaterThanOrEqual(0);
    // Seed the retained row before the upgrade; later migrations also stay in file order.
    for (const file of files.slice(0, upgrade)) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    const content = new ContentCore(pool), graph = new ProjectionGraph();
    const owner = await content.ownerPosition();
    await pool.query(`INSERT INTO access.read_ranking_checkpoint
      (generation,content_epoch,content_sequence,graph_epoch,review_position) VALUES ($1,$2,7,$3,5)`,
    [crypto.randomUUID(), owner.dataEpoch, graphEpoch]);
    for (const file of files.slice(upgrade)) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    expect((await pool.query('SELECT content_scan_sequence::text,review_scan_position::text FROM access.read_ranking_checkpoint')).rows[0])
      .toEqual({ content_scan_sequence: '7', review_scan_position: '5' });
    await pool.query('DELETE FROM access.read_ranking_checkpoint');
    const env: WorkActivationEnvironment = { fuseki: graph, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' }, objectDirectory: '.temp/unused' };
    const a = id(), b = id(), aw = id(), bw = id();
    graph.structures.set(a, aw); graph.structures.set(b, bw); graph.failed.add(a);
    const progress = async (structure: string, malformed = false) => {
      const operation = crypto.randomUUID(), occurrence = id(), eventId = crypto.randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO structure.progress_command (agent,principal_issuer,principal_subject,idempotency_key,
          request_digest,structure,occurrence,selection_key,result_version,result_completed,content_operation,first_read,first_finish)
          VALUES ($5,'test','test',$1,$2,$3,$4,'',1,false,$1,true,false)`, [operation, 'a'.repeat(64), structure, occurrence, id()]);
        await client.query(`INSERT INTO content.receipt(operation_id,request_digest,action,outcome)
          VALUES ($1,$2,'structure.progress','succeeded')`, [operation, 'a'.repeat(64)]);
        await client.query(`INSERT INTO content.outbox(id,operation_id,event_type,recipe,payload)
          VALUES ($1,$2,'structure.progress.written','structure-progress-v1',$3::jsonb)`,
        [eventId, operation, JSON.stringify({ structure, occurrence, read: !malformed, finished: false })]);
        await client.query('COMMIT');
      } finally { client.release(); }
      await content.sequencePending();
    };
    await progress(a); await progress(b); await progress(a);
    const projection = new ReadRankingProjection(pool, content, pool, env);
    expect(await projection.tick()).toBe(3);
    const checkpoint = (await pool.query('SELECT content_scan_sequence::text,content_sequence::text FROM access.read_ranking_checkpoint')).rows[0];
    expect(checkpoint).toEqual({ content_scan_sequence: '3', content_sequence: '0' });
    expect((await pool.query("SELECT work,score::text FROM access.read_ranking_score WHERE metric='reads' AND interval='day'")).rows)
      .toEqual([{ work: bw, score: '1' }]);
    await expect(projection.current()).rejects.toThrow('catching up');
    const restarted = new ReadRankingProjection(pool, content, pool, env);
    graph.failed.clear();
    const concurrent = await Promise.allSettled([restarted.tick(), new ReadRankingProjection(pool, content, pool, env).tick()]);
    expect(concurrent.some(result => result.status === 'fulfilled')).toBe(true);
    for (const result of concurrent) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(RankingProjectionUnavailable);
    const remaining = (await pool.query(`SELECT first_position::text FROM access.read_ranking_target WHERE target=$1`, [a])).rows;
    expect(remaining.every(row => row.first_position === '3')).toBe(true);
    expect(await restarted.tick()).toBeLessThanOrEqual(1);
    expect(await restarted.tick()).toBe(0);
    expect((await restarted.current()).contentSequence).toBe('3');
    expect((await pool.query("SELECT score::text FROM access.read_ranking_score WHERE work=$1 AND metric='reads' AND interval='day'", [aw])).rows[0].score).toBe('2');
    await progress(b);
    await pool.query(`CREATE FUNCTION access.fail_ranking_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'crash before ranking acknowledgement'; END $$;
      CREATE TRIGGER fail_ranking_ack BEFORE UPDATE ON access.read_ranking_checkpoint
      FOR EACH ROW EXECUTE FUNCTION access.fail_ranking_ack()`);
    await expect(restarted.tick()).rejects.toThrow('crash before ranking acknowledgement');
    expect((await pool.query("SELECT score::text FROM access.read_ranking_score WHERE work=$1 AND metric='reads' AND interval='day'", [bw])).rows[0].score).toBe('1');
    await pool.query('DROP TRIGGER fail_ranking_ack ON access.read_ranking_checkpoint');
    await new ReadRankingProjection(pool, content, pool, env).tick();
    expect((await pool.query("SELECT score::text FROM access.read_ranking_score WHERE work=$1 AND metric='reads' AND interval='day'", [bw])).rows[0].score).toBe('2');
    await progress(b, true);
    await expect(restarted.tick()).rejects.toThrow('differs from its receipt');
    expect((await pool.query('SELECT content_scan_sequence::text FROM access.read_ranking_checkpoint')).rows[0].content_scan_sequence).toBe('4');
    await pool.query('UPDATE access.read_ranking_checkpoint SET content_sequence=3 WHERE singleton');
    await expect(restarted.current()).rejects.toThrow('catching up');
    await expect(restarted.tick()).rejects.toThrow('coverage differs');
  });
}, 60_000);

test('Content retries seek at most eight target heads even with a long same-target backlog', async () => {
  await postgres(async pool => {
    const content = new ContentCore(pool), cursor = new ContentProjectionCursor(pool);
    const consumer = 'bounded-retries';
    let position = await cursor.initialize(consumer), revision: string | null = null;
    const variant: VariantIdentity = { id: `urn:rezics:variant:${crypto.randomUUID()}`, resourceId: id(),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' };
    for (let index = 1; index <= 100; index++) {
      const saved = await content.saveDraft({ operationId: crypto.randomUUID(), variant,
        expectedHead: revision, model: 'content-shape-v1', sourceRevision: null, provenance: {},
        serializedJson: JSON.stringify({ body: `Retained event ${index}` }) });
      revision = saved.revisionId;
      const event = (await content.readOutbox(position.dataEpoch, position.sequence, 1))[0]!;
      const retained = { event, target: index <= 9 ? `target:${index}` : 'target:1' };
      if (index === 100) {
        const attempts = await Promise.allSettled([cursor.acknowledge(consumer, position, event.position, retained),
          new ContentProjectionCursor(pool).acknowledge(consumer, position, event.position, retained)]);
        expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      } else await cursor.acknowledge(consumer, position, event.position, retained);
      position = event.position;
    }
    const first = await cursor.retries(consumer);
    expect(first).toHaveLength(8);
    expect(first.map(event => event.position.sequence)).toEqual(['1','2','3','4','5','6','7','8']);
    for (const event of first) await cursor.finishRetry(consumer, event, false);
    expect((await cursor.retries(consumer))[0]?.position.sequence).toBe('9');
    await cursor.finishRetry(consumer, first[0]!, true);
    expect((await pool.query(`SELECT first_sequence::text FROM content.projection_target
      WHERE consumer=$1 AND target='target:1'`, [consumer])).rows[0].first_sequence).toBe('10');
    expect((await cursor.read(consumer)).sequence).toBe('1');
    expect((await cursor.readScan(consumer)).sequence).toBe('100');
    await expect(cursor.acknowledge(consumer, position, { ...position, sequence: '101' })).rejects.toThrow('source event missing');
    expect((await cursor.readScan(consumer)).sequence).toBe('100');
    await pool.query('DELETE FROM content.projection_pending WHERE consumer=$1', [consumer]);
    await expect(cursor.readScan(consumer)).rejects.toThrow('coverage differs');
    await expect(cursor.acknowledge(consumer, position, { ...position, sequence: '101' })).rejects.toThrow('coverage differs');
  });
}, 60_000);


test('Fresh Access install applies every migration in file order and enforces ranking coverage', async () => {
  await postgres(async pool => {
    for (const file of schemaFiles(root, 'access')) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    const owner = await new ContentCore(pool).ownerPosition();
    await pool.query(`INSERT INTO access.read_ranking_checkpoint
      (generation,content_epoch,graph_epoch) VALUES ($1,$2,$3)`,
    [crypto.randomUUID(), owner.dataEpoch, graphEpoch]);
    expect((await pool.query(`SELECT content_sequence::text,content_scan_sequence::text,
      review_position::text,review_scan_position::text FROM access.read_ranking_checkpoint`)).rows[0])
      .toEqual({ content_sequence: '0', content_scan_sequence: '0', review_position: '0', review_scan_position: '0' });
    await expect(pool.query('UPDATE access.read_ranking_checkpoint SET content_sequence=1 WHERE singleton'))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE access.read_ranking_checkpoint SET review_position=1 WHERE singleton'))
      .rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE access.read_ranking_checkpoint SET content_sequence=1,content_scan_sequence=1,
      review_position=1,review_scan_position=1 WHERE singleton`);
  });
}, 60_000);
