import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { definitionStateRequest }
  from '../../../services/main/src/modules/context/definition-state.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';

type ContextWrite = { context: string; semanticRevision: string; replayed: boolean;
  sourcePosition: { dataEpoch: string; sequence: string } };
type StatementWrite = { statement: string; meaningKey: string; revision: string };
const short = (id: string) => id.split('/').at(-1)!;

test('CTX09: exact DefinitionRef retirement keeps older Statements readable and rejects new use', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const definition = nativeId();
    const relation = `${RV}classifiedAs`;
    await f.grant('context:create:root', 'context.create');
    const context = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target: object, relation, state: 'defined', definition, applicability: [] }],
      actingSubject: f.actorA }), 201);
    const work = await f.work('Definition retirement');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const statementBody = { profile: 'statement-v1', speaker: { kind: 'personal' },
      subject: work.mainVersion, predicate: relation, relationDefinition: nativeId(),
      value: { kind: 'resource', iri: object }, applicability: [],
      interpretation: { kind: 'explicit', context: context.context,
        semanticRevision: context.semanticRevision }, evidence: [], actingSubject: f.actorA };
    const old = await f.json<StatementWrite>(await f.call('POST', '/v1/statements', statementBody), 201);
    const body = (state: 'active' | 'retired', expectedHead: string | null) => ({
      profile: 'context-definition-state-v1', definition, state, expectedHead,
      actingSubject: f.actorA });
    const scope = definitionStateRequest(body('active', null)).scope;
    await f.revoke(await f.grant(scope, 'context.definition.state'));
    const denied = await f.call('POST', '/v1/context-definition-states', body('active', null));
    if (denied.status !== 403) console.error('definition state denial', denied.status, await denied.clone().text());
    expect(denied.status).toBe(403);
    await f.grant(scope, 'context.definition.state');
    const active = await f.json<{ revision: string; component: string }>(await f.call('POST',
      '/v1/context-definition-states', body('active', null)), 201);
    const read = (revision?: string) => f.call('GET', `/v1/context-definition-states?definition=${encodeURIComponent(definition)}`
      + (revision ? `&revision=${encodeURIComponent(revision)}` : ''));
    expect(await f.json<{ state: string; revisionState: string }>(await read(), 200))
      .toMatchObject({ state: 'active', revisionState: 'active' });
    const key = randomUUID();
    const retired = await f.json<{ revision: string; replayed: boolean;
      sourcePosition: { dataEpoch: string; sequence: string } }>(await f.call('POST',
      '/v1/context-definition-states', body('retired', active.revision), key), 201);
    expect(await f.json<typeof retired>(await f.call('POST', '/v1/context-definition-states',
      body('retired', active.revision), key), 200)).toMatchObject({ revision: retired.revision, replayed: true });
    expect(await f.json<{ state: string; revisionState: string }>(await read(active.revision), 200))
      .toMatchObject({ state: 'retired', revisionState: 'active' });
    expect(await f.json<{ state: string; revisionState: string }>(await read(), 200))
      .toMatchObject({ state: 'retired', revisionState: 'retired' });
    const batch = await readNextMainOutboxBatch(f.env.fuseki, retired.sourcePosition.dataEpoch,
      (BigInt(retired.sourcePosition.sequence) - 1n).toString());
    expect(await readMainOutboxEnvelope(f.env.fuseki, batch!, batch!.eventIds[0]!))
      .toMatchObject({ type: 'com.rezics.context.definition-state-changed.v1',
        data: { receipt: { action: 'context.definition.state', component: active.component,
          revision: retired.revision } } });
    expect((await f.json<{ meaningBasis: { state: string; interpretationDefinitions: string[] } }>(
      await f.call('GET', `/v1/statements/${short(old.statement)}`), 200)).meaningBasis)
      .toMatchObject({ state: 'readable', interpretationDefinitions: [definition] });
    expect((await f.call('POST', '/v1/statements', statementBody)).status).toBe(409);
    const realm = await f.realm('Retired definition selector');
    await f.grant(`context:select:${realm.realm}`, 'context.select');
    const selectionBody = { profile: 'context-selection-v1', scope: { kind: 'object', object },
      selection: { context: context.context, semanticRevision: context.semanticRevision },
      expectedHead: null, actingSubject: f.actorA };
    expect((await f.call('POST', `/v1/realms/${short(realm.realm)}/context-selections`,
      selectionBody)).status).toBe(409);
    expect((await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: context.context, semanticRevision: context.semanticRevision },
      expectedRevision: null })).status).toBe(409);
    expect((await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target: object, relation, state: 'defined', definition, applicability: [] }],
      actingSubject: f.actorA })).status).toBe(409);
    // A lifecycle transition copies the already pinned meaning; it is not a new adoption.
    await f.grant(`context:change:${context.context}`, 'context.state');
    const contextStatePath = `/v1/contexts/${short(context.context)}/state-transitions`;
    const contextState = (state: 'active' | 'retired', expectedSemanticHead: string) => ({
      profile: 'context-v1', expectedSemanticHead, state, actingSubject: f.actorA });
    const contextRetired = await f.json<ContextWrite>(await f.call('POST', contextStatePath,
      contextState('retired', context.semanticRevision)), 201);
    const contextRestored = await f.json<ContextWrite>(await f.call('POST', contextStatePath,
      contextState('active', contextRetired.semanticRevision)), 201);
    expect(contextRestored.semanticRevision).not.toBe(context.semanticRevision);
    expect((await f.call('POST', '/v1/context-definition-states',
      body('retired', active.revision))).status).toBe(409);
    await f.json(await f.call('POST', '/v1/context-definition-states',
      body('active', retired.revision)), 201);
    expect((await f.call('POST', `/v1/realms/${short(realm.realm)}/context-selections`,
      selectionBody)).status).toBe(201);
    expect((await f.call('POST', '/v1/statements', statementBody)).status).toBe(201);
    const relationState = (state: 'active' | 'retired', expectedHead: string | null) => ({
      profile: 'context-definition-state-v1', definition: statementBody.relationDefinition,
      state, expectedHead, actingSubject: f.actorA });
    await f.grant(definitionStateRequest(relationState('active', null)).scope, 'context.definition.state');
    const relationActive = await f.json<{ revision: string }>(await f.call('POST',
      '/v1/context-definition-states', relationState('active', null)), 201);
    await f.json(await f.call('POST', '/v1/context-definition-states',
      relationState('retired', relationActive.revision)), 201);
    expect((await f.call('POST', '/v1/statements', statementBody)).status).toBe(409);
    expect((await f.json<{ meaningKey: string }>(await f.call('GET',
      `/v1/statements/${short(old.statement)}`), 200)).meaningKey).toBe(old.meaningKey);
  } finally { await f.close(); }
}, 120_000);

