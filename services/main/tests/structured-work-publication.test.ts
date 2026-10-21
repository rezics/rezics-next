import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { publicationRoutes } from '../src/routes/publication.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { workHeader } from '../src/modules/work/read-contract.ts';
import { readWorkBasis, readWorkHeader } from '../src/modules/work/read-header.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { readPublishedStructuredWorkSource } from '../src/modules/work/public-patterns.ts';
import { selectedPublicationAttribution } from '../src/modules/work/sourced-structure-publication.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadSession } from '../src/modules/work/read-session.ts';
import { AdmissionDenied, type GraphTerminalProof, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { receiptFamilyFor } from '../src/modules/access/receipt-families.ts';
import { ownerOutboxEventHandler } from '../src/modules/outbox/event-handlers.ts';
import { changeAdmittedWorkStructurePublication } from '../src/modules/work/structured-publication-admitted.ts';
import { type WorkStructurePublicationInput,
  type WorkStructurePublicationReceipt, checkedWorkStructurePublicationReceipt,
  verifyOriginalWorkStructureContribution, workStructurePublicationDigest, workStructurePublicationReceiptIri }
  from '../src/modules/work/structured-publication.ts';
import { RV, hash } from '../src/modules/work/activate.ts';
import { strongRevokeWorkPrincipal } from '../src/modules/work/strong-revoke.ts';
import { commandError } from '../src/routes/problems.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const workHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const mainVersion = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000005';
const structureHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000006';
const generation = 'https://rezics.com/id/00000000-0000-4000-8000-000000000007';
const decision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000008';
const admissionId = '00000000-0000-4000-8000-000000000009';
const authorityEpoch = '12';
const dataEpoch = '00000000-0000-4000-8000-000000000010';
const scope = `work:publish:${work}`;
const sourceRoot = `urn:rezics:sha256:${'a'.repeat(64)}`;

const publishInput: WorkStructurePublicationInput = {
  profile: 'work-structure-publication-v1', operation: 'publish', work, actingSubject: actor,
  expectedWorkHead: workHead, expectedMainVersion: mainVersion, structure,
  expectedStructureHead: structureHead, expectedPublicationHead: null,
  disclosure: 'public', rightsBasis: 'original-contribution',
};

function admission(input: WorkStructurePublicationInput, overrides: Partial<RegisteredAdmission> = {})
  : RegisteredAdmission {
  return { id: admissionId, principalId: actor, actingSubject: input.actingSubject,
    scope, action: input.operation === 'publish' ? 'work.publish' : 'work.withdraw-publication',
    idempotencyKey: 'publication-one', requestDigest: workStructurePublicationDigest(input),
    authorityEpoch, expiresAt: '2999-01-01T00:00:00.000Z', state: 'sealed',
    dispatchEligible: false, replayed: true, ...overrides };
}

function terminalReceipt(input: WorkStructurePublicationInput, overrides: Partial<WorkStructurePublicationReceipt>
  = {}): WorkStructurePublicationReceipt {
  const registered = admission(input);
  return { action: registered.action as WorkStructurePublicationReceipt['action'], outcome: 'succeeded',
    receipt: workStructurePublicationReceiptIri(admissionId, registered.action as 'work.publish'),
    admissionId, requestDigest: registered.requestDigest, authorityEpoch, scope, dataEpoch, sequence: '27',
    work, attestedBy: actor, mainVersion, structure, structureProfile: 'https://rezics.com/vocab/RecipeComposition',
    structureRevision: structureHead, selectedGeneration: generation, sourceRoot,
    publicationDecision: decision, predecessor: null, ...overrides };
}

function cancelledReceipt(input: WorkStructurePublicationInput, reason: WorkStructurePublicationReceipt['reason'])
  : WorkStructurePublicationReceipt {
  const registered = admission(input);
  return { action: registered.action as WorkStructurePublicationReceipt['action'], outcome: 'cancelled', reason,
    receipt: workStructurePublicationReceiptIri(admissionId, registered.action as 'work.publish'),
    admissionId, requestDigest: registered.requestDigest, authorityEpoch, scope, dataEpoch, sequence: '28',
    work, attestedBy: actor, predecessor: input.expectedPublicationHead };
}

function graphRow(receipt: WorkStructurePublicationReceipt) {
  const values: Record<string, string | undefined> = {
    outcome: receipt.outcome === 'succeeded' ? `${RV}Succeeded` : `${RV}Cancelled`,
    reason: receipt.reason ? `${RV}${receipt.reason === 'stale-head' ? 'StaleHead'
      : receipt.reason === 'source-unavailable' ? 'SourceUnavailable'
        : receipt.reason === 'rights-unavailable' ? 'RightsUnavailable'
        : receipt.reason === 'unsupported-profile' ? 'UnsupportedProfile' : 'AuthorityDenied'}` : undefined,
    action: receipt.action,
    family: receipt.action === 'work.publish' ? 'work-structure-publication-v1' : 'work-structure-withdrawal-v1',
    digest: receipt.requestDigest, id: receipt.admissionId, epoch: receipt.authorityEpoch,
    scope: receipt.scope, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence,
    work: receipt.work, attestedBy: receipt.attestedBy, main: receipt.mainVersion,
    structure: receipt.structure, profile: receipt.structureProfile, revision: receipt.structureRevision,
    generation: receipt.selectedGeneration, root: receipt.sourceRoot, decision: receipt.publicationDecision,
    predecessor: receipt.predecessor ?? undefined,
  };
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) =>
    value === undefined ? [] : [[key, { value }]]));
}

function environment(query: (text: string) => Promise<unknown>,
  commandWithReceipt: (envelope: { update: string }) => Promise<unknown> = async () => ({ status: 'committed' })) {
  return { fuseki: { query, commandWithReceipt }, lineage: { dataEpoch, routingEpoch: '4' },
    objectDirectory: '/unused' } as never;
}

