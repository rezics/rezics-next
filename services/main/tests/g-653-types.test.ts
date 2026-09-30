import { afterEach, expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';
import { typeRegistry, typeLocales, creatableWorkTypeOrder } from '../../../packages/model/src/generated/types.ts';
import type { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { workTypeFilters } from '../src/api-contract.ts';
import { choiceTypes, primaryType } from '../src/modules/onboarding/choices.ts';
import { discoveryType } from '../src/modules/discovery/contract.ts';
import { AdmittedTypeStore } from '../src/modules/types/store.ts';
import { pageRegistry } from '../src/modules/entity-page/read.ts';
import { readWorkKindMatches } from '../src/modules/onboarding-interests/read.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import {
  typeAdmission,
  TYPE_ADMISSION_COST,
  TYPES_READ_COST,
  type TypeDefinition,
} from '../src/modules/types/contract.ts';
import {
  admittedTypes,
  assertRegisteredTypeSnapshot,
  installRegisteredTypes,
  typeListTag,
  workTypeEntries,
  workSemanticTypeOptions,
  creatableWorkTypeOptions,
} from '../src/modules/types/registry.ts';
import {
  metadataWorkRequestDigest,
  normalizeWorkSemanticTypes,
  WORK_SEMANTIC_TYPES,
} from '../src/modules/work/activate.ts';
import { checkedWorkTypes, WORK_TYPE_OPTIONS, WORK_TYPE_OPTIONS_V1, WORK_TYPE_OPTIONS_V2 } from '../src/modules/work/type-schema.ts';
import { interestSources, matchingWorkKinds, workKinds } from '../src/modules/work/work-kinds.ts';

const webNovel = 'https://rezics.com/vocab/WebNovel';
const definition: TypeDefinition = {
  ...typeRegistry['https://schema.org/Book'],
  type: webNovel,
  creatable: true,
  default: false,
  priority: 0,
};
afterEach(() => installRegisteredTypes([]));

test('G653: admission refreshes all derived consumers in place, including compiled validators', async () => {
  const before = [
    WORK_SEMANTIC_TYPES,
    WORK_TYPE_OPTIONS,
    choiceTypes,
    workKinds,
    interestSources.books.workTypes,
    admittedTypes,
    workTypeEntries,
  ];
  const app = createMainApp(
    new FusekiClient('http://127.0.0.1:1/rezics'),
    {} as MainWorkDependencies,
  );
  const get = (tag?: string) =>
    app.handle(
      new Request('http://main.local/v1/types', { headers: tag ? { 'if-none-match': tag } : {} }),
    );
  const initial = await get();
  const tag = initial.headers.get('etag')!;
  const filter = Compile(workTypeFilters.includeTypes);
  const discovery = Compile(discoveryType);
  expect(filter.Check([webNovel])).toBe(false);
  expect(discovery.Check(webNovel)).toBe(false);
  installRegisteredTypes([{ definition, revision: '1', lifecycle: 'active' }]);
  expect(before).toEqual([
    WORK_SEMANTIC_TYPES,
    WORK_TYPE_OPTIONS,
    choiceTypes,
    workKinds,
    interestSources.books.workTypes,
    admittedTypes,
    workTypeEntries,
  ]);
  expect(WORK_SEMANTIC_TYPES).toBe(workSemanticTypeOptions);
  expect(WORK_TYPE_OPTIONS).toBe(creatableWorkTypeOptions);
  expect(filter.Check([webNovel])).toBe(true);
  expect(discovery.Check(webNovel)).toBe(true);
  expect(checkedWorkTypes([webNovel])).toEqual([webNovel]);
  expect(metadataWorkRequestDigest('Serial novel', [webNovel])).toMatch(/^[a-f0-9]{64}$/);
  expect(primaryType(['https://schema.org/Book', webNovel])).toBe(webNovel);
  expect(matchingWorkKinds([webNovel], [])).toEqual(['books']);
  expect(workKinds[webNovel].creation).toBe('contributor');
  const response = await get(tag);
  expect(response.status).toBe(200);
  expect(response.headers.get('etag')).not.toBe(tag);
  expect(((await response.json()) as { types: TypeDefinition[] }).types).toContainEqual(definition);
  expect((await get(typeListTag)).status).toBe(304);
});

test('G653: retirement blocks new use, retains historical reading and forbids conflicting combinations', () => {
  installRegisteredTypes([{ definition, revision: '1', lifecycle: 'active' }]);
  expect(() => checkedWorkTypes([webNovel, 'https://schema.org/Recipe'])).toThrow();
  expect(() => checkedWorkTypes(['urn:unadmitted:type'])).toThrow();
  installRegisteredTypes([{ definition, revision: '2', lifecycle: 'retired' }]);
  expect(admittedTypes.find((entry) => entry.type === webNovel))
    .toEqual({ ...definition, creatable: false });
  expect(pageRegistry({ base: 'work', types: [webNovel] }))
    .toEqual({ ...definition, creatable: false });
  expect(WORK_TYPE_OPTIONS).not.toContain(webNovel);
  expect(() => checkedWorkTypes([webNovel])).toThrow();
  expect(() => metadataWorkRequestDigest('New serial', [webNovel])).toThrow();
  expect(normalizeWorkSemanticTypes([webNovel], true)).toEqual([webNovel]);
  expect(workSemanticTypeOptions).toContain(webNovel);
  expect(Value.Check(discoveryType, webNovel)).toBe(true);
  expect(metadataWorkRequestDigest('New serial', [webNovel], 'en', {}, true))
    .toMatch(/^[a-f0-9]{64}$/);
});

test('G653: v1 and v2 type contracts retain the compiled list before and after admission', () => {
  const old = Compile({ type: 'string', enum: WORK_TYPE_OPTIONS_V2 });
  installRegisteredTypes([{ definition, revision: '1', lifecycle: 'active' }]);
  const newlyCompiled = Compile({ type: 'string', enum: WORK_TYPE_OPTIONS_V2 });
  expect(old.Check(webNovel)).toBe(false);
  expect(newlyCompiled.Check(webNovel)).toBe(false);
  expect(WORK_TYPE_OPTIONS_V2).toEqual([...creatableWorkTypeOrder]);
  expect(WORK_TYPE_OPTIONS_V1).toEqual(creatableWorkTypeOrder.filter(type => type !== 'https://schema.org/VideoGame'));
});

test('G653: a registry outage preserves public reads and skips health checks while writes fail closed', async () => {
  installRegisteredTypes([{ definition, revision: '1', lifecycle: 'active' }]);
  let attempts = 0;
  const types = { refresh: async () => { attempts++; throw new Error('owner held'); } };
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'),
    { types } as unknown as MainWorkDependencies);
  const send = (path: string, method = 'GET') => app.handle(new Request(`http://main.local${path}`, { method }));
  expect((await send('/health/live')).status).toBe(200);
  expect(attempts).toBe(0);
  const response = await send('/v1/types');
  expect(response.status).toBe(200);
  expect((await response.json() as { types: TypeDefinition[] }).types).toContainEqual(definition);
  expect((await send('/v1/types', 'HEAD')).status).not.toBe(503);
  expect((await send('/v1/works', 'POST')).status).toBe(503);
});

