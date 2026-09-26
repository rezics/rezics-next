import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';

type ContextWrite = { context: string; semanticRevision: string; replayed: boolean };
type SelectionWrite = { selection: string; selectionRevision: string; replayed: boolean };
type StatementWrite = { statement: string; meaningKey: string; replayed: boolean };
type DecisionWrite = { decision: string; slot: string; replayed: boolean;
  sourcePosition: { dataEpoch: string; sequence: string } };
type Resolution = { result: { state: string; source?: string; decision?: string } };

test('CTX01/MODEL13: shared Context selection preserves distinct Realm and personal Statement meanings', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const definitionA = nativeId();
    const definitionB = nativeId();
    const relation = `${RV}classifiedAs`;
    const entry = (definition: string) => ({ target: object, relation,
      state: 'defined', definition, applicability: [] });
    await f.grant('context:create:root', 'context.create');
    const create = (definition: string) => f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [entry(definition)], actingSubject: f.actorA });
    const createdA = await create(definitionA);
    if (createdA.status !== 201) console.error('shared Context A', createdA.status, await createdA.clone().text());
    const sharedA = await f.json<ContextWrite>(createdA, 201);
    const createdB = await create(definitionB);
    if (createdB.status !== 201) console.error('shared Context B', createdB.status, await createdB.clone().text());
    const sharedB = await f.json<ContextWrite>(createdB, 201);
    const realmA = await f.realm('Context A');
    const realmB = await f.realm('Context B');
    const select = async (realm: string, context: ContextWrite) => {
      await f.grant(`context:select:${realm}`, 'context.select');
      const response = await f.call('POST',
        `/v1/realms/${realm.split('/').at(-1)}/context-selections`, {
          profile: 'context-selection-v1', scope: { kind: 'object', object },
          selection: { context: context.context, semanticRevision: context.semanticRevision },
          expectedHead: null, actingSubject: f.actorA });
      if (response.status !== 201) console.error('realm selection', response.status, await response.clone().text());
      return f.json<SelectionWrite>(response, 201);
    };
    const adoptionA = await select(realmA.realm, sharedA);
    const adoptionB = await select(realmB.realm, sharedA);
    expect(adoptionA.selection).not.toBe(adoptionB.selection);
    expect(adoptionA.selectionRevision).not.toBe(adoptionB.selectionRevision);
    const changedB = await f.json<SelectionWrite>(await f.call('POST',
      `/v1/realms/${realmB.realm.split('/').at(-1)}/context-selections`, {
        profile: 'context-selection-v1', scope: { kind: 'object', object },
        selection: { context: sharedB.context, semanticRevision: sharedB.semanticRevision },
        expectedHead: adoptionB.selectionRevision, actingSubject: f.actorA }), 201);
    expect(changedB.selection).toBe(adoptionB.selection);

    const privateFirst = await f.json<{ revision: string }>(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: sharedA.context, semanticRevision: sharedA.semanticRevision },
      expectedRevision: null }), 201);
    const privateSelectionResponse = await f.call('PUT', '/v1/me/context-selections', {
        profile: 'context-private-selection-v1', scope: { kind: 'object', object },
        selection: { context: sharedB.context, semanticRevision: sharedB.semanticRevision },
        expectedRevision: privateFirst.revision });
    if (privateSelectionResponse.status !== 201) console.error('personal selection', privateSelectionResponse.status,
      await privateSelectionResponse.clone().text());
    const privateSelection = await f.json<{ context: string; semanticRevision: string; state: string }>(
      privateSelectionResponse, 201);
    expect(privateSelection).toMatchObject({ context: sharedB.context,
      semanticRevision: sharedB.semanticRevision, state: 'selected' });
    const work = await f.work('Statement subject');
    if (!work.mainVersion) throw new Error('Work fixture failed');
    const subject = work.mainVersion;
    const relationDefinition = nativeId();
    const statementBody = (speaker: { kind: 'personal' } | { kind: 'realm'; realm: string }) => ({
      profile: 'statement-v1', speaker, subject, predicate: relation,
      relationDefinition, value: { kind: 'resource', iri: object },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    await f.grant(`statement:speak:${realmA.realm}`, 'statement.record');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const realmStatement = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody({ kind: 'realm', realm: realmA.realm })), 201);
    const personalStatement = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody({ kind: 'personal' })), 201);
    const realmRead = await f.json<{ speaker: string; meaningBasis: { state: string;
      interpretationDefinitions?: string[] }; export: Record<string, unknown> }>(await f.call('GET',
      `/v1/statements/${realmStatement.statement.split('/').at(-1)}`), 200);
    const personalRead = await f.json<typeof realmRead>(await f.call('GET',
      `/v1/statements/${personalStatement.statement.split('/').at(-1)}`), 200);
    expect(realmRead).toMatchObject({ speaker: realmA.realm,
      meaningBasis: { state: 'readable', interpretationDefinitions: [definitionA] } });
    expect(personalRead).toMatchObject({ speaker: f.actorA,
      meaningBasis: { state: 'readable', interpretationDefinitions: [definitionB] } });
    expect(realmStatement.meaningKey).not.toBe(personalStatement.meaningKey);
    expect(realmRead.export[`${RV}interpretationDefinition`]).toEqual([{ '@id': definitionA }]);
    // Identified rdf:Statement reification must not assert the unqualified base fact.
    const baseTriple = await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(subject)} <${relation}> ${iri(object)} } }`);
    expect(baseTriple.boolean).toBe(false);
  } finally { await f.close(); }
}, 120_000);

test('CTX03: hidden Context basis and explicit unresolved selection never fall back', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const relation = `${RV}classifiedAs`;
    const privateDefinition = nativeId();
    await f.grant('context:create:root', 'context.create');
    const hidden = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'private', base: null,
      entries: [{ target: object, relation, state: 'defined', definition: privateDefinition, applicability: [] }],
      actingSubject: f.actorA }), 201);
    const hiddenPath = `/v1/contexts/${hidden.context.split('/').at(-1)}`;
    expect((await f.call('GET', hiddenPath, undefined, randomUUID(), null)).status).toBe(404);
    const readGrant = await f.grant(`context:read:${hidden.context}`, 'context.read');
    expect((await f.call('GET', `${hiddenPath}?actingSubject=${encodeURIComponent(f.actorA)}`)).status).toBe(200);
    await f.json(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: hidden.context, semanticRevision: hidden.semanticRevision },
      expectedRevision: null, actingSubject: f.actorA }), 201);
    const work = await f.work('Private meaning subject');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const recorded = await f.json<StatementWrite>(await f.call('POST', '/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.mainVersion,
      predicate: relation, relationDefinition: nativeId(), value: { kind: 'resource', iri: object },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA }), 201);
    const statementPath = `/v1/statements/${recorded.statement.split('/').at(-1)}`;
    const anonymous = await f.json<{ meaningBasis: { state: string }; export: Record<string, unknown> }>(
      await f.call('GET', statementPath, undefined, randomUUID(), null), 200);
    expect(anonymous.meaningBasis).toEqual({ state: 'unavailable' });
    expect(JSON.stringify(anonymous)).not.toContain(privateDefinition);
    expect(JSON.stringify(anonymous)).not.toContain(hidden.semanticRevision);
    const authorized = await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(authorized.meaningBasis).toMatchObject({ state: 'readable',
      interpretationDefinitions: [privateDefinition] });
    await f.revoke(readGrant);
    const revoked = await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(revoked.meaningBasis).toEqual({ state: 'unavailable' });

    await f.grant('context:create:global', 'context.create');
    const global = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'global', disclosure: 'public', base: null,
      entries: [{ target: object, relation, state: 'defined', definition: nativeId(), applicability: [] }],
      actingSubject: f.actorA }), 201);
    expect(global.context).toBe('urn:rezics:semantic-context:global');
    const unresolved = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target: object, relation, state: 'unresolved', definition: null, applicability: [] }],
      actingSubject: f.actorA }), 201);
    const realm = await f.realm('Unresolved selection');
    await f.grant(`context:select:${realm.realm}`, 'context.select');
    await f.json(await f.call('POST', `/v1/realms/${realm.realm.split('/').at(-1)}/context-selections`, {
      profile: 'context-selection-v1', scope: { kind: 'object', object },
      selection: { context: unresolved.context, semanticRevision: unresolved.semanticRevision },
      expectedHead: null, actingSubject: f.actorA }), 201);
    const preview = await f.json<{ state: string; context: string }>(await f.call('POST',
      '/v1/context-interpretations', { profile: 'context-interpretation-v1',
        speaker: { kind: 'realm', realm: realm.realm }, object, relation,
        explicit: null, actingSubject: f.actorA }), 200);
    expect(preview).toMatchObject({ state: 'unresolved', context: unresolved.context });
    await f.grant(`statement:speak:${realm.realm}`, 'statement.record');
    const blocked = await f.call('POST', '/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'realm', realm: realm.realm }, subject: work.mainVersion,
      predicate: relation, relationDefinition: nativeId(), value: { kind: 'resource', iri: object },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'interpretation_unresolved',
      interpretation: { state: 'unresolved', context: unresolved.context } });
  } finally { await f.close(); }
}, 120_000);

test('CTX02/CTX03: exact Statement decisions inherit Global, suppress on local reject and fail closed', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    await f.globalAcceptance();
    const realmA = await f.realm('Decision A');
    const realmB = await f.realm('Decision B');
    const work = await f.work('Decision subject');
    if (!work.mainVersion) throw new Error('Work fixture failed');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const relationDefinition = nativeId();
    const value = nativeId();
    const statementBody = (definition: string) => ({
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.mainVersion,
      predicate: `${RV}classifiedAs`, relationDefinition: definition,
      value: { kind: 'resource', iri: value }, applicability: [],
      interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    const recorded = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody(relationDefinition)), 201);
    const changedCriterion = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody(nativeId())), 201);
    expect(changedCriterion.meaningKey).not.toBe(recorded.meaningKey);
    const target = { kind: 'statement', statement: recorded.statement };
    const acceptance = (realm?: string) => realm ? { kind: 'realm', realm } : { kind: 'global' };
    const resolve = async (realm?: string) => f.json<Resolution>(await f.call('POST',
      '/v1/statement-resolutions', { profile: 'statement-resolution-v1', target,
        acceptance: acceptance(realm) }), 200);
    const denied = await f.grant('classification:decide:global', 'statement.decide');
    await f.revoke(denied);
    const globalDecision = { profile: 'statement-decision-v1', target, acceptance: acceptance(),
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA };
    expect((await f.call('POST', '/v1/statement-decisions', globalDecision)).status).toBe(403);
    await f.grant('classification:decide:global', 'statement.decide');
    const globalKey = randomUUID();
    const accepted = await f.json<DecisionWrite>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target, acceptance: acceptance(),
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA }, globalKey), 201);
    expect(await f.json<DecisionWrite>(await f.call('POST', '/v1/statement-decisions',
      globalDecision, globalKey), 200)).toMatchObject({ decision: accepted.decision, replayed: true });
    const acceptedBatch = await readNextMainOutboxBatch(f.env.fuseki, accepted.sourcePosition.dataEpoch,
      (BigInt(accepted.sourcePosition.sequence) - 1n).toString());
    expect(acceptedBatch?.sequence).toBe(accepted.sourcePosition.sequence);
    const acceptedEvent = await readMainOutboxEnvelope(f.env.fuseki, acceptedBatch!, acceptedBatch!.eventIds[0]!);
    expect(acceptedEvent).toMatchObject({ type: 'com.rezics.statement.decision-changed.v1',
      data: { receipt: { action: 'statement.decide', outcome: 'succeeded', component: accepted.slot,
        revision: accepted.decision } } });
    expect((await resolve()).result).toMatchObject({ state: 'accepted', source: 'global',
      decision: accepted.decision });
    expect((await resolve(realmA.realm)).result).toMatchObject({ state: 'accepted',
      source: 'inherited-global', decision: accepted.decision });
    await f.grant(`classification:decide:${realmA.realm}`, 'statement.decide');
    const rejected = await f.json<DecisionWrite>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target, acceptance: acceptance(realmA.realm),
      expectedDecisionHead: null, outcome: 'rejected', actingSubject: f.actorA }), 201);
    expect((await resolve(realmA.realm)).result).toMatchObject({ state: 'rejected', source: 'local',
      decision: rejected.decision });
    expect((await resolve(realmB.realm)).result).toMatchObject({ state: 'accepted',
      source: 'inherited-global', decision: accepted.decision });
    expect((await f.json<Resolution>(await f.call('POST', '/v1/statement-resolutions', {
      profile: 'statement-resolution-v1', target: { kind: 'statement', statement: changedCriterion.statement },
      acceptance: acceptance(realmB.realm) }), 200)).result).toEqual({ state: 'absent', source: 'none' });
    expect((await resolve()).result).toMatchObject({ state: 'accepted', source: 'global' });
    for (const fault of ['missing-outcome', 'failed-read'] as const) {
      f.faultNextLocalDecisionRead(fault);
      const response = await f.call('POST', '/v1/statement-resolutions', {
        profile: 'statement-resolution-v1', target, acceptance: acceptance(realmA.realm) });
      expect(response.status).toBe(fault === 'missing-outcome' ? 200 : 503);
      const body = JSON.stringify(await response.json());
      if (fault === 'missing-outcome') expect(JSON.parse(body).result).toEqual({ state: 'unavailable' });
      expect(body).not.toContain(rejected.decision);
      expect(body).not.toContain(accepted.decision);
    }
    const stale = await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target, acceptance: acceptance(realmA.realm),
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA }, randomUUID());
    expect(stale.status).toBe(409);
    const staleBatch = await readNextMainOutboxBatch(f.env.fuseki, rejected.sourcePosition.dataEpoch,
      rejected.sourcePosition.sequence);
    const staleEvent = await readMainOutboxEnvelope(f.env.fuseki, staleBatch!, staleBatch!.eventIds[0]!);
    expect(staleEvent).toMatchObject({ type: 'com.rezics.statement.decision-stale.v1',
      data: { receipt: { action: 'statement.decide', outcome: 'cancelled', reason: 'stale-head' } } });
    const raceBody = (outcome: 'accepted' | 'withdrawn') => ({
      profile: 'statement-decision-v1', target, acceptance: acceptance(realmA.realm),
      expectedDecisionHead: rejected.decision, outcome, actingSubject: f.actorA });
    const race = await Promise.all([f.call('POST', '/v1/statement-decisions', raceBody('accepted')),
      f.call('POST', '/v1/statement-decisions', raceBody('withdrawn'))]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
  } finally { await f.close(); }
}, 120_000);