test.each([
  ['rights-unavailable', 403, 'rights_denied'],
  ['authority-denied', 403, 'authority_denied'],
  ['source-unavailable', 404, 'contribution_unavailable'],
  ['unsupported-profile', 404, 'contribution_unavailable'],
  ['stale-head', 409, 'stale_head'],
] as const)('cancelled publication replay keeps the exact %s problem', async (reason, status, code) => {
  const receipt = cancelledReceipt(publishInput, reason);
  const env = environment(async query => query.includes('ASK') ? { boolean: true }
    : { results: { bindings: [graphRow(receipt)] } });
  let recorded = false;
  const response = await changeAdmittedWorkStructurePublication(env,
    { verify: async () => ({ issuer: actor, subject: actor }) }, {
      register: async () => admission(publishInput),
      claim: async () => { throw new Error('terminal replay must not claim'); },
      recordGraphOutcome: async () => { recorded = true; },
    }, new Request('https://main.invalid/v1/work-publications'),
    { ...publishInput, idempotencyKey: 'publication-one' }, async dispatch => dispatch(true))
    .then(() => { throw new Error('cancelled publication must refuse'); }, commandError);
  expect(recorded).toBe(true);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ status, code });
});

test('a publication rights refusal is stored distinctly and returns the same problem on replay', async () => {
  const input = { ...publishInput, rightsBasis: 'public-domain' as const, sourceObservation: actor };
  let stored: WorkStructurePublicationReceipt | null = null;
  const updates: string[] = [];
  const env = environment(async query => {
    if (query.includes('rv:rejectionKind rv:InvalidProfile')) return { boolean: false };
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?component ?profile')) return { results: { bindings: [{
      component: { value: mainVersion }, profile: { value: `${RV}RecipeComposition` },
      head: { value: structureHead }, generation: { value: generation },
      count: { value: '0' }, manifest: { value: sourceRoot },
    }] } };
    if (query.includes('SELECT ?owner')) return { results: { bindings: [{ owner: { value: work } }] } };
    return { results: { bindings: stored ? [graphRow(stored)] : [] } };
  }, async envelope => {
    updates.push(envelope.update);
    const reason = /rv:reason rv:(\w+)/.exec(envelope.update)?.[1];
    stored = cancelledReceipt(input, reason === 'RightsUnavailable' ? 'rights-unavailable' : 'authority-denied');
    return { status: 'committed' };
  });
  for (const replayed of [false, true]) {
    const registered = admission(input, { state: replayed ? 'sealed' : 'claimed', dispatchEligible: !replayed, replayed });
    const response = await changeAdmittedWorkStructurePublication(env,
      { verify: async () => ({ issuer: actor, subject: actor }) }, {
        register: async () => registered, claim: async () => ({ ...registered, claimedAt: '2026-10-16T00:00:00Z' }),
        recordGraphOutcome: async () => {},
      }, new Request('https://main.invalid/v1/work-publications'),
      { ...input, idempotencyKey: 'publication-one' }, async dispatch => dispatch(true))
      .then(() => { throw new Error('unproven publication rights must refuse'); }, commandError);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'rights_denied', status: 403 });
  }
  expect(updates).toHaveLength(1);
  expect(updates[0]).toContain('rv:reason rv:RightsUnavailable');
});

test('dependency preparation preserves a publication rights refusal instead of reporting a pending command', async () => {
  const registered = admission(publishInput, { state: 'claimed', dispatchEligible: true, replayed: false });
  const env = environment(async query => query.includes('ASK') ? { boolean: true } : { results: { bindings: [] } });
  const response = await changeAdmittedWorkStructurePublication(env,
    { verify: async () => ({ issuer: actor, subject: actor }) }, {
      register: async () => registered, claim: async () => ({ ...registered, claimedAt: '2026-10-16T00:00:00Z' }),
      recordGraphOutcome: async () => {},
    }, new Request('https://main.invalid/v1/work-publications'),
    { ...publishInput, idempotencyKey: 'publication-one' }, async dispatch => dispatch(true), async () => {
      checkedWorkStructurePublicationReceipt(cancelledReceipt(publishInput, 'rights-unavailable'),
        registered, publishInput, registered.requestDigest);
      throw new Error('rights refusal must throw');
    }).then(() => { throw new Error('unproven publication rights must refuse'); }, commandError);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'rights_denied', status: 403 });
});

test('WORK10/COMP08: publication intent digest binds the exact source, disclosure, rights and predecessor', () => {
  const digest = workStructurePublicationDigest(publishInput);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(workStructurePublicationDigest({ ...publishInput })).toBe(digest);
  expect(workStructurePublicationDigest({ ...publishInput, expectedPublicationHead: decision })).not.toBe(digest);
  expect(workStructurePublicationDigest({ ...publishInput, expectedStructureHead: decision })).not.toBe(digest);
  expect(workStructurePublicationDigest({ ...publishInput, expectedWorkHead: decision })).not.toBe(digest);
  expect(() => workStructurePublicationDigest({ ...publishInput,
    rightsBasis: 'imported-material' as 'original-contribution' })).toThrow('invalid structured Work publication source');
});

test('sourced publication digest requires and binds its exact observation; original requests stay source-free', () => {
  const sourced = { ...publishInput, rightsBasis: 'public-domain' as const, sourceObservation: actor };
  const digest = workStructurePublicationDigest(sourced);
  expect(digest).not.toBe(workStructurePublicationDigest(publishInput));
  expect(workStructurePublicationDigest({ ...sourced, sourceObservation: decision })).not.toBe(digest);
  expect(() => workStructurePublicationDigest({ ...sourced, sourceObservation: undefined } as never)).toThrow();
  expect(() => workStructurePublicationDigest({ ...publishInput, sourceObservation: actor } as never)).toThrow();
});