test('CTX04: Global, Realm and personal exact interpretations remain independent of a narrower named target', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    const concept = async (label: string, broader?: string) => {
      const created = await f.json<{ component: string; revision: string }>(await f.call('POST',
        '/v1/semantic/changes', { profile: 'semantic-change-v1', expectedHead: null,
          state: { component: 'resource', types: ['https://schema.org/DefinedTerm'],
            properties: [
              { predicate: 'http://www.w3.org/2004/02/skos/core#prefLabel',
                value: { kind: 'language-string', lexical: label, language: 'ja' } },
              ...(broader ? [{ predicate: 'http://www.w3.org/2004/02/skos/core#broader',
                value: { kind: 'resource', ref: broader } }] : []),
            ] }, actingSubject: f.actorA }), 201);
      await f.grant(`semantic:read:${created.component}`, 'semantic.read');
      const read = await f.json<{ revision: string; state: { properties: { predicate: string }[] } }>(
        await f.call('GET', `/v1/semantic/resources/${short(created.component)}`
          + `?actingSubject=${encodeURIComponent(f.actorA)}`), 200);
      expect(read.revision).toBe(created.revision);
      expect(read.state.properties.some(property => property.predicate.endsWith('#prefLabel'))).toBe(true);
      return created.component;
    };
    const broad = await concept('後宮');
    const narrow = await concept('真後宮', broad);
    const specialist = await concept('Specialist');
    expect(new Set([broad, narrow, specialist]).size).toBe(3);
    const relation = `${RV}classifiedAs`;
    const globalDefinition = nativeId();
    const realmDefinition = nativeId();
    const personalDefinition = nativeId();
    const narrowDefinition = nativeId();
    const localNarrowDefinition = nativeId();
    const personalNarrowDefinition = nativeId();
    const specialistDefinition = nativeId();
    const entry = (target: string, definition: string) => ({ target, relation,
      state: 'defined', definition, applicability: [] });
    await f.grant('context:create:global', 'context.create');
    await f.grant('context:create:root', 'context.create');
    const create = async (role: 'global' | 'shared', entries: ReturnType<typeof entry>[]) =>
      f.json<ContextWrite>(await f.call('POST', '/v1/contexts', { profile: 'context-v1', role,
        disclosure: 'public', base: null, entries, actingSubject: f.actorA }), 201);
    const global = await create('global', [entry(broad, globalDefinition),
      entry(narrow, narrowDefinition), entry(specialist, specialistDefinition)]);
    const local = await create('shared', [entry(broad, realmDefinition),
      entry(narrow, localNarrowDefinition)]);
    const personal = await create('shared', [entry(broad, personalDefinition),
      entry(narrow, personalNarrowDefinition)]);
    const realmA = await f.realm('Local meaning');
    const realmB = await f.realm('Global meaning');
    await f.grant(`context:select:${realmA.realm}`, 'context.select');
    const selection = await f.json<{ selectionRevision: string }>(await f.call('POST',
      `/v1/realms/${short(realmA.realm)}/context-selections`, {
        profile: 'context-selection-v1', scope: { kind: 'object', object: broad },
        selection: { context: local.context, semanticRevision: local.semanticRevision },
        expectedHead: null, actingSubject: f.actorA }), 201);
    await f.json<{ revision: string }>(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object: broad },
      selection: { context: personal.context, semanticRevision: personal.semanticRevision },
      expectedRevision: null }), 201);
    const preview = async (speaker: object, object: string, explicit: object | null = null) =>
      f.json<{ state: string; basis: string; context: string; definition: string;
        semanticRevision: string; selectionRevision: string | null }>(await f.call('POST',
        '/v1/context-interpretations', { profile: 'context-interpretation-v1', speaker,
          object, relation, explicit, actingSubject: f.actorA }), 200);
    expect(await preview({ kind: 'realm', realm: realmA.realm }, broad))
      .toMatchObject({ state: 'resolved', basis: 'speaker-object', context: local.context,
        definition: realmDefinition, selectionRevision: selection.selectionRevision });
    expect(await preview({ kind: 'personal' }, broad))
      .toMatchObject({ state: 'resolved', basis: 'speaker-object', context: personal.context,
        definition: personalDefinition });
    expect(await preview({ kind: 'realm', realm: realmB.realm }, broad))
      .toMatchObject({ state: 'resolved', basis: 'global', context: global.context,
        definition: globalDefinition });
    expect(await preview({ kind: 'realm', realm: realmA.realm }, broad,
      { context: global.context, semanticRevision: global.semanticRevision }))
      .toMatchObject({ state: 'resolved', basis: 'explicit', definition: globalDefinition });
    expect(await preview({ kind: 'realm', realm: realmA.realm }, specialist))
      .toMatchObject({ state: 'resolved', basis: 'global', definition: specialistDefinition });
    expect(await preview({ kind: 'realm', realm: realmA.realm }, narrow))
      .toMatchObject({ state: 'resolved', basis: 'global', definition: narrowDefinition });
    expect(await preview({ kind: 'realm', realm: realmA.realm }, narrow,
      { context: local.context, semanticRevision: local.semanticRevision }))
      .toMatchObject({ state: 'resolved', basis: 'explicit', definition: localNarrowDefinition });
    expect(await preview({ kind: 'personal' }, narrow,
      { context: personal.context, semanticRevision: personal.semanticRevision }))
      .toMatchObject({ state: 'resolved', basis: 'explicit', definition: personalNarrowDefinition });
    const work = await f.work('Independent meanings');
    await f.grant(`statement:speak:${realmA.realm}`, 'statement.record');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const statement = (speaker: object) => ({ profile: 'statement-v1', speaker,
      subject: work.mainVersion, predicate: relation, relationDefinition: nativeId(),
      value: { kind: 'resource', iri: broad }, applicability: [],
      interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    const relationDefinition = nativeId();
    const realmStatement = await f.json<StatementWrite>(await f.call('POST', '/v1/statements', {
      ...statement({ kind: 'realm', realm: realmA.realm }), relationDefinition }), 201);
    const personalStatement = await f.json<StatementWrite>(await f.call('POST', '/v1/statements', {
      ...statement({ kind: 'personal' }), relationDefinition }), 201);
    expect(realmStatement.meaningKey).not.toBe(personalStatement.meaningKey);
    const read = async (id: string) => f.json<{ meaningKey: string; value: { iri: string };
      meaningBasis: { interpretationDefinitions: string[] } }>(await f.call('GET', `/v1/statements/${short(id)}`), 200);
    expect(await read(realmStatement.statement)).toMatchObject({ value: { iri: broad },
      meaningBasis: { interpretationDefinitions: [realmDefinition] } });
    expect(await read(personalStatement.statement)).toMatchObject({ value: { iri: broad },
      meaningBasis: { interpretationDefinitions: [personalDefinition] } });
    expect((await f.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(broad)} a rv:Sense } }`)).boolean).toBe(false);
    expect((await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(broad)} <http://www.w3.org/2002/07/owl#sameAs> ${iri(narrow)} } }`)).boolean).toBe(false);
  } finally { await f.close(); }
}, 120_000);

