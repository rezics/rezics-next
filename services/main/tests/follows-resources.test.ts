import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { batchFollowCommand, followCommand, followStateQuery } from '../src/modules/follows/contract.ts';
import { resolveFollowIdentity } from '../src/modules/follows/targets.ts';
import { admittedTypes, installRegisteredTypes } from '../src/modules/types/registry.ts';
import { RV } from '../src/modules/work/activate.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const resourceType = 'http://www.w3.org/2000/01/rdf-schema#Resource';

function typedSession(types: string[]) {
  const calls: { query: string; limit: number }[] = [];
  const session = { query: async (query: string, limit: number) => {
    calls.push({ query, limit });
    return query.includes('SELECT DISTINCT ?space') ? []
      : types.map(value => ({ type: { type: 'uri', value } }));
  } } as unknown as WorkReadSession;
  return { session, calls };
}

test('every admitted descriptive resource keeps its follow kind ahead of the default Resource anchor', async () => {
  const structural = [`${RV}Agent`, `${RV}Collection`, `${RV}Realm`, `${RV}Zone`,
    'http://www.w3.org/2004/02/skos/core#Concept'];
  const types = admittedTypes.filter(entry => entry.base === 'resource' && !entry.default
    && !structural.includes(entry.type));
  expect(types.map(entry => entry.type)).toEqual(expect.arrayContaining([
    `${RV}Character`, `${RV}GameUnit`, `${RV}Title`, `${RV}NarrativeContinuity`,
  ]));
  for (const entry of types) {
    const { session, calls } = typedSession([resourceType, entry.type]);
    expect(await resolveFollowIdentity(session, target, entry.type)).toEqual({ target, kind: entry.type });
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.limit)).toEqual([2, 64]);
    await expect(resolveFollowIdentity(session, target, 'work')).rejects.toThrow('kind does not match');
  }
});

test('new admitted types gain Follow without a domain branch, including Persons', async () => {
  const character = admittedTypes.find(entry => entry.type === `${RV}Character`)!;
  const person = { ...character, type: 'https://schema.org/Person', wikiSegment: undefined };
  try {
    installRegisteredTypes([{ definition: person, revision: '1', lifecycle: 'active' }]);
    const { session } = typedSession([resourceType, person.type]);
    expect(await resolveFollowIdentity(session, target)).toEqual({ target, kind: person.type });
  } finally { installRegisteredTypes([]); }
});

test('follow state and commands derive the target kind when omitted and accept every notification level', () => {
  const state = { target, actingSubject: actor };
  expect(Value.Check(followStateQuery, state)).toBe(true);
  for (const kind of [undefined, `${RV}Character`, 'projection']) {
    expect(Value.Check(followStateQuery, { ...state, ...(kind ? { kind } : {}) })).toBe(true);
    for (const level of ['all', 'highlights', 'off']) {
      const edit = { target, ...(kind ? { kind } : {}), following: true, level, expectedRevision: null };
      expect(Value.Check(followCommand, { profile: 'follow-command-v1', actingSubject: actor, ...edit })).toBe(true);
      expect(Value.Check(batchFollowCommand, { profile: 'follow-batch-v1', actingSubject: actor, targets: [edit] })).toBe(true);
    }
  }
  expect(Value.Check(followStateQuery, { ...state, kind: '' })).toBe(false);
  expect(Value.Check(followStateQuery, { ...state, target: 'https://example.org/unadmitted' })).toBe(false);
});