test('WORK10: publication receipt families and typed outbox handlers are owner-discovered', async () => {
  expect(receiptFamilyFor('work.publish')).toBe('work-structure-publication-v1');
  expect(receiptFamilyFor('work.withdraw-publication')).toBe('work-structure-withdrawal-v1');
  expect(receiptFamilyFor('work.publish')).not.toBe(receiptFamilyFor('work.withdraw-publication'));
  expect((await ownerOutboxEventHandler(`${RV}WorkStructurePublicationEvent`))
    ?.type).toBe('com.rezics.work.structure-publication.v1');
  expect((await ownerOutboxEventHandler(`${RV}WorkStructureWithdrawalEvent`))
    ?.type).toBe('com.rezics.work.structure-withdrawal.v1');
  expect(workStructurePublicationReceiptIri(admissionId, 'work.publish'))
    .toBe(`urn:rezics:receipt:${hash(`${admissionId}\0work-structure-publication-v1`)}`);
});

test('WORK10: a retained success replays the exact admitted source without claiming or writing again', async () => {
  const success = terminalReceipt(publishInput);
  const queries: string[] = [];
  const env = environment(async query => {
    queries.push(query);
    if (query.includes('ASK')) return { boolean: true };
    return { results: { bindings: [graphRow(success)] } };
  });
  const calls: string[] = [];
  const registered = admission(publishInput);
  const result = await changeAdmittedWorkStructurePublication(env, {
    verify: async (_request, scopes) => { calls.push(`scope:${scopes.join(',')}`); return { issuer: actor, subject: actor }; },
  }, {
    register: async request => { calls.push(`register:${request.action}:${request.scope}`); return registered; },
    claim: async () => { calls.push('claim'); throw new Error('terminal replay must not claim'); },
    recordGraphOutcome: async (_id, receipt) => { calls.push(`record:${receipt.outcome}`); },
    admittedActingSubject: async () => actor,
  }, new Request('https://main.invalid/v1/work-publications'), { ...publishInput, idempotencyKey: 'publication-one' },
  async dispatch => dispatch(true));

  expect(result).toMatchObject({ outcome: 'succeeded', replayed: true, publicationDecision: decision,
    sourceRoot, structureRevision: structureHead });
  expect(calls).toEqual(['scope:work:edit', `register:work.publish:${scope}`, 'record:succeeded']);
  expect(queries).toHaveLength(2);
});

test('WORK10: publication and withdrawal events are reconstructed from their exact terminal receipts', async () => {
  const withdrawalInput: WorkStructurePublicationInput = { profile: 'work-structure-publication-v1',
    operation: 'withdraw', work, actingSubject: actor, expectedPublicationHead: decision };
  const cases: Array<{ action: WorkStructurePublicationReceipt['action']; kind: string; eventType: string;
    receipt: WorkStructurePublicationReceipt }> = [
    { action: 'work.publish', kind: 'WorkStructurePublicationEvent',
      eventType: 'com.rezics.work.structure-publication.v1', receipt: terminalReceipt(publishInput) },
    { action: 'work.withdraw-publication', kind: 'WorkStructureWithdrawalEvent',
      eventType: 'com.rezics.work.structure-withdrawal.v1', receipt: {
        action: 'work.withdraw-publication', outcome: 'succeeded',
        receipt: workStructurePublicationReceiptIri(admissionId, 'work.withdraw-publication'),
        admissionId, requestDigest: workStructurePublicationDigest(withdrawalInput), authorityEpoch,
        scope, dataEpoch, sequence: '29', work, attestedBy: actor,
        publicationDecision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000011',
        predecessor: decision,
      } },
  ];
  for (const { action, kind, eventType, receipt } of cases) {
    const eventId = `urn:rezics:event:${hash(receipt.receipt)}`;
    const handler = (await ownerOutboxEventHandler(`${RV}${kind}`))!;
    const envelope = await handler.read({
      fuseki: { query: async (query: string) => query.includes('SELECT ?admission')
        ? { results: { bindings: [{ admission: { value: admissionId },
          ...(receipt.publicationDecision ? { eventDecision: { value: receipt.publicationDecision } } : {}),
          ...(action === 'work.withdraw-publication' ? { eventPredecessor: { value: decision } } : {}) }] } }
        : query.includes('ASK') ? { boolean: true } : { results: { bindings: [graphRow(receipt)] } },
      } as never,
      batch: { batchId: `urn:rezics:outbox:${hash(receipt.receipt)}`, dataEpoch,
        routingEpoch: '4', sequence: receipt.sequence, eventIds: [eventId] },
      eventId, ordinal: 0,
      value: name => ({ receipt: receipt.receipt, eventWork: work,
        eventPublicationDecision: receipt.publicationDecision, action }[name]),
    });
    expect(envelope.type).toBe(eventType);
    expect(envelope.data.receipt).toMatchObject({ id: receipt.receipt, action,
      outcome: 'succeeded', publicationDecision: receipt.publicationDecision });
  }
});

