import { expect, test } from 'bun:test';
import { AdmissionDenied, type RegisteredAdmission } from '../src/modules/access/admission.ts';
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
        register: async () => registered, claim: async () => registered,
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
      register: async () => registered, claim: async () => registered, recordGraphOutcome: async () => {},
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
