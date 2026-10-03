import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { typesV1 } from '../../../model/definitions/types-v1.ts';
import { workKindV2Profile } from '../../../model/definitions/work-kind-v2.ts';
import { workTypeV2Profile } from '../../../model/definitions/work-type-v2.ts';
import {
  compileTypes,
  renderTypeRegistry,
  type TypeRegistryDefinition,
} from '../../../model/compiler/type.ts';
import { typeLocales } from '../../../packages/model/src/generated/types.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  TYPES_READ_COST,
  typeAdmission,
  typeList,
  type TypeDefinition,
} from '../src/modules/types/contract.ts';
import { assertRegisteredTypeSnapshot } from '../src/modules/types/registry.ts';

const expected = [
  ['works', 'https://schema.org/CreativeWork'],
  ['communities', 'https://rezics.com/vocab/Realm'],
  ['sites', 'https://rezics.com/vocab/Zone'],
  ['people', 'https://rezics.com/vocab/Agent'],
  ['lists', 'https://rezics.com/vocab/Collection'],
  ['topics', 'http://www.w3.org/2004/02/skos/core#Concept'],
];
const compile = (definition: TypeRegistryDefinition = typesV1) =>
  compileTypes(definition, workKindV2Profile, workTypeV2Profile);

test('G-979: public registry serves structural browse categories and eight localized labels within its existing read budget', async () => {
  const app = createMainApp(
    new FusekiClient('http://127.0.0.1:1/rezics'),
    {} as MainWorkDependencies,
  );
  const get = (headers: Record<string, string> = {}) =>
    app.handle(new Request('http://main.local/v1/types', { headers }));
  const response = await get();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    profile: string;
    digest: string;
    types: TypeDefinition[];
  };
  expect(Value.Check(typeList, body)).toBe(true);
  const entries = body.types
    .filter((entry) => entry.browse)
    .sort((a, b) => a.browse!.order - b.browse!.order);
  expect(entries.map((entry) => [entry.browse!.id, entry.type])).toEqual(expected);
  for (const entry of entries) {
    for (const locale of typeLocales) expect(entry.browse!.labels[locale].trim()).not.toBe('');
    if (entry.base === 'resource') {
      expect(entry.creatable).toBe(false);
      expect(entry.default).toBe(false);
    }
  }
  // Work subtypes keep their original labels and admission; they are not extra browse tabs.
  expect(
    body.types
      .filter((entry) => entry.base === 'work' && !entry.default)
      .every((entry) => !entry.browse),
  ).toBe(true);
  expect(body.types.length).toBeLessThanOrEqual(TYPES_READ_COST.maxTypes);
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(TYPES_READ_COST.maxBytes);
  expect(TYPES_READ_COST.graphReads).toBe(0);
  const conditional = await get({
    'if-none-match': response.headers.get('etag')!,
    'accept-language': 'ja',
  });
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe('');
});

test('G-979: compilation rejects malformed, untranslated and conflicting category metadata', () => {
  const realm = typesV1.types['rv:Realm'];
  const changed = (browse: unknown) =>
    ({
      ...typesV1,
      types: { ...typesV1.types, 'rv:Realm': { ...realm, browse } },
    }) as TypeRegistryDefinition;
  for (const browse of [
    null,
    false,
    { ...realm.browse, id: 'all' },
    { ...realm.browse, id: 'bad/category' },
    { ...realm.browse, order: -1 },
    { ...realm.browse, order: 0.5 },
    { ...realm.browse, labels: { ...realm.browse.labels, ja: '' } },
    { ...realm.browse, labels: { ...realm.browse.labels, ja: ' padded ' } },
    { ...realm.browse, labels: { en: 'Communities' } },
    { ...realm.browse, extra: true },
    { ...realm.browse, id: 'works' },
  ])
    expect(() => compile(changed(browse))).toThrow();
  const output = renderTypeRegistry(typesV1, workKindV2Profile, workTypeV2Profile);
  const relabelled = changed({
    ...realm.browse,
    labels: { ...realm.browse.labels, en: 'Reader communities' },
  });
  expect(renderTypeRegistry(relabelled, workKindV2Profile, workTypeV2Profile)).not.toBe(output);
  expect(compile(relabelled).filter((entry) => entry.base === 'work')).toEqual(
    compile().filter((entry) => entry.base === 'work'),
  );
});

test('G-979: descriptive admissions cannot spoof unpersisted structural browse metadata', () => {
  const definition = {
    ...compile().find((entry) => entry.browse?.id === 'communities')!,
    type: 'https://example.test/ReaderCommunity',
  };
  const { default: _default, creatable: _creatable, browse: _browse, ...metadata } = definition;
  const input = {
    profile: 'type-admission-v1',
    ...metadata,
    actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    idempotencyKey: 'g979',
  };
  expect(Value.Check(typeAdmission, input)).toBe(true);
  expect(Value.Check(typeAdmission, { ...input, browse: definition.browse })).toBe(false);
  expect(() =>
    assertRegisteredTypeSnapshot([{ definition, revision: '1', lifecycle: 'active' }]),
  ).toThrow();
});