test('WORK10/COMP04: an Access claim denial is terminally recorded and cannot authorize publication', async () => {
  const digest = workStructurePublicationDigest(publishInput);
  const registered = admission(publishInput, { state: 'registered', dispatchEligible: true, replayed: false });
  const cancelled: WorkStructurePublicationReceipt = { action: 'work.publish', outcome: 'cancelled',
    receipt: workStructurePublicationReceiptIri(admissionId, 'work.publish'), admissionId,
    requestDigest: digest, authorityEpoch, scope, dataEpoch, sequence: '28', work, attestedBy: actor };
  let reads = 0;
  const env = environment(async query => {
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?nativeDigest')) return { results: { bindings: [] } };
    reads++;
    return { results: { bindings: reads === 1 ? [] : [graphRow(cancelled)] } };
  });
  const calls: string[] = [];

  await expect(changeAdmittedWorkStructurePublication(env, {
    verify: async (_request, scopes) => { calls.push(`scope:${scopes.join(',')}`); return { issuer: actor, subject: actor }; },
  }, {
    register: async request => { calls.push(`register:${request.action}:${request.scope}:${request.requestDigest}`); return registered; },
    claim: async () => { calls.push('claim-denied'); throw new AdmissionDenied('maintainer proof missing'); },
    recordGraphOutcome: async (_id, receipt) => { calls.push(`record:${receipt.outcome}`); },
    admittedActingSubject: async () => actor,
  }, new Request('https://main.invalid/v1/work-publications'), { ...publishInput, idempotencyKey: 'publication-one' },
  async dispatch => dispatch(true)))
    .rejects.toBeInstanceOf(AdmissionDenied);

  expect(calls).toEqual(['scope:work:edit',
    `register:work.publish:${scope}:${digest}`, 'claim-denied', 'record:cancelled']);
});

test('WORK10/COMP04: a current publication restriction seals an authority-denied receipt before source dispatch', async () => {
  const digest = workStructurePublicationDigest(publishInput);
  const registered = admission(publishInput, { state: 'registered', dispatchEligible: true, replayed: false });
  const denied: WorkStructurePublicationReceipt = { action: 'work.publish', outcome: 'cancelled',
    reason: 'authority-denied', receipt: workStructurePublicationReceiptIri(admissionId, 'work.publish'),
    admissionId, requestDigest: digest, authorityEpoch, scope, dataEpoch, sequence: '30', work, attestedBy: actor };
  let reads = 0, writes = 0;
  const env = environment(async query => {
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?nativeDigest')) return { results: { bindings: [] } };
    reads++;
    return { results: { bindings: reads === 1 ? [] : [graphRow(denied)] } };
  }, async envelope => {
    writes++;
    expect(envelope.update).toContain('rv:AuthorityDenied');
    return { status: 'committed' };
  });
  const calls: string[] = [];

  await expect(changeAdmittedWorkStructurePublication(env, {
    verify: async () => ({ issuer: actor, subject: actor }),
  }, {
    register: async () => registered,
    claim: async () => ({ ...registered, state: 'claimed', claimedAt: '2026-10-11T00:00:00.000Z' }),
    recordGraphOutcome: async () => { calls.push('recorded'); },
    admittedActingSubject: async () => actor,
  }, new Request('https://main.invalid/v1/work-publications'), { ...publishInput, idempotencyKey: 'publication-one' },
  async dispatch => dispatch(false))).rejects.toBeInstanceOf(AdmissionDenied);

  expect(reads).toBe(2);
  expect(writes).toBe(1);
  expect(calls).toEqual(['recorded']);
});

test('WORK10/COMP04: stale terminal cancellation reports stale while a revocation cancellation does not invent a predecessor', () => {
  const { publicationDecision: _decision, reason: _reason, mainVersion: _main, structure: _structure,
    structureProfile: _profile, structureRevision: _revision, selectedGeneration: _generation,
    sourceRoot: _root, ...cancelledSuccess } = terminalReceipt(publishInput);
  const stale: WorkStructurePublicationReceipt = { ...cancelledSuccess,
    outcome: 'cancelled', reason: 'stale-head' };
  expect(() => checkedWorkStructurePublicationReceipt(stale, admission(publishInput), publishInput,
    workStructurePublicationDigest(publishInput))).toThrow('Work publication head is stale');

  const republish: WorkStructurePublicationInput = { ...publishInput, expectedPublicationHead: decision };
  const { reason: _staleReason, ...revokedState } = stale;
  const revoked: WorkStructurePublicationReceipt = { ...revokedState,
    requestDigest: workStructurePublicationDigest(republish), predecessor: null };
  expect(() => checkedWorkStructurePublicationReceipt(revoked, admission(republish), republish,
    workStructurePublicationDigest(republish))).toThrow(AdmissionDenied);
});

test('WORK10: strong principal revocation settles an in-flight publication without a source', async () => {
  const registered = admission(publishInput, {
    state: 'claimed', dispatchEligible: false, replayed: false,
  });
  const cancelled: WorkStructurePublicationReceipt = {
    action: 'work.publish', outcome: 'cancelled',
    receipt: workStructurePublicationReceiptIri(admissionId, 'work.publish'),
    admissionId, requestDigest: registered.requestDigest, authorityEpoch, scope, dataEpoch,
    sequence: '31', work, attestedBy: actor,
  };
  let graphCommitted = false;
  let sealed = false;
  let commands = 0;
  const env = environment(async query => {
    if (query.includes('SELECT ?outcome')) {
      return { results: { bindings: graphCommitted ? [graphRow(cancelled)] : [] } };
    }
    throw new Error(`Unexpected publication revocation query: ${query}`);
  }, async envelope => {
    commands++;
    expect(envelope.update).toContain('rv:Cancelled');
    expect(envelope.update).not.toContain('WorkStructurePublicSource');
    graphCommitted = true;
    return { status: 'committed' };
  });
  const steps: string[] = [];
  const access = {
    strongDeactivatePrincipal: async (id: string, epoch: string) => {
      steps.push(`fence:${id}:${epoch}`);
      return { principalId: id, enforcementEpoch: '13', pending: sealed ? 0 : 1 };
    },
    listUnsealedPrincipal: async (id: string) => {
      steps.push(`pending:${id}`);
      return sealed ? [] : [registered];
    },
    recordGraphOutcome: async (id: string, receipt: WorkStructurePublicationReceipt) => {
      steps.push(`seal:${id}:${receipt.outcome}`);
      expect(receipt).toMatchObject({ outcome: 'cancelled', receipt: cancelled.receipt,
        requestDigest: registered.requestDigest, dataEpoch, sequence: '31' });
      sealed = true;
    },
  };

  const result = await strongRevokeWorkPrincipal(env as never, access as never, actor, '12');

  expect(result).toMatchObject({ status: 'complete', pending: 0, principalId: actor,
    enforcementEpoch: '13' });
  expect(commands).toBe(1);
  expect(steps).toEqual([`fence:${actor}:12`, `pending:${actor}`,
    `seal:${admissionId}:cancelled`, `fence:${actor}:13`]);
});