test('CTX09: retirement preserves exact Statement meaning and receipts, blocks new adoption, and restores by CAS', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const definition = nativeId();
    const relation = `${RV}classifiedAs`;
    const entry = { target: object, relation, state: 'defined' as const,
      definition, applicability: [] };
    await f.grant('context:create:root', 'context.create');
    const created = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [entry], actingSubject: f.actorA }), 201);
    const path = `/v1/contexts/${short(created.context)}`;
    const deniedGrant = await f.grant(`context:change:${created.context}`, 'context.state');
    await f.revoke(deniedGrant);
    const adoptedRealm = await f.realm('Retained adoption');
    await f.grant(`context:select:${adoptedRealm.realm}`, 'context.select');
    const adopted = await f.json<{ selectionRevision: string }>(await f.call('POST',
      `/v1/realms/${short(adoptedRealm.realm)}/context-selections`, {
        profile: 'context-selection-v1', scope: { kind: 'object', object },
        selection: { context: created.context, semanticRevision: created.semanticRevision },
        expectedHead: null, actingSubject: f.actorA }), 201);
    const personalKey = randomUUID();
    const personalBody = { profile: 'context-private-selection-v1',
      scope: { kind: 'object', object },
      selection: { context: created.context, semanticRevision: created.semanticRevision },
      expectedRevision: null };
    const personal = await f.json<{ revision: string }>(await f.call('PUT',
      '/v1/me/context-selections', personalBody, personalKey), 201);
    expect((await f.call('GET', `/v1/me/context-selections?kind=object&object=${encodeURIComponent(object)}`,
      undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
    const work = await f.work('Retained meaning');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const statementBody = { profile: 'statement-v1', speaker: { kind: 'personal' },
      subject: work.mainVersion, predicate: relation, relationDefinition: nativeId(),
      value: { kind: 'resource', iri: object }, applicability: [],
      interpretation: { kind: 'explicit', context: created.context,
        semanticRevision: created.semanticRevision }, evidence: [], actingSubject: f.actorA };
    const recorded = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody), 201);
    await f.globalAcceptance();
    await f.grant('classification:decide:global', 'statement.decide');
    const accepted = await f.json<{ decision: string }>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement: recorded.statement },
      acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted',
      actingSubject: f.actorA }), 201);
    const statePath = `${path}/state-transitions`;
    const retire = { profile: 'context-v1', expectedSemanticHead: created.semanticRevision,
      state: 'retired', actingSubject: f.actorA };
    expect((await f.call('POST', statePath, retire)).status).toBe(403);
    await f.grant(`context:change:${created.context}`, 'context.state');
    const retireKey = randomUUID();
    f.resetQueries();
    const retired = await f.json<ContextWrite>(await f.call('POST', statePath, retire, retireKey), 201);
    expect(f.queries()).toBeLessThanOrEqual(12);
    expect(await f.json<ContextWrite>(await f.call('POST', statePath, retire, retireKey), 200))
      .toMatchObject({ semanticRevision: retired.semanticRevision, replayed: true });
    const batch = await readNextMainOutboxBatch(f.env.fuseki, retired.sourcePosition.dataEpoch,
      (BigInt(retired.sourcePosition.sequence) - 1n).toString());
    expect(batch?.sequence).toBe(retired.sourcePosition.sequence);
    expect(await readMainOutboxEnvelope(f.env.fuseki, batch!, batch!.eventIds[0]!))
      .toMatchObject({ type: 'com.rezics.context.state-changed.v1',
        data: { receipt: { action: 'context.state', component: created.context,
          revision: retired.semanticRevision, outcome: 'succeeded' } } });
    expect((await f.json<{ state: string; entries: unknown[] }>(await f.call('GET', path), 200)))
      .toMatchObject({ state: 'retired', entries: [entry] });
    expect((await f.json<{ state: string; entries: unknown[] }>(await f.call('GET',
      `${path}?revision=${encodeURIComponent(created.semanticRevision)}`), 200)))
      .toMatchObject({ state: 'retired', entries: [entry] });
    expect(await f.json<{ revision: string; replayed: boolean }>(await f.call('PUT',
      '/v1/me/context-selections', personalBody, personalKey), 200))
      .toMatchObject({ revision: personal.revision, replayed: true });
    expect((await f.call('GET', `/v1/me/context-selections?kind=object&object=${encodeURIComponent(object)}`,
      undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
    const retainedSelection = await f.json<{ definition: string; semanticRevision: string;
      selectionRevision: string }>(await f.call('POST', '/v1/context-interpretations', {
        profile: 'context-interpretation-v1', speaker: { kind: 'realm', realm: adoptedRealm.realm },
        object, relation, explicit: null, actingSubject: f.actorA }), 200);
    expect(retainedSelection).toMatchObject({ definition, semanticRevision: created.semanticRevision,
      selectionRevision: adopted.selectionRevision });
    const statementPath = `/v1/statements/${short(recorded.statement)}`;
    const after = await f.json<{ meaningKey: string; meaningBasis: { state: string;
      semanticRevision: string; interpretationDefinitions: string[] } }>(await f.call('GET', statementPath), 200);
    expect(after).toMatchObject({ meaningKey: recorded.meaningKey,
      meaningBasis: { state: 'readable', semanticRevision: created.semanticRevision,
        interpretationDefinitions: [definition] } });
    expect((await f.json<{ result: { state: string; decision: string } }>(await f.call('POST',
      '/v1/statement-resolutions', { profile: 'statement-resolution-v1',
        target: { kind: 'statement', statement: recorded.statement },
        acceptance: { kind: 'global' } }), 200)).result)
      .toMatchObject({ state: 'accepted', decision: accepted.decision });
    const realm = await f.realm('Retired adoption');
    await f.grant(`context:select:${realm.realm}`, 'context.select');
    expect((await f.call('POST', `/v1/realms/${short(realm.realm)}/context-selections`, {
      profile: 'context-selection-v1', scope: { kind: 'object', object },
      selection: { context: created.context, semanticRevision: created.semanticRevision },
      expectedHead: null, actingSubject: f.actorA })).status).toBe(409);
    expect((await f.call('POST', '/v1/statements', statementBody)).status).toBe(409);
    expect((await f.call('POST', statePath, retire)).status).toBe(409);
    const restored = await f.json<ContextWrite>(await f.call('POST', statePath, {
      ...retire, expectedSemanticHead: retired.semanticRevision, state: 'active' }), 201);
    expect(restored.semanticRevision).not.toBe(retired.semanticRevision);
    expect((await f.call('POST', `/v1/realms/${short(realm.realm)}/context-selections`, {
      profile: 'context-selection-v1', scope: { kind: 'object', object },
      selection: { context: created.context, semanticRevision: created.semanticRevision },
      expectedHead: null, actingSubject: f.actorA })).status).toBe(201);
    expect((await f.json<{ meaningKey: string }>(await f.call('GET', statementPath), 200)).meaningKey)
      .toBe(recorded.meaningKey);
    const baseFact = await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work.mainVersion!)} <${relation}> ${iri(object)} } }`);
    expect(baseFact.boolean).toBe(false);
  } finally { await f.close(); }
}, 120_000);

test('CTX08/CTX10: concurrent reparent has one winner; pinned consumers survive bounded head changes', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const relation = `${RV}classifiedAs`;
    const definitionA = nativeId();
    const definitionB = nativeId();
    const entry = (definition: string) => ({ target: object, relation, state: 'defined',
      definition, applicability: [] });
    await f.grant('context:create:root', 'context.create');
    const create = async (base: string | null, entries: ReturnType<typeof entry>[]) =>
      f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
        profile: 'context-v1', role: 'shared', disclosure: 'public', base,
        entries, actingSubject: f.actorA }), 201);
    const parentA = await create(null, [entry(definitionA)]);
    const parentB = await create(null, [entry(definitionB)]);
    const child = await create(parentA.semanticRevision, []);
    await f.grant(`context:change:${child.context}`, 'context.change');
    await f.grant(`context:change:${parentA.context}`, 'context.change');
    const childPath = `/v1/contexts/${short(child.context)}`;
    const revise = (base: string) => ({ profile: 'context-v1', expectedSemanticHead: child.semanticRevision,
      base, entries: [], actingSubject: f.actorA });
    const race = await Promise.all([f.call('POST', `${childPath}/semantic-revisions`,
      revise(parentA.semanticRevision)), f.call('POST', `${childPath}/semantic-revisions`,
      revise(parentB.semanticRevision))]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = await f.json<ContextWrite>(race.find(response => response.status === 201)!, 201);
    const selfBase = await f.call('POST', `${childPath}/semantic-revisions`, {
      profile: 'context-v1', expectedSemanticHead: winner.semanticRevision,
      base: winner.semanticRevision, entries: [], actingSubject: f.actorA });
    expect(selfBase.status).toBe(409);
    expect((await f.json<{ base: string }>(await f.call('GET',
      `${childPath}?revision=${encodeURIComponent(child.semanticRevision)}`), 200)).base)
      .toBe(parentA.semanticRevision);
    const preview = async (revision: string) => f.json<{ state: string; definition: string;
      entryRevision: string }>(await f.call('POST', '/v1/context-interpretations', {
        profile: 'context-interpretation-v1', speaker: { kind: 'personal' }, object, relation,
        explicit: { context: child.context, semanticRevision: revision }, actingSubject: f.actorA }), 200);
    expect(await preview(child.semanticRevision)).toMatchObject({ state: 'resolved',
      definition: definitionA, entryRevision: parentA.semanticRevision });
    const expectedWinnerDefinition = (await f.json<{ base: string }>(await f.call('GET', childPath), 200))
      .base === parentB.semanticRevision ? definitionB : definitionA;
    expect(await preview(winner.semanticRevision)).toMatchObject({ state: 'resolved',
      definition: expectedWinnerDefinition });
    const work = await f.work('Pinned consumers');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const statements: StatementWrite[] = [];
    for (let index = 0; index < 12; index++) {
      statements.push(await f.json<StatementWrite>(await f.call('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.mainVersion,
        predicate: relation, relationDefinition: nativeId(), value: { kind: 'resource', iri: object },
        applicability: [], interpretation: { kind: 'explicit', context: child.context,
          semanticRevision: child.semanticRevision }, evidence: [], actingSubject: f.actorA }), 201));
    }
    const count = async () => (await f.env.fuseki.query(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT (COUNT(?statement) AS ?n) WHERE { GRAPH ${iri(GRAPHS.current)} {
        ?statement a rdf:Statement ; rdf:subject ${iri(work.mainVersion!)} . } }`))
      .results!.bindings[0]!.n!.value;
    const before = await count();
    await f.grant(`context:change:${child.context}`, 'context.preference');
    const preference = await f.json<{ preferenceRevision: string }>(await f.call('POST',
      `/v1/contexts/${short(child.context)}/preferences`, {
        profile: 'context-preference-v1', expectedPreferenceHead: null,
        labels: [{ target: object, language: 'en', label: 'Pinned view' }],
        actingSubject: f.actorA }), 201);
    expect(preference.preferenceRevision).toBeTruthy();
    const inheritedSkos = await f.json<{ '@graph': { 'skos:prefLabel': { '@value': string } }[] }>(
      await f.call('GET', `/v1/contexts/${short(child.context)}/skos`), 200);
    expect(inheritedSkos['@graph'][0]?.['skos:prefLabel']['@value']).toBe('Pinned view');
    expect((await f.json<{ semanticHead: string }>(await f.call('GET', childPath), 200)).semanticHead)
      .toBe(winner.semanticRevision);
    expect(await count()).toBe(before);
    f.resetQueries();
    const nextParent = await f.json<ContextWrite>(await f.call('POST',
      `/v1/contexts/${short(parentA.context)}/semantic-revisions`, {
        profile: 'context-v1', expectedSemanticHead: parentA.semanticRevision,
        base: null, entries: [entry(nativeId())], actingSubject: f.actorA }), 201);
    expect(f.queries()).toBeLessThanOrEqual(14);
    expect(nextParent.semanticRevision).not.toBe(parentA.semanticRevision);
    expect(await count()).toBe(before);
    expect(await preview(child.semanticRevision)).toMatchObject({ definition: definitionA,
      entryRevision: parentA.semanticRevision });
    for (const recorded of statements) {
      expect((await f.json<{ meaningKey: string }>(await f.call('GET',
        `/v1/statements/${short(recorded.statement)}`), 200)).meaningKey).toBe(recorded.meaningKey);
    }
  } finally { await f.close(); }
}, 120_000);

