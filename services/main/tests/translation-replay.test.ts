import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { RV, hash, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { relayCoverage, type MainCloudEvent, type RelayCoverage } from '../src/modules/outbox/relay.ts';
import { parseRetainedTranslationLink, reconcileRetainedTranslationLink,
  RetainedEffectConflict } from '../src/modules/work/reconcile-restored.ts';
import { translationLinkDigest, translationLinkReceiptIri,
  type TranslationLinkInput } from '../src/modules/work/translation-links.ts';

const ids = Array.from({ length: 9 }, (_, n) =>
  `https://rezics.com/id/00000000-0000-0000-0000-${String(n + 1).padStart(12, '0')}`);
const dataEpoch = '00000000-0000-0000-0000-000000000001';
const restoredEpoch = '00000000-0000-0000-0000-000000000002';
const admissionId = '00000000-0000-0000-0000-000000000003';
const consumer = 'main-test';
const idempotencyKey = 'translation-request-1';
const value = (text: string) => ({ value: text });

function fixture(status: 'official' | 'third-party', sourceMainRevision: string | null) {
  const input: TranslationLinkInput = {
    targetWork: ids[0]!, targetMainVersion: ids[1]!, targetMainRevision: ids[2]!,
    sourceWork: ids[3]!, sourceMainVersion: ids[4]!, sourceMainRevision,
    status, contentLanguage: 'zh-Hans', translator: ids[5]!, publisher: ids[6]!,
    evidence: 'https://example.test/translation-evidence', actingSubject: ids[7]!,
  };
  const scope = status === 'official'
    ? `translation:authorize:${input.sourceWork}:${sourceMainRevision}`
    : `translation:link:${input.targetWork}`;
  const action = status === 'official' ? 'translation.authorize' : 'translation.link';
  const receiptId = translationLinkReceiptIri(admissionId);
  const eventId = `urn:rezics:event:${hash(`${receiptId}\0translation-linked`)}`;
  const batchId = `urn:rezics:outbox:${hash(receiptId)}`;
  const envelope: MainCloudEvent = {
    specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
    type: 'com.rezics.translation.linked.v1', datacontenttype: 'application/json',
    data: { batchId, sourcePosition: { datasetId: 'product', dataEpoch, sequence: '1' },
      routingEpoch: 'routing-1', ordinal: 0,
      receipt: { id: receiptId, action, outcome: 'succeeded', admissionId,
        requestDigest: translationLinkDigest({ ...input, idempotencyKey }),
        authorityEpoch: '1', scope,
        translationLink: ids[8]!, targetWork: input.targetWork,
        targetMainVersion: input.targetMainVersion, targetMainRevision: input.targetMainRevision,
        sourceWork: input.sourceWork, sourceMainVersion: input.sourceMainVersion,
        sourceMainRevision, sourceVersionStatus: sourceMainRevision ? 'exact' : 'unresolved',
        translationStatus: status, contentLanguage: input.contentLanguage,
        translator: input.translator, publisher: input.publisher, evidence: input.evidence,
        linkedBy: input.actingSubject,
        authorizingParty: status === 'official' ? input.actingSubject : null,
        authorizationScope: status === 'official' ? scope : null,
        authorizationEpoch: status === 'official' ? '1' : null } },
  };
  const coverage: RelayCoverage = { consumer, dataEpoch, sequence: '1', batchCount: '1',
    batchDigest: '', eventCount: '1', eventDigest: '' };
  return { input, envelope, eventId, batchId, coverage };
}

test('retained translation parser preserves exact official and unresolved third-party provenance', () => {
  for (const [status, sourceRevision] of [
    ['official', ids[4]], ['third-party', null],
  ] as const) {
    const source = fixture(status, sourceRevision);
    const parsed = parseRetainedTranslationLink(source.eventId, source.envelope,
      source.coverage, '1');
    expect(parsed.input).toEqual(source.input);
    expect(parsed.link).toBe(ids[8]);
    expect(parsed.receipt.sourceVersionStatus).toBe(sourceRevision ? 'exact' : 'unresolved');
    expect(parsed.receipt.authorizingParty).toBe(status === 'official' ? ids[7] : null);
  }
});

test('retained translation parser rejects omitted, altered and falsely authorized evidence', () => {
  const source = fixture('official', ids[4]!);
  const mutations: ((event: MainCloudEvent) => void)[] = [
    event => { event.data.receipt.sourceMainRevision = null; },
    event => { event.data.receipt.sourceVersionStatus = 'unresolved'; },
    event => { event.data.receipt.authorizationScope = 'translation:link:wrong'; },
    event => { event.data.receipt.authorizingParty = null; },
    event => { event.data.receipt.requestDigest = 'invalid'; },
    event => { event.data.receipt.evidence = 'http://example.test/forged'; },
    event => { delete event.data.receipt.authorizationEpoch; },
    event => { event.data.batchId = 'urn:rezics:outbox:wrong'; },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(source.envelope);
    mutate(altered);
    expect(() => parseRetainedTranslationLink(source.eventId, altered, source.coverage, '1'))
      .toThrow(RetainedEffectConflict);
  }
  const thirdParty = fixture('third-party', null);
  thirdParty.envelope.data.receipt.authorizingParty = ids[7];
  expect(() => parseRetainedTranslationLink(thirdParty.eventId, thirdParty.envelope,
    thirdParty.coverage, '1')).toThrow(RetainedEffectConflict);
});

function mockRecovery(status: 'official' | 'third-party', sourceRevision: string | null) {
  const source = fixture(status, sourceRevision);
  const access = { action: source.envelope.data.receipt.action, state: 'sealed',
    scope_id: source.envelope.data.receipt.scope,
    request_digest: source.envelope.data.receipt.requestDigest, authority_epoch: '1',
    idempotency_key: idempotencyKey,
    acting_subject: ids[7]!, graph_receipt: source.envelope.data.receipt.id,
    graph_outcome: 'succeeded', graph_data_epoch: dataEpoch, graph_sequence: '1' };
  const fence = { open: false };
  let committed = false;
  let commands = 0;
  let eventPresent = true;
  const relayQuery = async (sql: string) => {
    if (sql.includes('FROM relay.checkpoint')) return { rows: [{ data_epoch: dataEpoch, sequence: '1' }] };
    if (sql.includes('UNION ALL')) return { rows: [], rowCount: 0 };
    if (sql.includes('actual_count')) return { rows: [{ sequence: '1', batch_id: source.batchId,
      routing_epoch: 'routing-1', event_count: 1, actual_count: eventPresent ? '1' : '0' }] };
    if (sql.includes('envelope::text')) return { rows: eventPresent ? [{ source: 'main',
      event_id: source.eventId, sequence: '1', body: JSON.stringify(source.envelope) }] : [] };
    if (sql.includes('SELECT event_id, envelope')) return { rows: eventPresent
      ? [{ event_id: source.eventId, envelope: source.envelope }] : [] };
    if (sql.includes('SELECT batch_id, routing_epoch')) return { rows: [{ batch_id: source.batchId,
      routing_epoch: 'routing-1', event_count: 1 }] };
    return { rows: [] };
  };
  const relay = { connect: async () => ({ query: relayQuery, release: () => {} }),
    query: relayQuery } as unknown as Pool;
  const accessPool = { connect: async () => ({
    query: async (sql: string) => {
      if (sql.includes('FROM access.recovery_fence')) return { rows: [fence] };
      if (sql.includes('FROM access.admission')) return { rows: [access] };
      return { rows: [] };
    }, release: () => {},
  }) } as unknown as Pool;
  const r = source.envelope.data.receipt;
  const fuseki = {
    commandHealth: async () => ({ profiles: {
      'translation-link-v1': profileRegistry['translation-link-v1'].sha256 } }),
    commandWithReceipt: async (command: { update: string; validations: { binding?: Record<string, string> }[] }) => {
      commands++;
      expect(command.validations).toHaveLength(1);
      expect(command.validations[0]?.binding?.link).toBe(ids[8]);
      expect(command.update).toContain(`rv:translationStatus rv:${status === 'official' ? 'Official' : 'ThirdParty'}`);
      if (sourceRevision) {
        expect(command.update).toContain(`rv:sourceMainRevision <${sourceRevision}>`);
      } else {
        expect(command.update).toContain('rv:sourceVersionStatus rv:Unresolved');
        expect(command.update).not.toContain('rv:sourceMainRevision <');
      }
      committed = true;
      return { status: 'committed' };
    },
    query: async (sparql: string) => {
      if (sparql.includes('SELECT\n    ?outcome ?link')) return { results: { bindings: committed
        ? [{ outcome: value(`${RV}Succeeded`), link: value(ids[8]!),
          digest: value(r.requestDigest), admission: value(admissionId),
          scope: value(r.scope), authorityEpoch: value('1'), epoch: value(dataEpoch),
          sequence: value('1') }] : [] } };
      if (sparql.includes('SELECT ?cursor')) return { results: { bindings: committed
        ? [{ cursor: value('1') }] : [] } };
      if (sparql.includes('SELECT\n    ?link ?targetWork')) return { results: { bindings: committed
        ? [{ link: value(ids[8]!), targetWork: value(source.input.targetWork),
          sourceWork: value(source.input.sourceWork), sourceMain: value(source.input.sourceMainVersion),
          ...(sourceRevision ? { sourceRevision: value(sourceRevision) } : {}),
          sourceStatus: value(`${RV}${sourceRevision ? 'Exact' : 'Unresolved'}`),
          status: value(`${RV}${status === 'official' ? 'Official' : 'ThirdParty'}`),
          language: value(source.input.contentLanguage), translator: value(source.input.translator),
          publisher: value(source.input.publisher), evidence: value(source.input.evidence),
          linkedBy: value(source.input.actingSubject),
          ...(status === 'official' ? { authorizer: value(ids[7]!),
            scope: value(r.scope), epoch: value('1') } : {}) }] : [] } };
      return { boolean: committed || sparql.includes('rv:RevisionAnchor ; rv:component') };
    },
  };
  const env = ({ fuseki, lineage: { dataEpoch: restoredEpoch,
    routingEpoch: 'restored-routing' } }) as unknown as WorkActivationEnvironment;
  return { ...source, relay, accessPool, access, fence, env,
    commands: () => commands, loseEvent: () => { eventPresent = false; } };
}

test('held replay writes one exact link and a duplicate delivery reuses its receipt', async () => {
  for (const [status, sourceRevision] of [
    ['official', ids[4]], ['third-party', null],
  ] as const) {
    const fixture = mockRecovery(status, sourceRevision);
    const coverage = await relayCoverage(fixture.relay, consumer);
    const first = await reconcileRetainedTranslationLink(fixture.env, fixture.accessPool,
      fixture.relay, coverage, '1');
    expect(first).toEqual({ receipt: fixture.envelope.data.receipt.id,
      link: ids[8], replayed: false });
    expect(await reconcileRetainedTranslationLink(fixture.env, fixture.accessPool,
      fixture.relay, coverage, '1')).toEqual({ ...first, replayed: true });
    expect(fixture.commands()).toBe(1);
  }
});

test('held replay refuses missing Access authority before a graph command', async () => {
  const fixture = mockRecovery('official', ids[4]!);
  fixture.access.scope_id = 'translation:link:wrong';
  const coverage = await relayCoverage(fixture.relay, consumer);
  await expect(reconcileRetainedTranslationLink(fixture.env, fixture.accessPool,
    fixture.relay, coverage, '1')).rejects.toThrow(RetainedEffectConflict);
  expect(fixture.commands()).toBe(0);
});

test('held replay refuses an open Access recovery fence', async () => {
  const fixture = mockRecovery('third-party', null);
  fixture.fence.open = true;
  const coverage = await relayCoverage(fixture.relay, consumer);
  await expect(reconcileRetainedTranslationLink(fixture.env, fixture.accessPool,
    fixture.relay, coverage, '1')).rejects.toThrow(RetainedEffectConflict);
  expect(fixture.commands()).toBe(0);
});

test('held replay rejects a changed durable idempotency key before a graph command', async () => {
  const fixture = mockRecovery('official', ids[4]!);
  fixture.access.idempotency_key = 'different-request-key';
  const coverage = await relayCoverage(fixture.relay, consumer);
  await expect(reconcileRetainedTranslationLink(fixture.env, fixture.accessPool,
    fixture.relay, coverage, '1')).rejects.toThrow(RetainedEffectConflict);
  expect(fixture.commands()).toBe(0);
});

test('held replay refuses missing or changed retained event after coverage capture', async () => {
  const missing = mockRecovery('official', ids[4]!);
  const missingCoverage = await relayCoverage(missing.relay, consumer);
  missing.loseEvent();
  await expect(reconcileRetainedTranslationLink(missing.env, missing.accessPool,
    missing.relay, missingCoverage, '1')).rejects.toThrow();
  expect(missing.commands()).toBe(0);

  const changed = mockRecovery('third-party', null);
  const changedCoverage = await relayCoverage(changed.relay, consumer);
  changed.envelope.data.receipt.sourceVersionStatus = 'exact';
  await expect(reconcileRetainedTranslationLink(changed.env, changed.accessPool,
    changed.relay, changedCoverage, '1')).rejects.toThrow(RetainedEffectConflict);
  expect(changed.commands()).toBe(0);
});