test('WORK10: original-contribution proof rejects imports, references, media and another editor', async () => {
  const source = { structure, revision: structureHead, generation, manifest: sourceRoot,
    placementCount: 2, actingSubject: actor };
  const responses: unknown[] = [
    { boolean: true }, { boolean: false },
    { results: { bindings: [{ admission: { value: admissionId } }] } },
  ];
  const queries: string[] = [];
  const fuseki = { query: async (query: string) => { queries.push(query); return responses.shift(); } };
  const authored = await verifyOriginalWorkStructureContribution({ fuseki } as never, source, async id => {
    expect(id).toBe(admissionId);
    return actor;
  });
  expect(authored).toBe(true);
  expect(queries[0]).toContain('rv:importSource');
  expect(queries[0]).toContain('rv:sourceKey');
  expect(queries[0]).toContain('rv:media');
  expect(queries[0]).toContain('schema:item');

  let authorQueries = 0;
  const otherEditor = await verifyOriginalWorkStructureContribution({ fuseki: { query: async (query: string) => {
    if (query.includes('ASK')) return { boolean: authorQueries++ === 0 };
    return { results: { bindings: [{ admission: { value: admissionId } }] } };
  } } } as never, source, async () => 'https://rezics.com/id/00000000-0000-4000-8000-000000000099');
  expect(otherEditor).toBe(false);
});

const manualInput = { ...publishInput, rightsBasis: 'public-domain' as const,
  rightsAssessmentId: '00000000-0000-4000-8000-000000000011',
  citation: { url: 'https://www.nhlbi.nih.gov/health/educational/lose_wt/eat/recipes.htm',
    author: 'National Heart, Lung, and Blood Institute', license: null } };
const publicationObjects: string[] = [];
afterEach(() => { for (const directory of publicationObjects.splice(0)) rmSync(directory, { recursive: true }); });