test('CTX05: exact relation, value and definition qualify meaning while support and decisions stay separate', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const red = nativeId();
    const redHair = nativeId();
    const hairColor = nativeId();
    const eyeColor = nativeId();
    const classifiedAs = `${RV}classifiedAs`;
    const hairDefinition = nativeId();
    const eyeDefinition = nativeId();
    const relationDefinition = nativeId();
    await f.grant('context:create:root', 'context.create');
    const contextBody = { profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target: red, relation: hairColor, state: 'defined', definition: hairDefinition,
        applicability: [] }, { target: red, relation: eyeColor, state: 'defined',
        definition: eyeDefinition, applicability: [] },
      { target: redHair, relation: hairColor, state: 'defined',
        definition: hairDefinition, applicability: [] }], actingSubject: f.actorA };
    const first = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', contextBody), 201);
    const second = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', contextBody), 201);
    const preview = await f.json<{ state: string; candidates: { relation: string; definition: string }[] }>(
      await f.call('POST', '/v1/context-interpretations', {
        profile: 'context-interpretation-v1', speaker: { kind: 'personal' },
        object: red, relation: null,
        explicit: { context: first.context, semanticRevision: first.semanticRevision },
        actingSubject: f.actorA }), 200);
    expect(preview.state).toBe('ambiguous');
    expect(preview.candidates.map(candidate => [candidate.relation, candidate.definition]))
      .toEqual([[eyeColor, eyeDefinition], [hairColor, hairDefinition]].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    const work = await f.work('Qualified red');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const record = (predicate: string, value: string, context: ContextWrite) =>
      f.call('POST', '/v1/statements', { profile: 'statement-v1', speaker: { kind: 'personal' },
        subject: work.mainVersion, predicate, relationDefinition,
        value: { kind: 'resource', iri: value }, applicability: [],
        interpretation: { kind: 'explicit', context: context.context,
          semanticRevision: context.semanticRevision }, evidence: [], actingSubject: f.actorA });
    const hairA = await f.json<StatementWrite>(await record(hairColor, red, first), 201);
    const hairB = await f.json<StatementWrite>(await record(hairColor, red, second), 201);
    const bare = await f.json<StatementWrite>(await record(classifiedAs, red, first), 201);
    const eye = await f.json<StatementWrite>(await record(eyeColor, red, first), 201);
    const named = await f.json<StatementWrite>(await record(hairColor, redHair, first), 201);
    expect(hairA.meaningKey).toBe(hairB.meaningKey);
    expect(new Set([hairA.meaningKey, bare.meaningKey, eye.meaningKey, named.meaningKey]).size).toBe(4);
    expect(hairA.statement).not.toBe(hairB.statement);
    const compare = (left: string, right: string, mapping: string | null) => f.call('POST',
      '/v1/context-meaning-comparisons', { profile: 'context-meaning-comparison-v1',
        left, right, mapping });
    expect(await f.json<{ state: string; basis: string }>(await compare(hairA.statement,
      hairB.statement, null), 200)).toMatchObject({ state: 'equivalent', basis: 'exact' });
    expect(await f.json<{ state: string }>(await compare(hairA.statement,
      named.statement, null), 200)).toMatchObject({ state: 'distinct' });
    const mappingBody = { profile: 'context-definition-equivalence-v1', context: first.context,
      semanticRevision: first.semanticRevision, relation: hairColor,
      left: { target: red, definition: hairDefinition },
      right: { target: redHair, definition: hairDefinition }, actingSubject: f.actorA };
    const grant = await f.grant(`context:change:${first.context}`, 'context.equivalence.review');
    await f.revoke(grant);
    expect((await f.call('POST', '/v1/context-definition-equivalences', mappingBody)).status).toBe(403);
    await f.grant(`context:change:${first.context}`, 'context.equivalence.review');
    const mappingKey = randomUUID();
    const reviewed = await f.json<{ mapping: string; revision: string; replayed: boolean }>(
      await f.call('POST', '/v1/context-definition-equivalences', mappingBody, mappingKey), 201);
    expect(await f.json<{ mapping: string; replayed: boolean }>(await f.call('POST',
      '/v1/context-definition-equivalences', mappingBody, mappingKey), 200))
      .toMatchObject({ mapping: reviewed.mapping, replayed: true });
    expect(await f.json<{ relation: string; semanticRevision: string }>(await f.call('GET',
      `/v1/context-definition-equivalences?mapping=${encodeURIComponent(reviewed.mapping)}`), 200))
      .toMatchObject({ relation: hairColor, semanticRevision: first.semanticRevision });
    expect(await f.json<{ state: string; basis: string }>(await compare(hairA.statement,
      named.statement, reviewed.mapping), 200)).toMatchObject({ state: 'equivalent', basis: 'reviewed-mapping' });
    for (const unrelated of [bare, eye]) {
      expect(await f.json<{ state: string }>(await compare(unrelated.statement,
        named.statement, reviewed.mapping), 200)).toMatchObject({ state: 'distinct' });
    }
    const identity = await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(red)} <http://www.w3.org/2002/07/owl#sameAs> ${iri(redHair)} } }`);
    expect(identity.boolean).toBe(false);
    await f.realm('Qualified meaning review');
    await f.globalAcceptance();
    await f.grant('classification:decide:global', 'statement.decide');
    const decide = (statement: string, outcome: 'accepted' | 'rejected') =>
      f.call('POST', '/v1/statement-decisions', { profile: 'statement-decision-v1',
        target: { kind: 'statement', statement }, acceptance: { kind: 'global' },
        expectedDecisionHead: null, outcome, actingSubject: f.actorA });
    const accepted = await f.json<{ slot: string; decision: string }>(await decide(hairA.statement, 'accepted'), 201);
    const rejected = await f.json<{ slot: string; decision: string }>(await decide(hairB.statement, 'rejected'), 201);
    expect(accepted.slot).not.toBe(rejected.slot);
    const outcomes = (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?decision ?outcome WHERE {
      GRAPH ${iri(GRAPHS.revisions)} {
        VALUES ?decision { ${iri(accepted.decision)} ${iri(rejected.decision)} }
        ?decision a rv:StatementDecision ; rv:outcome ?outcome . }
    }`)).results?.bindings ?? [];
    expect(Object.fromEntries(outcomes.map(row => [row.decision!.value, row.outcome!.value])))
      .toEqual({ [accepted.decision]: `${RV}Accepted`,
        [rejected.decision]: `${RV}Rejected` });
  } finally { await f.close(); }
}, 120_000);

test('CTX06: exact selection precedence and bounded pinned inheritance reject arbitrary mixing', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const other = nativeId();
    const relation = `${RV}classifiedAs`;
    const definitions = [nativeId(), nativeId(), nativeId(), nativeId()];
    await f.grant('context:create:root', 'context.create');
    const create = async (definition: string, target = object, base: string | null = null) =>
      f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
        profile: 'context-v1', role: 'shared', disclosure: 'public', base,
        entries: [{ target, relation: null, state: 'defined', definition, applicability: [] }],
        actingSubject: f.actorA }), 201);
    const defaultContext = await create(definitions[0]!);
    const objectContext = await create(definitions[1]!);
    const relationContext = await create(definitions[2]!);
    const explicitContext = await create(definitions[3]!);
    const realm = await f.realm('Scoped precedence');
    await f.grant(`context:select:${realm.realm}`, 'context.select');
    const select = async (scope: object, context: ContextWrite) => f.json<{ selectionRevision: string }>(
      await f.call('POST', `/v1/realms/${short(realm.realm)}/context-selections`, {
        profile: 'context-selection-v1', scope,
        selection: { context: context.context, semanticRevision: context.semanticRevision },
        expectedHead: null, actingSubject: f.actorA }), 201);
    await select({ kind: 'default' }, defaultContext);
    await select({ kind: 'object', object }, objectContext);
    await select({ kind: 'object-relation', object, relation }, relationContext);
    const preview = async (target: string, predicate: string | null, explicit: object | null = null) =>
      f.json<{ state: string; basis: string; definition: string }>(await f.call('POST',
        '/v1/context-interpretations', { profile: 'context-interpretation-v1',
          speaker: { kind: 'realm', realm: realm.realm }, object: target, relation: predicate,
          explicit, actingSubject: f.actorA }), 200);
    expect(await preview(object, relation)).toMatchObject({ state: 'resolved',
      basis: 'speaker-object-relation', definition: definitions[2] });
    expect(await preview(object, null)).toMatchObject({ state: 'resolved',
      basis: 'speaker-object', definition: definitions[1] });
    expect(await preview(other, relation)).toMatchObject({ state: 'resolved',
      basis: 'speaker-default', definition: null });
    expect(await preview(object, relation, { context: explicitContext.context,
      semanticRevision: explicitContext.semanticRevision })).toMatchObject({ state: 'resolved',
      basis: 'explicit', definition: definitions[3] });
    let base: string | null = null;
    for (let depth = 0; depth <= 8; depth++) {
      const next = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
        profile: 'context-v1', role: 'shared', disclosure: 'public', base,
        entries: [], actingSubject: f.actorA }), 201);
      base = next.semanticRevision;
    }
    expect((await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base,
      entries: [], actingSubject: f.actorA })).status).toBe(409);
  } finally { await f.close(); }
}, 120_000);

test('CTX07: independent Context labels choose scoped SKOS preferred names by language', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const target = nativeId();
    const relation = `${RV}classifiedAs`;
    const definition = nativeId();
    await f.grant('context:create:root', 'context.create');
    const create = async () => f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target, relation, state: 'defined', definition, applicability: [] }],
      actingSubject: f.actorA }), 201);
    const [a, b] = await Promise.all([create(), create()]);
    await f.grant(`context:change:${a.context}`, 'context.preference');
    await f.grant(`context:change:${b.context}`, 'context.preference');
    const path = (context: string) => `/v1/contexts/${short(context)}/preferences`;
    const body = (label: string, expectedPreferenceHead: string | null = null) => ({
      profile: 'context-preference-v1', expectedPreferenceHead,
      labels: [{ target, language: 'en', label }], actingSubject: f.actorA });
    const aKey = randomUUID();
    const aWrite = await f.json<{ preferenceRevision: string; replayed: boolean }>(
      await f.call('POST', path(a.context), body('Scarlet'), aKey), 201);
    expect(await f.json<{ preferenceRevision: string; replayed: boolean }>(
      await f.call('POST', path(a.context), body('Scarlet'), aKey), 200))
      .toMatchObject({ preferenceRevision: aWrite.preferenceRevision, replayed: true });
    const bWrite = await f.json<{ preferenceRevision: string }>(
      await f.call('POST', path(b.context), body('Red')), 201);
    expect((await f.call('POST', path(a.context), body('Crimson'))).status).toBe(409);
    expect((await f.call('POST', path(a.context), { ...body('Orphan', aWrite.preferenceRevision),
      labels: [{ target: nativeId(), language: 'en', label: 'Orphan' }] })).status).toBe(409);
    const aNext = await f.json<{ preferenceRevision: string }>(
      await f.call('POST', path(a.context), body('Crimson', aWrite.preferenceRevision)), 201);
    expect((await f.json<{ semanticHead: string }>(await f.call('GET',
      `/v1/contexts/${short(a.context)}`), 200)).semanticHead).toBe(a.semanticRevision);
    const past = await f.json<{ labels: { label: string }[] }>(await f.call('GET',
      `${path(a.context)}?revision=${encodeURIComponent(aWrite.preferenceRevision)}`), 200);
    expect(past.labels).toEqual([{ target, language: 'en', label: 'Scarlet' }]);
    const skos = async (context: string, preferenceRevision: string) =>
      f.json<{ '@context': Record<string, unknown>; '@graph': Array<Record<string, unknown>>;
        semanticRevision: string; preferenceRevision: string }>(await f.call('GET',
        `/v1/contexts/${short(context)}/skos?preferenceRevision=${encodeURIComponent(preferenceRevision)}`), 200);
    const [aSkos, bSkos] = await Promise.all([skos(a.context, aNext.preferenceRevision),
      skos(b.context, bWrite.preferenceRevision)]);
    expect(aSkos.semanticRevision).toBe(a.semanticRevision);
    expect(aSkos['@context']).toMatchObject({ skos: 'http://www.w3.org/2004/02/skos/core#', rv: RV });
    expect(aSkos['@graph']).toHaveLength(1);
    expect(aSkos['@graph'][0]!['skos:prefLabel']).toEqual({ '@value': 'Crimson', '@language': 'en' });
    expect(bSkos['@graph'][0]!['skos:prefLabel']).toEqual({ '@value': 'Red', '@language': 'en' });
    expect(aSkos['@graph'][0]!['@id']).not.toBe(bSkos['@graph'][0]!['@id']);
    expect(aSkos['@graph'][0]!['rv:interprets']).toEqual({ '@id': target });
    expect(bSkos['@graph'][0]!['rv:interprets']).toEqual({ '@id': target });
    expect((await f.call('POST', path(a.context), {
      ...body('Red'), labels: [{ target, language: 'en', label: 'Red' },
        { target, language: 'en', label: 'Crimson' }] })).status).toBe(400);
  } finally { await f.close(); }
}, 120_000);
