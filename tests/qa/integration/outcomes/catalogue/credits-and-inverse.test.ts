import { afterAll, beforeAll, expect } from 'bun:test';
import credits from '../../../../../scripts/qa/cases/outcomes/catalogue/credits-and-inverse.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { allPages, assertNoLeak, assertPage, assertWitnesses, contextHarness, followLinks,
  forbidden, json, creditRoles, ordered, queryPage, queryWitnesses, realmReader, request,
  resource, witnessKey, type AssociationRequest, type AssociationWitness, type ContextHarness,
  type Page, type Snapshot, type SourcePosition } from '../../../support/context-outcomes.ts';
import type { PersonaName, PersonaSession } from '../../../support/personas.ts';

let harness: ContextHarness;
beforeAll(async () => { harness = await contextHarness(); }, 600_000);
afterAll(async () => { await harness?.close(); });

function creditPath(person: PersonaSession, work: string, frame: string[], limit: number,
  cursor?: string): string {
  const params = new URLSearchParams({ profile: 'subject-associations-v1', context: 'global',
    position: 'start', language: 'en', limit: String(limit),
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
    ...(cursor ? { cursor } : {}) });
  for (const coordinate of frame) params.append('frame', coordinate);
  return `/v1/works/${work.slice(-36)}/credits?${params}`;
}

async function genericRelations(person: PersonaSession, work: string, frame: string[], maximum: number) {
  type Relation = { relation: string; revision: string | null };
  type Relations = { profile: string; resource: string; items: Relation[];
    next: string | null; sourcePosition: SourcePosition };
  const items: Relation[] = [], cursors = new Set<string>();
  let after: string | undefined, position: SourcePosition | undefined;
  for (let index = 0; index < maximum; index++) {
    const params = new URLSearchParams({ position: 'start', languages: 'en', limit: '32',
      ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}), ...(after ? { after } : {}) });
    for (const coordinate of frame) params.append('frame', coordinate);
    const page = await json<Relations>(person.main('GET', `/v1/resources/${work.slice(-36)}/relations?${params}`));
    expect(page.profile).toBe('resource-relations-v1'); expect(page.resource).toBe(work);
    assertNoLeak(page, forbidden(harness.fixture));
    if (position) expect(page.sourcePosition).toEqual(position); else position = page.sourcePosition;
    items.push(...page.items);
    if (page.next === null) {
      expect(new Set(items.map(item => item.relation)).size).toBe(items.length);
      return items;
    }
    expect(page.next.length).toBeLessThanOrEqual(2048);
    expect(cursors.has(page.next)).toBe(false); cursors.add(page.next); after = page.next;
  }
  throw new Error('Generic relation read did not traverse the declared fixture frontier');
}