/** Owner/route fixture: graph and Rights transports are controlled, never a fabricated Source intake. */
function manualPublicationFixture() {
  const root = join(process.cwd(), '.temp/goal/manual-native-publication/objects');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'publication-'));
  publicationObjects.push(directory);
  const state = { rights: true, allowed: true, denied: false, stale: false,
    revokeBeforeCommit: false, revokeAtEmission: false, rightsReads: 0, claims: 0,
    updates: [] as string[], terminal: null as WorkStructurePublicationReceipt | null,
    attribution: null as unknown, source: '', recorded: 0, structureVisible: true, publicationMoved: false,
    invalidProfileReceipt: false, nativeProfileUnavailable: false, nativeDeadline: false,
    expiredAdmission: false, nativeInvalidProof: null as Record<string, string> | null,
    rejectNextPublication: false, duplicateNativeProof: false, recordedProofs: [] as GraphTerminalProof[] };
  const row = (values: Record<string, string>) => Object.fromEntries(Object.entries(values)
    .map(([key, value]) => [key, { value }]));
  const fuseki = {
    commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([id, value]) => [id, value.sha256])) }),
    query: async (query: string) => {
      if (query.includes('ASK')) return { boolean: query.includes('InvalidProfile')
        ? state.invalidProfileReceipt : true };
      if (query.includes('SELECT ?nativeDigest')) return { results: { bindings: state.nativeInvalidProof
        ? Array.from({ length: state.duplicateNativeProof ? 2 : 1 }, () => row(state.nativeInvalidProof!)) : [] } };
      if (query.includes('SELECT ?digest ?outcome ?kind')) return { results: { bindings: state.nativeInvalidProof
        ? [row({ digest: state.nativeInvalidProof.nativeDigest!, outcome: `${RV}Cancelled`, kind: `${RV}InvalidProfile` })] : [] } };
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return { results: { bindings: [{ ...row({
        epoch: dataEpoch, sequence: '27', r: work, type: 'work', work, head: workHead, public: 'true' }),
        label: { value: 'Native recipe', 'xml:lang': 'en' } }] } };
      if (query.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [row({ epoch: dataEpoch, sequence: '27' })] } };
      if (query.includes('SELECT ?head ?main ?mainHead')) return { results: { bindings: [row({
        head: workHead, main: mainVersion, mainHead: mainVersion, public: 'true',
        publicationHead: state.terminal!.publicationDecision! })] } };
      if (query.includes('SELECT ?resource ?head')) return { results: { bindings: [row({ resource: work, head: workHead })] } };
      if (query.includes('SELECT ?selection ?language') || query.includes('SELECT ?text WHERE'))
        return { results: { bindings: [] } };
      if (query.includes('SELECT ?work ?parent')) return { results: { bindings: [row({ work })] } };
      if (query.includes('SELECT ?outcome')) return { results: { bindings: state.terminal ? [graphRow(state.terminal)] : [] } };
      if (query.includes('SELECT DISTINCT ?parent')) return { results: { bindings: [] } };
      if (query.includes('SELECT ?component ?profile')) return { results: { bindings: [row({
        component: mainVersion, profile: `${RV}RecipeComposition`, head: state.stale ? decision : structureHead,
        generation, count: '0', manifest: sourceRoot })] } };
      if (query.includes('SELECT ?owner')) return { results: { bindings: [row({ owner: work })] } };
      if (query.includes('SELECT ?occurrence ?target ?selector')) return { results: { bindings: [] } };
      if (query.includes('SELECT ?workHead ?mainVersion')) return { results: { bindings: [row({
        workHead, mainVersion })] } };
      if (query.includes('SELECT ?structuredDecision')) return { results: { bindings: state.terminal ? [row({
        structuredDecision: state.publicationMoved ? decision : state.terminal.publicationDecision!, structuredSource: state.source,
        structuredStructure: structure, structuredSourceMain: mainVersion, structuredProfile: `${RV}RecipeComposition`,
        structuredRevision: structureHead, structuredGeneration: generation, structuredRoot: sourceRoot,
        structuredAssessment: `urn:rezics:rights:assessment:${manualInput.rightsAssessmentId}`, structuredExact: 'true',
      })] : [] } };
      if (query.includes('SELECT ?citation')) return { results: { bindings: [row({ citation: JSON.stringify(state.attribution) })] } };
      if (query.includes('SELECT ?content ?control ?value ?intent')) return { results: { bindings: [] } };
      throw new Error(`Unexpected manual publication query: ${query}`);
    },
    commandWithReceipt: async (envelope: { update: string }) => {
      state.updates.push(envelope.update);
      // The native receipt identity is immutable, including a generic rejection.
      if (state.nativeInvalidProof) return { status: 'committed' };
      if (state.rejectNextPublication && envelope.update.includes('rv:Published')) {
        state.nativeInvalidProof = nativeInvalidPublicationProof();
        state.invalidProfileReceipt = true;
        return { status: 'invalid' };
      }
      if (state.nativeProfileUnavailable) return { status: 'unknown-profile' };
      if (state.nativeDeadline) return { status: 'deadline' };
      if (envelope.update.includes('rv:Published')) {
        const decisionId = envelope.update.match(/<(https:\/\/rezics\.com\/id\/[0-9a-f-]{36})> a rv:WorkStructurePublicationDecision/)?.[1];
        state.source = envelope.update.match(/urn:rezics:work-source:[0-9a-f]{64}/)![0];
        const citation = envelope.update.match(/<https:\/\/schema.org\/citation> ("(?:[^"\\]|\\.)*") ;/)![1]!;
        state.attribution = JSON.parse(JSON.parse(citation));
        state.terminal = terminalReceipt(manualInput, { publicationDecision: decisionId });
        if (state.revokeAtEmission) state.rights = false;
      } else state.terminal = cancelledReceipt(manualInput,
        envelope.update.includes('AuthorityDenied') ? 'authority-denied' : 'stale-head');
      return { status: 'committed' };
    },
  };
  const deps = { environment: { fuseki, objectDirectory: directory, lineage: { dataEpoch, routingEpoch: '4' } },
    account: { verify: async () => ({ issuer: actor, subject: actor }) },
    access: { register: async (input: { requireExplicitGrant: boolean; scope: string; action: string; requestDigest: string }) => {
      expect(input).toMatchObject({ requireExplicitGrant: true, scope, action: 'work.publish' });
      expect(input.requestDigest).toBe(workStructurePublicationDigest(manualInput));
      if (state.denied) throw new AdmissionDenied('No Work publication grant');
      if (state.expiredAdmission) return admission(manualInput, { state: 'claimed',
        dispatchEligible: false, replayed: true, expiresAt: '2000-01-01T00:00:00.000Z' });
      return admission(manualInput, { state: state.terminal ? 'sealed' : 'registered',
        dispatchEligible: !state.terminal, replayed: !!state.terminal });
    }, claim: async () => { state.claims++; return { ...admission(manualInput,
      { state: 'claimed', dispatchEligible: true, replayed: false }), claimedAt: '2026-10-20T00:00:00Z' }; },
    recordGraphOutcome: async (_id: string, proof: GraphTerminalProof) => {
      state.recorded++; state.recordedProofs.push(proof);
    } },
    governance: { store: { withPublicationFence: async (_resources: string[],
      dispatch: (allowed: boolean) => Promise<unknown>) => dispatch(state.allowed) } },
    sourceIntake: { read: async () => { throw new Error('Manual publication must never acquire retained bytes'); } },
    rights: { store: { currentWikiDisplayObligations: async (materials: unknown[]) => materials.map(() => ({ status: 'unassessed' })),
      currentPublicDomainAssessment: async (target: string, assessment: string) => {
      expect(target).toBe(work); expect(assessment).toBe(manualInput.rightsAssessmentId);
      state.rightsReads++;
      return state.rights && !(state.revokeBeforeCommit && state.rightsReads > 1);
    } } },
  } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(deps.environment, target => target.work
    ? { resource: target.work, head: workHead, protectedRevision: target.workRevision } : undefined);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets
    .map(target => target.component === 'structure' && !state.structureVisible ? 'hidden' : 'visible')));
  const app = publicationRoutes(deps.environment.fuseki, deps);
  const post = (body: unknown = manualInput) => app.handle(new Request('https://main.invalid/v1/work-publications', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture',
      'idempotency-key': 'publication-one' }, body: JSON.stringify(body),
  }));
  return { state, deps, post };
}

