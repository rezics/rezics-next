import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import { closedStringEnum, templateParameters, templateRequest } from '../src/modules/query/template-schema.ts';
import { template } from '../src/modules/query/templates/work-credits.schema.ts';
import { CREDIT_SEEK_ROLES, creditSeekKey } from '../src/modules/query/seek-index.ts';
import { creditItem, nativeCreditRole, NATIVE_CREDIT_ROLES, WORK_CREDIT_ROLES } from '../src/modules/work/read-contract.ts';
import { nativeCreditDigest } from '../src/modules/profiles/credits.ts';

const root = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const credit = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const request = {
  profile: 'template-query-v1' as const,
  query: template.query,
  revision: 1 as const,
  parameters: { roots: [root] },
};

test('work credit roles are a closed list in public order and an unknown role is refused', () => {
  expect(closedStringEnum(template.request, 'role')).toEqual([...WORK_CREDIT_ROLES]);
  expect<string[]>(CREDIT_SEEK_ROLES.filter(role => (WORK_CREDIT_ROLES as readonly string[]).includes(role))).toEqual([...WORK_CREDIT_ROLES]);
  expect<string[]>(CREDIT_SEEK_ROLES.filter(role => role !== 'transcriber').sort()).toEqual([...NATIVE_CREDIT_ROLES].sort());
  const open = templateRequest('https://rezics.com/query/example', t.Object({
    roots: templateParameters.roots, role: t.Optional(t.String()),
  }, { additionalProperties: false }));
  expect(() => closedStringEnum(open, 'role')).toThrow('Template parameter role must be a closed list');
  expect(Value.Check(template.request, request)).toBe(true);
  for (const role of WORK_CREDIT_ROLES) {
    expect(Value.Check(template.request, { ...request, parameters: { roots: [root], role } })).toBe(true);
  }
  for (const role of ['cast', '']) {
    expect(Value.Check(template.request, { ...request, parameters: { roots: [root], role } })).toBe(false);
  }
});

test('credit seek keys rank author, director, artist and animation studio before translator and editor', () => {
  const first = 'https://rezics.com/id/00000000-0000-4000-8000-00000000000a';
  const second = 'https://rezics.com/id/00000000-0000-4000-8000-00000000000b';
  const keys = [
    creditSeekKey('author', 0, first),
    creditSeekKey('author', 2, second),
    creditSeekKey('director', 0, second),
    creditSeekKey('artist', 0, first),
    creditSeekKey('animation-studio', 0, second),
    creditSeekKey('translator', 99, first),
    creditSeekKey('editor', 0, second),
    creditSeekKey('transcriber', 0, first),
    creditSeekKey('performer', 0, first),
  ];
  expect(WORK_CREDIT_ROLES).toEqual(['author', 'director', 'artist', 'animation-studio', 'translator', 'editor', 'transcriber', 'performer']);
  expect(keys).toEqual([
    `0:000:${first}`, `0:002:${second}`, `1:000:${second}`, `2:000:${first}`,
    `3:000:${second}`, `4:099:${first}`, `5:000:${second}`, `6:000:${first}`, `7:000:${first}`,
  ]);
  expect(keys).toEqual([...keys].sort());
  expect(creditSeekKey('author', 2, first)! < creditSeekKey('author', 2, second)!).toBe(true);
  expect(creditSeekKey('cast', 0, first)).toBeNull();
  expect(creditSeekKey('author', '1000', first)).toBeNull();
  expect(creditSeekKey('author', 0, '')).toBeNull();
});

test('the Open Library credit fixture and its author evidence stay the regression guard', () => {
  const fixture = JSON.parse(readFileSync(new URL('../src/modules/query/templates/work-credits.fixture.json', import.meta.url), 'utf8')) as {
    parameters: { roots: string[]; role?: string };
    bindings: Record<string, unknown>;
    expectedIds: string[];
    dataset: string;
  };
  const sparql = readFileSync(new URL('../src/modules/query/templates/work-credits.rq', import.meta.url), 'utf8');
  expect(fixture.parameters).toEqual({ roots: ['https://rezics.com/id/ce021b81-ee0e-5b26-a868-b70d8eff7360'] });
  expect(fixture.parameters.role).toBeUndefined();
  expect(fixture.bindings).toEqual({});
  expect(fixture.expectedIds).toEqual([
    'https://rezics.com/id/8403fa5a-f1ba-5c2e-b784-dd626727f9a7',
    'https://rezics.com/id/33333333-3333-4333-8333-333333333333',
  ]);
  expect(fixture.dataset).toContain('a rv:AuthorCredit');
  expect(fixture.dataset).toContain('a rv:AuthorCreditRevision');
  expect(sparql).toContain('SELECT ?id ?key ?ordinal ?confirmation');
  expect(sparql).toContain('a rv:AuthorCreditRevision');
  expect(sparql).toContain('a rv:NativeAgentCredit');
  expect(sparql).toContain('BIND("source-reported" AS ?confirmation)');
  expect(sparql).toContain('FILTER(!BOUND(?_role) || ?_role = ?role)');
  for (const role of NATIVE_CREDIT_ROLES) expect(sparql).toContain(`"${role}"`);
  expect(sparql).not.toContain('?_kind');
});

test('a credit item accepts an Open Library author and a native animation studio, and refuses a mixed row', () => {
  const library = {
    id: credit, role: 'author', participantKind: 'external-reference', provider: 'open-library',
    key: '/authors/OL1A', ordinal: 0, agent: null, displayName: null, handle: null,
  };
  const studio = {
    id: credit, role: 'animation-studio', participantKind: 'agent', provider: null,
    key: null, ordinal: null, agent: root, displayName: null, handle: null,
  };
  expect(Value.Check(creditItem, library)).toBe(true);
  expect(Value.Check(creditItem, studio)).toBe(true);
  expect(Value.Check(creditItem, { ...studio, role: 'cast' })).toBe(false);
  expect(Value.Check(creditItem, { ...studio, participantKind: 'external-reference' })).toBe(false);
});

test('native Performer admits either exact participant alternative without inferring an Agent', () => {
  const common = { work: root, credit, role: 'performer' as const, expectedWorkHead: root, actingSubject: root };
  const external = { kind: 'external-reference' as const, provider: 'vndb', namespace: 'staff', key: 's17' };
  const agentDigest = nativeCreditDigest({ ...common, agent: root });
  const externalDigest = nativeCreditDigest({ ...common, participant: external, ordinal: 2 });
  expect(Value.Check(nativeCreditRole, 'performer')).toBe(true);
  expect(agentDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(externalDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(agentDigest).not.toBe(externalDigest);
  expect(externalDigest).not.toBe(nativeCreditDigest({ ...common, participant: { ...external, namespace: 'person' }, ordinal: 2 }));
  expect(() => nativeCreditDigest({ ...common, agent: root, participant: external })).toThrow();
  expect(Value.Check(creditItem, { id: credit, role: 'performer', participantKind: 'agent',
    provider: null, key: null, ordinal: null, agent: root, displayName: null, handle: null })).toBe(true);
  expect(Value.Check(creditItem, { id: credit, role: 'performer', participantKind: 'external-reference',
    provider: external.provider, namespace: external.namespace, key: 's17', ordinal: 2,
    agent: null, displayName: null, handle: null })).toBe(true);
});