async function creditRead(persona: PersonaName): Promise<void> {
  const { fixture: f, sessions } = harness, person = sessions[persona], safe = forbidden(f);
  const forward = request(person, { kind: 'credit', roots: [resource(f.credits.work)],
    frame: f.credits.frameA }, 2);
  // C08/C09: this first 200 assertion is the baseline product assertion;
  // fixture restoration is outside test.failing in beforeAll.
  const generic = await queryWitnesses(person, forward, 32, safe);
  assertWitnesses(generic, f.credits.releaseA);
  const dedicated = await allPages(async cursor => {
    const page = await json<Page<AssociationWitness>>(person.main('GET',
      creditPath(person, f.credits.work, f.credits.frameA, 2, cursor)));
    assertPage(page, 2); return page;
  }, witnessKey, 32, safe);
  assertWitnesses(dedicated, generic);
  for (const role of creditRoles) {
    const expected = f.credits.roles[role];
    expect(generic.some(item => witnessKey(item) === witnessKey(expected)), `missing native/source credit role ${role}`).toBe(true);
    expect(dedicated.find(item => item.occurrence === expected.occurrence)?.role).toBe(expected.role);
  }
  const raw = await genericRelations(person, f.credits.work, f.credits.frameA, 32);
  for (const witness of f.credits.releaseA) {
    expect(raw.find(item => item.relation === witness.occurrence))
      .toMatchObject({ revision: witness.revision });
  }
  const onlyB = f.credits.releaseB.filter(item => !f.credits.releaseA.some(other => other.occurrence === item.occurrence));
  expect(raw.some(item => onlyB.some(other => item.relation === other.occurrence))).toBe(false);

  // The performer, character, Work and release belong to one exact occurrence.
  // A repeated performer in release B cannot supply release A's character.
  const secondRelease = await queryWitnesses(person, { ...forward, parameters: {
    ...forward.parameters, frame: f.credits.frameB } }, 32, safe);
  assertWitnesses(secondRelease, f.credits.releaseB);
  expect(f.credits.performerA.subject).toEqual(f.credits.performerB.subject);
  expect(f.credits.performerA.occurrence).not.toBe(f.credits.performerB.occurrence);
  expect(f.credits.performerA.participations).not.toEqual(f.credits.performerB.participations);
  expect(generic.find(item => item.occurrence === f.credits.performerA.occurrence)?.participations)
    .toEqual(f.credits.performerA.participations);
  expect(generic.some(item => item.occurrence === f.credits.performerB.occurrence)).toBe(false);
  expect(secondRelease.find(item => item.occurrence === f.credits.performerB.occurrence)?.participations)
    .toEqual(f.credits.performerB.participations);

  const alias = generic.find(item => item.occurrence === f.credits.externalAlias.occurrence)!;
  expect(alias).toBeDefined(); expect(alias.subject.kind).toBe('external');
  const credited = alias.participations.find(item => item.id === alias.subjectParticipation)!;
  expect(credited.creditedName).toEqual(f.credits.externalAlias.participations
    .find(item => item.id === f.credits.externalAlias.subjectParticipation)!.creditedName);
  expect(credited.sourceIdentity).toEqual(f.credits.externalAlias.participations
    .find(item => item.id === f.credits.externalAlias.subjectParticipation)!.sourceIdentity);
  expect(credited.sourceIdentity?.alias).toBeString(); expect(credited.sourceIdentity?.eid).toBeString();
  expect(credited.sourceIdentity?.note).toBeString();
  // All identifiers, credited spellings, source notes and citations above are
  // exact receipt/source expectations. No external reference becomes an Agent.
  expect(credited.participant).toEqual(f.credits.externalAlias.subject);
  expect('agent' in credited).toBe(false);

  // C15/C25: public supporting resources have native inverse reads without a
  // wiki Zone. Provider/namespace/key collisions cannot establish identity.
  for (const root of [f.inverse.character, f.inverse.person, f.inverse.external,
    f.inverse.organization, f.inverse.term]) {
    const body = request(person, { kind: root.kind, direction: 'subject-to-work', roots: [root.root] }, 64);
    const inverse = await queryWitnesses(person, body, root.publicWitnesses.length + 2, safe);
    assertWitnesses(inverse, root.publicWitnesses);
    expect(inverse.every(item => item.participations.some(part =>
      JSON.stringify(part.participant) === JSON.stringify(root.root)))).toBe(true);
  }
  const external = await queryWitnesses(person, request(person, { kind: 'credit', direction: 'subject-to-work',
    roots: [f.credits.externalAlias.subject] }), 32, safe);
  expect(external.some(item => item.occurrence === f.credits.externalAlias.occurrence)).toBe(true);
  expect(external.some(item => item.occurrence === f.credits.providerCollision.occurrence)).toBe(false);
  await followLinks(person, generic.filter(item => item.occurrence === f.credits.performerA.occurrence
    || item.occurrence === f.credits.externalAlias.occurrence));

  const localBody = request(person, { kind: 'credit', roots: [resource(f.credits.realmWitness.work)],
    context: { realm: f.privateRealm } });
  if (realmReader(persona)) {
    assertWitnesses(await queryWitnesses(person, localBody, 4, forbidden(f, true)), [f.credits.realmWitness]);
  } else {
    const denied = await json(person.main('POST', '/v1/query', localBody), 404);
    const unknown = await json(person.main('POST', '/v1/query', { ...localBody,
      parameters: { ...localBody.parameters, context: { realm: f.unknownRealm } } }), 404);
    expect(denied).toEqual(unknown); assertNoLeak(denied, safe);
  }
  const unavailable: unknown[] = [];
  for (const root of [f.privateRoot, f.unknownRoot]) {
    const missing = await json(person.main('POST', '/v1/query', request(person, {
      kind: 'credit', direction: 'subject-to-work', roots: [resource(root)] })), 404);
    assertNoLeak(missing, [...safe, f.privateRoot, f.unknownRoot]); unavailable.push(missing);
  }
  expect(unavailable[0]).toEqual(unavailable[1]);

  // C19: >800 hidden candidates precede a public tail in the command receipts.
  // Empty pages continue; every public witness and only those witnesses return.
  const sparseRoot = f.inverse.sparse;
  const sparseBody = request(person, { kind: sparseRoot.kind, direction: 'subject-to-work', roots: [sparseRoot.root] }, 2);
  const pageBudget = f.sparse.hiddenOccurrences.length + sparseRoot.publicWitnesses.length + 1;
  const sparse = await queryWitnesses(person, sparseBody, pageBudget, safe);
  assertWitnesses(sparse, sparseRoot.publicWitnesses);
  expect(sparse.some(item => item.occurrence === f.sparse.tailOccurrence)).toBe(true);
  const initial = await queryPage<AssociationWitness>(person, sparseBody);
  expect(initial.nextCursor).toBeString();
  const cursor = initial.nextCursor!;
  const bound: AssociationRequest = { ...sparseBody, cursor };
  const changed = [
    { ...bound, limit: 3 },
    { ...bound, presentation: { ...bound.presentation, language: 'zh-Hans' } },
    { ...bound, parameters: { ...bound.parameters, roots: [f.inverse.term.root] } },
    { ...bound, parameters: { ...bound.parameters, kind: bound.parameters.kind === 'credit' ? 'appearance' : 'credit' } },
    { ...bound, parameters: { ...bound.parameters, direction: 'work-to-subject' } },
    { ...bound, parameters: { ...bound.parameters, projection: 'work' } },
    { ...bound, parameters: { ...bound.parameters, position: 'all' } },
    { ...bound, parameters: { ...bound.parameters, context: { realm: f.privateRealm } } },
    { ...bound, parameters: { ...bound.parameters, frame: f.credits.frameB } },
    { ...bound, parameters: { ...bound.parameters, match: { ...bound.parameters.match, role: f.protagonistRole } } },
    { ...bound, parameters: { ...bound.parameters, match: { ...bound.parameters.match, none: [f.predicates.red] } } },
  ];
  for (const body of changed) await json(person.main('POST', '/v1/query', body), 400);
  const other = sessions[persona === 'stranger' ? 'member' : 'stranger'];
  await json(other.main('POST', '/v1/query', { ...bound, presentation: {
    ...bound.presentation, actingSubject: other.actingSubject! } }), 400);
  if (person.actingSubject) await json(person.main('POST', '/v1/query', { ...bound,
    presentation: { ...bound.presentation, actingSubject: other.actingSubject! } }), 400);
  await json(person.main('GET', creditPath(person, f.credits.work, f.credits.frameA, 2, cursor)), 400);
  const dedicatedFirst = await json<Page<AssociationWitness>>(person.main('GET',
    creditPath(person, f.credits.work, f.credits.frameA, 2)));
  expect(dedicatedFirst.nextCursor).toBeString();
  await json(person.main('POST', '/v1/query', { ...forward, cursor: dedicatedFirst.nextCursor }), 400);

  // A restore/model/source pin may become unavailable; 409 is never an empty
  // inverse. Recovery retains every selection field and clears only the pin
  // and cursor. Current Access and spoiler policy still govern exact citations.
  type Restart = { code: string; restart: { method: string; path: string; body: AssociationRequest } };
  const obsolete: Snapshot[] = [f.history.obsoleteSource, f.history.obsoleteModel, f.history.obsoleteRestore];
  for (const snapshot of obsolete) {
    const stale = await json<Restart>(person.main('POST', '/v1/query', { ...sparseBody,
      parameters: { ...sparseBody.parameters, snapshot } }), 409);
    expect(stale.code).toBe('stale_query_result');
    expect(stale.restart).toEqual({ method: 'POST', path: '/v1/query', body: sparseBody });
    assertNoLeak(stale, safe);
    const recovered = await queryPage<AssociationWitness>(person, stale.restart.body);
    expect(recovered.sourcePosition).toEqual(initial.sourcePosition);
    assertNoLeak(recovered, safe);
  }
  const history = await queryWitnesses(person, request(person, { kind: f.history.current.kind,
    roots: [resource(f.history.current.work)], position: 'all' }), 8, forbidden(f, false, true));
  const current = history.find(item => item.occurrence === f.history.current.occurrence)!;
  assertWitnesses([current], [f.history.current]);
  expect(current.citations.some(citation => citation.id === f.history.withdrawnEvidence)).toBe(false);
  expect(current.citations.some(citation => citation.id === f.history.independentEvidence)).toBe(true);
  expect(current.statements.some(statement => statement.decisionRevision === f.history.humanDecisionRevision)).toBe(true);
  const historical = history.find(item => item.occurrence === f.history.priorExact.occurrence)!;
  assertWitnesses([historical], [f.history.priorExact]);
  expect(historical.sourceVersionStatus).toBe(f.history.priorExact.sourceVersionStatus);
  expect(historical.citations).toEqual(f.history.priorExact.citations);
  expect(ordered(sparse).map(witnessKey)).toEqual(sparse.map(witnessKey));

  if (persona === 'visitor') {
    // Graph POST retains its separate bearer boundary. Public catalogue reads
    // above must not acquire a bearer or treat this refusal as missing data.
    await json(person.main('POST', '/v1/graph/queries', { profile: 'statement-graph-v1',
      actingSubject: f.personas.identities.owner.actingSubject, anchor: f.credits.work,
      direction: 'outgoing', position: 'start' }), 401);
  }
}

outcomeTest(credits, 'visitor', () => creditRead('visitor'));
outcomeTest(credits, 'stranger', () => creditRead('stranger'));
outcomeTest(credits, 'member', () => creditRead('member'));
outcomeTest(credits, 'owner', () => creditRead('owner'));
outcomeTest(credits, 'moderator', () => creditRead('moderator'));
outcomeTest(credits, 'operator', () => creditRead('operator'));