test('manual cited public-domain publication binds citation and exact Rights without a retained observation', () => {
  const digest = workStructurePublicationDigest(manualInput);
  expect(workStructurePublicationDigest({ ...manualInput, citation: { license: null,
    author: manualInput.citation.author, url: manualInput.citation.url } })).toBe(digest);
  expect(workStructurePublicationDigest({ ...manualInput, rightsAssessmentId: admissionId })).not.toBe(digest);
  expect(workStructurePublicationDigest({ ...manualInput, citation: { ...manualInput.citation, author: null } })).not.toBe(digest);
  for (const invalid of [{ ...manualInput, sourceObservation: actor }, { ...manualInput, rightsAssessmentId: undefined },
    { ...manualInput, citation: undefined }, { ...manualInput, citation: { ...manualInput.citation, url: 'javascript:alert(1)' } },
    { ...manualInput, rightsBasis: 'original-contribution' }])
    expect(() => workStructurePublicationDigest(invalid as never)).toThrow();
});


test('publication returns a retained native validation rejection instead of retrying it as pending', async () => {
  const fixture = manualPublicationFixture();
  fixture.state.invalidProfileReceipt = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fixture.post();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  }
  expect(fixture.state.updates).toHaveLength(0);
  expect(fixture.state.terminal).toBeNull();
  expect(fixture.state.recorded).toBe(0);
});

function nativeInvalidPublicationProof() {
  return { nativeDigest: workStructurePublicationDigest(manualInput), nativeId: admissionId,
    nativeEpoch: authorityEpoch, nativeScope: scope, nativeDataEpoch: dataEpoch, nativeSequence: '88' };
}

test('fresh native publication validation failure seals the exact finalizer receipt before returning its rejection', async () => {
  const fixture = manualPublicationFixture();
  fixture.state.rejectNextPublication = true;
  const response = await fixture.post();
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  expect(fixture.state.claims).toBe(1);
  expect(fixture.state.updates).toHaveLength(2);
  expect(fixture.state.updates[1]).toContain('rv:rejectionKind rv:InvalidProfile');
  expect(fixture.state.terminal).toBeNull();
  expect(fixture.state.recordedProofs).toEqual([{
    receipt: workStructurePublicationReceiptIri(admissionId, 'work.publish'), outcome: 'cancelled',
    admissionId, requestDigest: workStructurePublicationDigest(manualInput), authorityEpoch,
    scope, dataEpoch, sequence: '88',
  }]);
});

test('expired publication retry seals its exact retained native cancellation without claiming or dispatching', async () => {
  const fixture = manualPublicationFixture();
  fixture.state.invalidProfileReceipt = true;
  fixture.state.expiredAdmission = true;
  fixture.state.nativeInvalidProof = nativeInvalidPublicationProof();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fixture.post();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  }
  expect(fixture.state.claims).toBe(0);
  expect(fixture.state.updates).toHaveLength(0);
  expect(fixture.state.rightsReads).toBe(0);
  expect(fixture.state.recordedProofs).toEqual(Array.from({ length: 2 }, () => ({
    receipt: workStructurePublicationReceiptIri(admissionId, 'work.publish'), outcome: 'cancelled',
    admissionId, requestDigest: workStructurePublicationDigest(manualInput), authorityEpoch,
    scope, dataEpoch, sequence: '88',
  })));
});

test.each(['nativeDigest', 'nativeId', 'nativeEpoch', 'nativeScope', 'nativeDataEpoch', 'nativeSequence',
  'duplicate'] as const)('expired native publication cancellation rejects mismatched %s proof', async field => {
  const fixture = manualPublicationFixture();
  fixture.state.invalidProfileReceipt = true;
  fixture.state.expiredAdmission = true;
  fixture.state.nativeInvalidProof = nativeInvalidPublicationProof();
  if (field === 'duplicate') fixture.state.duplicateNativeProof = true;
  else fixture.state.nativeInvalidProof[field] = 'different';
  const response = await fixture.post();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'dependency_unavailable' });
  expect(fixture.state.recorded).toBe(0);
  expect(fixture.state.claims).toBe(0);
  expect(fixture.state.updates).toHaveLength(0);
  expect(fixture.state.rightsReads).toBe(0);
});

test('publication preserves a definite missing native profile as unavailable', async () => {
  const fixture = manualPublicationFixture();
  fixture.state.nativeProfileUnavailable = true;
  const response = await fixture.post();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'dependency_unavailable' });
  expect(fixture.state.updates).toHaveLength(1);
  expect(fixture.state.terminal).toBeNull();
  expect(fixture.state.recorded).toBe(0);
});

test('publication keeps an unresolved native deadline pending until its receipt is known', async () => {
  const fixture = manualPublicationFixture();
  fixture.state.nativeDeadline = true;
  const response = await fixture.post();
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ operationId: `urn:rezics:operation:${hash(admissionId)}`, status: 'reconciling',
    phase: 'work-publication', result: null, retry: { allowed: true } });
  expect(fixture.state.updates).toHaveLength(1);
  expect(fixture.state.terminal).toBeNull();
  expect(fixture.state.recorded).toBe(0);
});

test('actual publication route commits cited native identity atomically and replays without source or Rights re-admission', async () => {
  const fixture = manualPublicationFixture();
  const response = await fixture.post();
  expect(response.status).toBe(201);
  const result = await response.json();
  expect(result).toMatchObject({ work, mainVersion, structure, structureRevision: structureHead,
    selectedGeneration: generation, sourceRoot, replayed: false });
  expect(fixture.state.rightsReads).toBe(3);
  expect(fixture.state.updates).toHaveLength(1);
  const update = fixture.state.updates[0]!;
  expect(update).toContain('rv:rightsBasis rv:PublicDomain');
  expect(update).toContain(`rv:rightsAssessment <urn:rezics:rights:assessment:${manualInput.rightsAssessmentId}>`);
  expect(update).not.toContain('rv:sourceObservation');
  expect(update).toContain(`rv:structureHead <${structureHead}>`);
  expect(update).toContain(`rv:head <${workHead}>`);
  expect(update).toContain('rv:WorkStructurePublicationEvent');
  expect(update).toContain('rv:OperationReceipt');
  expect(fixture.state.attribution).toMatchObject({ kind: 'manual-citation', ...manualInput.citation,
    rightsAssessmentId: manualInput.rightsAssessmentId, transcriber: actor });
  fixture.state.rights = false;
  const replay = await fixture.post();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...result, replayed: true });
  expect(fixture.state.rightsReads).toBe(3);
  expect(fixture.state.claims).toBe(1);
  expect(fixture.state.updates).toHaveLength(1);
});

