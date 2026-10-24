import { afterAll, beforeAll, expect } from 'bun:test';
import associations from '../../../../../scripts/qa/cases/outcomes/catalogue/contextual-associations.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { allPages, appearanceCases, assertNoLeak, assertWitnesses, contextHarness, forbidden,
  json, queryPage, queryWitnesses, realmReader, request, resource, witnessKey,
  type AssociationWitness, type ContextHarness, type WorkMatch } from '../../../support/context-outcomes.ts';
import type { PersonaName } from '../../../support/personas.ts';

let harness: ContextHarness;
beforeAll(async () => { harness = await contextHarness(); }, 600_000);
afterAll(async () => { await harness?.close(); });

async function contextualRead(persona: PersonaName): Promise<void> {
  const { fixture: f, sessions } = harness, person = sessions[persona];
  const safe = forbidden(f);
  const redLead = f.cases.redLead;
  const predicate = (all = [f.predicates.red], any = [] as typeof all, none = [] as typeof all) =>
    ({ role: f.protagonistRole, all, any, none });
  const combined = request(person, { roots: [resource(redLead.work)], match: predicate() });

  // C03–C05: real positive witnesses must exist before negatives can qualify.
  // On the pristine baseline the first expected product failure is the 200
  // assertion in queryPage/json for this admitted public contextual query.
  const first = await queryWitnesses(person, combined, 4, safe);
  assertWitnesses(first, redLead.witnesses);
  expect(new Set(first.map(item => item.occurrence)).size).toBe(2);
  expect(new Set(first.flatMap(item => item.citations.map(citation => citation.id))).size).toBeGreaterThan(1);

  const workBody = { ...combined, parameters: { ...combined.parameters, projection: 'work' as const } };
  const workPage = await queryPage<WorkMatch>(person, workBody);
  expect(workPage.items.map(item => item.work)).toEqual([redLead.work]);
  expect(workPage.count.value).toBe(1);
  expect(workPage.complete).toBe(true);
  const matches = workPage.items[0]!.matches;
  expect(matches.complete).toBe(true); expect(matches.nextCursor).toBeNull();
  assertWitnesses(matches.items, redLead.witnesses);
  assertNoLeak(workPage, safe);

  for (const name of ['mixedPeople', 'mixedOccurrences'] as const) {
    const scenario = f.cases[name];
    const roots = [resource(scenario.work)];
    const inspect = await queryWitnesses(person, request(person, { roots,
      frame: scenario.selectedFrame }), 4, safe);
    expect(inspect.length, `${name}: the actual cast must be readable`).toBeGreaterThan(0);
    const filtered = await queryWitnesses(person, request(person, { roots,
      frame: scenario.selectedFrame, match: predicate() }), 4, safe);
    expect(filtered, `${name}: never join different people or appearances`).toEqual([]);
  }
  for (const name of ['otherRelease', 'otherCanon', 'otherTime'] as const) {
    const scenario = f.cases[name], roots = [resource(scenario.work)];
    expect(await queryWitnesses(person, request(person, { roots, frame: scenario.selectedFrame,
      match: predicate() }), 4, safe), `${name}: incompatible evidence cannot match`).toEqual([]);
    const ownFrame = await queryWitnesses(person, request(person, { roots, frame: scenario.evidenceFrame,
      match: predicate() }), 4, safe);
    assertWitnesses(ownFrame, scenario.witnesses);
  }

  // C07: all/any/none are executable, independent, participant-bound predicates.
  const ordinary = ['redLead', 'mixedPeople', 'explicitMale'] as const;
  const roots = ordinary.map(name => resource(f.cases[name].work));
  const workSelection = { roots, projection: 'work' as const };
  const works = async (match: typeof combined.parameters.match) => allPages(
    cursor => queryPage<WorkMatch>(person, { ...request(person, { ...workSelection, match }),
      ...(cursor ? { cursor } : {}) }), item => item.work, 4, safe);
  expect((await works(predicate())).map(item => item.work)).toEqual([redLead.work]);
  expect((await works(predicate([], [f.predicates.red, f.predicates.black]))).map(item => item.work))
    .toEqual(ordinary.map(name => f.cases[name].work).toSorted());
  expect(await works(predicate([f.predicates.red, f.predicates.black]))).toEqual([]);
  expect((await works(predicate([], [], [f.predicates.red]))).map(item => item.work))
    .toEqual([f.cases.mixedPeople.work, f.cases.explicitMale.work].toSorted());

  // Omission selects the complete isolated catalogue, not the first root page.
  const scopeRequest = request(person, { match: predicate() }, 64);
  const implicit = await queryWitnesses(person, scopeRequest, 32, safe);
  const explicit = await queryWitnesses(person, { ...scopeRequest, parameters: { ...scopeRequest.parameters,
    roots: f.catalogueWorks.map(resource) } }, 32, safe);
  assertWitnesses(implicit, explicit);
  expect(implicit.filter(item => item.work === redLead.work)).toHaveLength(2);

  for (const name of ['uncertain', 'conflicting'] as const) {
    const scenario = f.cases[name], scoped = { roots: [resource(scenario.work)], frame: scenario.selectedFrame };
    expect(await queryWitnesses(person, request(person, { ...scoped, match: predicate() }), 4, safe)).toEqual([]);
    const inspection = await queryWitnesses(person, request(person, scoped), 4, safe);
    assertWitnesses(inspection, scenario.witnesses);
    expect(inspection.flatMap(item => item.statements).some(item => item.qualification === name)).toBe(true);
  }

  // A source protagonist role is not a gender mapping. The positive control
  // has an independent adopted male Statement on this same participant.
  const genderRoots = [f.cases.sourceProtagonist.work, f.cases.explicitMale.work].map(resource);
  const genders = await queryWitnesses(person, request(person, { roots: genderRoots,
    match: { role: f.protagonistRole, all: [f.predicates.male], any: [], none: [] } }), 4, safe);
  assertWitnesses(genders, f.cases.explicitMale.witnesses);
  const sourceRole = await queryWitnesses(person, request(person, {
    roots: [resource(f.cases.sourceProtagonist.work)] }), 4, safe);
  assertWitnesses(sourceRole, f.cases.sourceProtagonist.witnesses);
  expect(sourceRole.every(item => item.role !== f.maleRole)).toBe(true);
  expect(sourceRole.flatMap(item => item.statements).some(item => item.predicate === f.predicates.male.predicate)).toBe(false);

  // Current disclosure controls the whole payload, including owner/staff
  // counts, source quotes, names, links and POST bodies embedded in links.
  for (const name of ['realmOnly', 'privateCoParticipant', 'spoiler'] as const) {
    const body = request(person, { roots: [resource(f.cases[name].work)] });
    const hidden = await queryPage<AssociationWitness>(person, body);
    expect(hidden.items).toEqual([]); expect(hidden.count.value).toBe(0);
    expect(hidden.nextCursor).toBeNull(); expect(hidden.complete).toBe(true);
    assertNoLeak(hidden, safe);
  }
  const realm = request(person, { roots: [resource(f.cases.realmOnly.work)], context: { realm: f.privateRealm } });
  if (realmReader(persona)) {
    const local = await queryWitnesses(person, realm, 4, forbidden(f, true));
    assertWitnesses(local, f.cases.realmOnly.witnesses);
  } else {
    const denied = await json(person.main('POST', '/v1/query', realm), 404);
    const unknown = await json(person.main('POST', '/v1/query', { ...realm,
      parameters: { ...realm.parameters, context: { realm: f.unknownRealm } } }), 404);
    expect(denied).toEqual(unknown); assertNoLeak(denied, safe);
  }
  const preferencesPath = person.actingSubject
    ? `/v1/me/person-preferences?actingSubject=${encodeURIComponent(person.actingSubject)}` : null;
  const before = preferencesPath ? await json(person.main('GET', preferencesPath)) : null;
  const revealed = await queryWitnesses(person, request(person, {
    roots: [resource(f.cases.spoiler.work)], position: 'all' }), 4, forbidden(f, false, true));
  assertWitnesses(revealed, f.cases.spoiler.witnesses);
  if (preferencesPath) expect(await json(person.main('GET', preferencesPath))).toEqual(before);

  // C15: one Work may have more witnesses than the per-page result bound.
  const overflowBody = request(person, { roots: [resource(f.overflow.work)], projection: 'work',
    match: predicate() }, 1);
  const overflow = await queryPage<WorkMatch>(person, overflowBody);
  expect(overflow.items.map(item => item.work)).toEqual([f.overflow.work]);
  expect(overflow.count.value).toBe(1); expect(overflow.complete).toBe(true);
  const nested = overflow.items[0]!.matches;
  expect(nested.items).toHaveLength(64); expect(nested.complete).toBe(false);
  expect(nested.nextCursor).toBeString();
  const remainder = await queryWitnesses(person, { ...overflowBody, limit: 64,
    parameters: { ...overflowBody.parameters, projection: 'occurrence' }, cursor: nested.nextCursor! }, 4, safe);
  assertWitnesses([...nested.items, ...remainder], f.overflow.witnesses);
  expect(new Set([...nested.items, ...remainder].map(witnessKey)).size).toBe(65);
  await json(person.main('POST', '/v1/query', { ...overflowBody, cursor: nested.nextCursor }), 400);

  // Shape errors cannot silently discard a filter or broaden the selected frame.
  const malformed = [
    { ...combined, limit: 0 }, { ...combined, limit: 65 },
    { ...combined, parameters: { ...combined.parameters, roots: [] } },
    { ...combined, parameters: { ...combined.parameters, roots: null } },
    { ...combined, parameters: { ...combined.parameters, context: null } },
    { ...combined, parameters: { ...combined.parameters, match: { ...predicate(), none: null } } },
    { ...combined, parameters: { ...combined.parameters, match: { ...predicate(), all: Array.from({ length: 17 }, () => f.predicates.red) } } },
    { ...combined, parameters: { ...combined.parameters, unexpected: true } },
    { ...combined, parameters: { ...combined.parameters, direction: 'subject-to-work', roots: undefined } },
  ];
  for (const body of malformed) await json(person.main('POST', '/v1/query', body), 422);
  const badFrame = f.cases.otherRelease;
  await json(person.main('POST', '/v1/query', request(person, { roots: [resource(badFrame.work)],
    frame: [...badFrame.selectedFrame, ...badFrame.evidenceFrame] })), 422);
  expect(appearanceCases.every(name => f.catalogueWorks.includes(f.cases[name].work))).toBe(true);
}

outcomeTest(associations, 'visitor', () => contextualRead('visitor'));
outcomeTest(associations, 'stranger', () => contextualRead('stranger'));
outcomeTest(associations, 'member', () => contextualRead('member'));
outcomeTest(associations, 'owner', () => contextualRead('owner'));
outcomeTest(associations, 'moderator', () => contextualRead('moderator'));
outcomeTest(associations, 'operator', () => contextualRead('operator'));