test('G653: failed refreshes retain the snapshot and bound connection retries without reopening writes', async () => {
  installRegisteredTypes([{ definition, revision: '1', lifecycle: 'active' }]);
  const tag = typeListTag;
  let attempts = 0, time = 0;
  const pool = { connect: async () => { attempts++; throw new Error('pool unavailable'); } } as unknown as Pool;
  const store = new AdmittedTypeStore(pool, () => time);
  await expect(store.refresh()).rejects.toThrow('pool unavailable');
  await expect(store.refresh()).rejects.toThrow('pool unavailable');
  expect(attempts).toBe(1);
  expect(typeListTag).toBe(tag);
  time += TYPES_READ_COST.ttlMs + 1;
  await expect(store.refresh()).rejects.toThrow('pool unavailable');
  expect(attempts).toBe(2);
});

test('G653: feed interest queries derive their type relation after registry refresh', async () => {
  const work = 'https://rezics.com/id/00000000-0000-0000-0000-000000000001';
  const session = { query: async (query: string) => query.includes(`<${webNovel}>`)
    ? [{ work: { value: work }, type: { value: webNovel } }] : [] } as unknown as WorkReadSession;
  expect((await readWorkKindMatches(session, [work])).get(work)).toEqual([]);
  installRegisteredTypes([{ definition, revision: '1', lifecycle: 'active' }]);
  expect((await readWorkKindMatches(session, [work])).get(work)).toEqual(['books']);
});

test('G653: a later compiled type remains authoritative over its admitted predecessor', () => {
  const book = typeRegistry['https://schema.org/Book'];
  installRegisteredTypes([{ definition: { ...book, priority: 0 }, revision: '2', lifecycle: 'retired' }]);
  expect(admittedTypes.filter(entry => entry.type === book.type)).toEqual([book]);
  expect(checkedWorkTypes([book.type])).toEqual([book.type]);
});

test('G653: descriptive admission requires eight locales and cannot carry structural directives', () => {
  const { default: _default, creatable: _creatable, ...metadata } = definition;
  const input = {
    profile: 'type-admission-v1',
    ...metadata,
    actingSubject: 'https://rezics.com/id/00000000-0000-0000-0000-000000000001',
    idempotencyKey: 'g653',
  };
  expect(Value.Check(typeAdmission, input)).toBe(true);
  for (const locale of typeLocales) {
    const labels = { ...input.labels };
    delete (labels as Partial<typeof labels>)[locale];
    expect(Value.Check(typeAdmission, { ...input, labels })).toBe(false);
  }
  for (const extra of [{ properties: [] }, { closed: true }, { base: 'record' }, { labels: {} }])
    expect(Value.Check(typeAdmission, { ...input, ...extra })).toBe(false);
  expect(TYPE_ADMISSION_COST.graphCalls).toBe(0);
  expect(TYPE_ADMISSION_COST.maxRows).toBe(TYPES_READ_COST.maxTypes + 1);
});

test('G653: an invalid refresh leaves the complete prior registry published', () => {
  installRegisteredTypes([{ definition, revision: '1', lifecycle: 'active' }]);
  const tag = typeListTag;
  expect(() =>
    installRegisteredTypes([{ definition, revision: '0', lifecycle: 'active' }]),
  ).toThrow();
  expect(typeListTag).toBe(tag);
  expect(checkedWorkTypes([webNovel])).toEqual([webNovel]);
});

test('G653: admission checks the entire serialized registry bound before publishing a new row', () => {
  const tag = typeListTag;
  const labels = Object.fromEntries(
    typeLocales.map((locale) => [locale, { one: '文'.repeat(64), other: '文'.repeat(64) }]),
  ) as TypeDefinition['labels'];
  const rows = Array.from(
    { length: TYPES_READ_COST.maxTypes - Object.keys(typeRegistry).length },
    (_, index) => ({
      definition: { ...definition, type: `urn:rezics:g653:large:${index}`, labels },
      revision: '1',
      lifecycle: 'active' as const,
    }),
  );
  expect(() => assertRegisteredTypeSnapshot(rows)).toThrow('byte bound');
  expect(typeListTag).toBe(tag);
  expect(admittedTypes).toHaveLength(Object.keys(typeRegistry).length);
});