test.each([
  { ...manualInput, citation: { ...manualInput.citation, url: 'file:///private/recipe' } },
  { ...manualInput, citation: { ...manualInput.citation, author: '' } },
  { ...manualInput, rightsAssessmentId: undefined },
  { ...manualInput, citation: undefined },
  { ...manualInput, rightsBasis: 'imported-material' },
  { ...manualInput, sourceObservation: actor },
])('actual publication route refuses an unsupported citation or Rights request before dispatch: %j', async body => {
  const fixture = manualPublicationFixture();
  const response = await fixture.post(body);
  expect([400, 422]).toContain(response.status);
  expect(fixture.state.claims).toBe(0);
  expect(fixture.state.rightsReads).toBe(0);
  expect(fixture.state.updates).toHaveLength(0);
});

test.each(['denied', 'allowed', 'stale', 'rights', 'revokeBeforeCommit'] as const)(
  'manual publication %s refusal never publishes a replacement source', async condition => {
    const fixture = manualPublicationFixture();
    if (condition === 'allowed' || condition === 'rights') fixture.state[condition] = false;
    else fixture.state[condition] = true;
    const response = await fixture.post();
    expect(response.status).toBe(condition === 'stale' ? 409 : 403);
    expect(fixture.state.updates.every(update => !update.includes('rv:WorkStructurePublicSource'))).toBe(true);
    expect(fixture.state.terminal?.outcome ?? 'cancelled').toBe('cancelled');
  });

test('manual publication refuses a Rights movement at final emission while preserving its exact committed replay', async () => {
  const fixture = manualPublicationFixture();
  fixture.state.revokeAtEmission = true;
  const response = await fixture.post();
  expect(response.status).toBe(403);
  expect(fixture.state.terminal?.outcome).toBe('succeeded');
  const replay = await fixture.post();
  expect(replay.status).toBe(200);
  expect((await replay.json()).replayed).toBe(true);
  expect(fixture.state.updates).toHaveLength(1);
});

test('selected manual publication reader emits truthful attribution at its exact revision and fences current Rights', async () => {
  const fixture = manualPublicationFixture();
  expect((await fixture.post()).status).toBe(201);
  const source = await readPublishedStructuredWorkSource(fixture.deps.environment, work, mainVersion);
  expect(source).toMatchObject({ work, mainVersion, structure, structureRevision: structureHead,
    selectedGeneration: generation, sourceRoot, rightsAssessmentId: manualInput.rightsAssessmentId });
  expect(source).not.toHaveProperty('sourceObservation');
  const session = new WorkReadSession(fixture.deps, new Request(`https://main.invalid/v1/works/${work.slice(-36)}`),
    {}, { dataEpoch, sequence: '27' });
  const attribution = await selectedPublicationAttribution(session, source);
  expect(attribution).toMatchObject({ kind: 'manual-citation', ...manualInput.citation });
  for (const key of ['record', 'observation', 'provider', 'externalId']) expect(attribution).not.toHaveProperty(key);
  expect(Value.Check(workHeader.properties.rights, { basis: 'public-domain', source: attribution })).toBe(true);
  await session.fenceDependencies();
  fixture.state.rights = false;
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  const next = new WorkReadSession(fixture.deps, session.request, {}, { dataEpoch, sequence: '27' });
  await expect(selectedPublicationAttribution(next, source)).rejects.toBeInstanceOf(WorkReadMissing);
});

test.each(['rights', 'disclosure', 'publication'] as const)(
  'native Work header retains exact manual attribution and refuses final %s movement', async movement => {
    const fixture = manualPublicationFixture();
    expect((await fixture.post()).status).toBe(201);
    const session = new WorkReadSession(fixture.deps, new Request(`https://main.invalid/v1/works/${work.slice(-36)}`),
      { localBasis: true }, { dataEpoch, sequence: '27' });
    const header = await readWorkHeader(session, work);
    expect(header).toMatchObject({ id: work, mainVersion, publicationState: 'published',
      rights: { basis: 'public-domain', source: { kind: 'manual-citation', ...manualInput.citation,
        rightsAssessmentId: manualInput.rightsAssessmentId } } });
    expect(Value.Check(workHeader, header)).toBe(true);
    await session.fenceDependencies();
    if (movement === 'rights') fixture.state.rights = false;
    if (movement === 'disclosure') fixture.state.structureVisible = false;
    if (movement === 'publication') fixture.state.publicationMoved = true;
    await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  });

test.each(['admission', 'final'] as const)(
  'native readers without an attribution output must retain manual publication Rights at %s', async phase => {
    const fixture = manualPublicationFixture();
    expect((await fixture.post()).status).toBe(201);
    const session = new WorkReadSession(fixture.deps, new Request(`https://main.invalid/v1/works/${work.slice(-36)}/recipe`),
      { localBasis: true }, { dataEpoch, sequence: '27' });
    if (phase === 'admission') {
      fixture.state.rights = false;
      await expect(readWorkBasis(session, work)).rejects.toBeInstanceOf(WorkReadMissing);
    } else {
      expect((await readWorkBasis(session, work)).structuredPublication?.rightsAssessmentId)
        .toBe(manualInput.rightsAssessmentId);
      await session.fenceDependencies();
      fixture.state.rights = false;
      await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
    }
  });
