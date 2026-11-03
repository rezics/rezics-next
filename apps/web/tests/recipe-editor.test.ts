import { expect, test } from 'bun:test';
import { checkDocument } from '@rezics/document';
import {
  createRecipe,
  recipeDraft,
  recipeEvidence,
  recipeEvidenceChanges,
  recipeFields,
  recipeTarget,
  validateRecipe,
} from '../src/features/catalogue/recipe-editor';
import { statementInput } from '../src/features/catalogue/statement-editor';
import { recipeExample, recipeFixture, recipeId, ingredientId, dietId } from '../src/kernel/fake/recipe-editor';
import type { SessionEnv } from '../src/session/client';

test('Create and correct a released recipe with authored instructions and cited ingredients through existing native authority and current reading', async () => {
  const fixture = recipeFixture();
  const read = await fixture.transport.load();
  if (!read.ok) throw new Error('Expected released recipe profile');
  const item = recipeExample();
  const draft = recipeDraft(
    read.release,
    'en',
    [{ language: 'en', label: 'Lentil soup', description: '', aliases: '' }],
    Object.values(item.statements).flat(),
  );
  expect(draft.errors).toEqual([]);
  const created = await fixture.transport.create({ item: draft.item, key: crypto.randomUUID() });
  expect(created).toMatchObject({
    ok: true,
    id: recipeId,
    reader: { state: 'ready', href: `/en/subjects/${recipeId}/lentil-soup` },
  });
  const write = fixture.calls.find((call) => call.method === 'POST')!;
  expect(write).toMatchObject({ path: '/v1/subjects', body: draft.item, authorization: 'Bearer fixture' });
  expect(fixture.publicRead.subject.type).toBe('schema:Recipe');
  expect(fixture.publicRead.subject.statements['schema:recipeIngredient']![0]!.value).toEqual({
    type: 'value',
    content: { language: 'en', text: '200 g lentils' },
  });
  expect(fixture.publicRead.subject.statements['wdt:P186']![0]!.value).toEqual({
    type: 'value',
    content: ingredientId,
  });
  expect(fixture.publicRead.subject.statements['schema:suitableForDiet']![0]!.value).toEqual({
    type: 'value',
    content: dietId,
  });
  const method = fixture.publicRead.subject.statements['schema:recipeInstructions']![0]!.value;
  if (method.type !== 'value') throw new Error('Expected document reference');
  const content = method.content as { document: string };
  const document = await fixture.client.documents({ id: content.document }).get();
  expect(document.status).toBe(200);
  expect(checkDocument(document.data?.document.body)).toBe(true);
  const authored = document.data?.document;
  expect(authored && 'origin' in authored && authored.origin === 'account' && authored.licence).toBe('CC-BY-4.0');
  expect(statementInput(fixture.publicRead.subject.statements['schema:recipeInstructions']![0]!).value).toEqual(method);
  const source = fixture.publicRead.subject.statements['schema:cookTime']![0]!;
  const correction = statementInput(source);
  correction.value = { type: 'value', content: { amount: '+30', unit: 'http://www.wikidata.org/entity/Q7727' } };
  const result = await fixture.transport.propose({ id: recipeId, statement: correction, key: crypto.randomUUID() });
  expect(result.ok && result.kind).toBe('proposed-awaiting-review');
  expect(fixture.publicRead.subject.statements['schema:cookTime']![0]).toEqual(source);
  expect(fixture.calls.find((call) => call.path.endsWith('/candidates') && call.method === 'POST')?.body).toEqual({
    statement: correction,
  });
  expect([...fixture.candidates.values()][0]?.decision).toBeNull();
  expect(
    fixture.calls.some(
      (call) => call.path.endsWith(recipeId) && call.authorization === null && call.session === 'recipe-session',
    ),
  ).toBe(true);
});

test('complete independent evidence groups survive create and a later correction of one assertion', async () => {
  const fixture = recipeFixture();
  const read = await fixture.transport.load();
  if (!read.ok) throw new Error('Expected released recipe profile');
  const item = recipeExample();
  const ingredient = item.statements['schema:recipeIngredient']![0]!;
  ingredient.references = [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://cook.example/lentils' } },
        { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
      ],
    },
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://cook.example/second' } }] },
  ];
  item.statements['schema:cookTime']![0]!.references = [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://cook.example/time' } }] },
  ];
  const draft = recipeDraft(read.release, 'en', [{ language: 'en', label: 'Lentil soup', description: '', aliases: '' }], [
    ingredient,
    item.statements['schema:cookTime']![0]!,
    item.statements['schema:recipeInstructions']![0]!,
  ]);
  expect(draft.errors).toEqual([]);
  const created = await fixture.transport.create({ item: draft.item, key: crypto.randomUUID() });
  expect(created.ok).toBe(true);
  expect(fixture.publicRead.subject.statements['schema:recipeIngredient']![0]!.references.map((group) => group.parts.map((part) => part.property.id))).toEqual([
    ['schema:url', 'schema:inLanguage'],
    ['schema:url'],
  ]);
  const untouched = fixture.publicRead.subject.statements['schema:cookTime']![0]!;
  const source = fixture.publicRead.subject.statements['schema:recipeIngredient']![0]!;
  const correction = statementInput(source);
  correction.references = [
    correction.references[0]!,
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://cook.example/revised' } }] },
  ];
  expect(await fixture.transport.propose({ id: recipeId, statement: correction, key: crypto.randomUUID() })).toMatchObject({
    ok: true,
    kind: 'proposed-awaiting-review',
  });
  expect(fixture.publicRead.subject.statements['schema:cookTime']![0]).toEqual(untouched);
  expect(fixture.publicRead.subject.statements['schema:recipeIngredient']![0]).toEqual(source);
  expect(fixture.calls.find((call) => call.path.endsWith('/candidates') && call.method === 'POST')?.body).toEqual({
    statement: correction,
  });
  const retry = { id: recipeId, statement: correction, key: crypto.randomUUID() };
  fixture.setScenario('uncertain');
  expect(await fixture.transport.propose(retry)).toMatchObject({ ok: false, reason: 'unavailable' });
  fixture.setScenario('ready');
  expect(await fixture.transport.propose(retry, true)).toMatchObject({ ok: true });
  const writes = fixture.calls.filter((call) => call.path.endsWith('/candidates') && call.method === 'POST');
  expect(writes.at(-2)!.key).toBe(writes.at(-1)!.key);
  expect(writes.at(-2)!.body).toEqual(writes.at(-1)!.body);
  expect(writes.at(-1)!.key).not.toBe(writes[0]!.key);
});

test('empty citation scaffolds are omitted; evidence changes classify retained added edited and removed groups', () => {
  const statement = recipeExample().statements['schema:recipeIngredient']![0]!;
  statement.references.push({ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: '' } }] });
  statement.qualifiers = [{ property: { id: 'schema:position' }, value: { type: 'value', content: '' } }];
  expect(recipeEvidence(statement).references).toEqual(recipeExample().statements['schema:recipeIngredient']![0]!.references);
  expect(recipeEvidence(statement).qualifiers).toEqual([]);
  const current = recipeExample().statements['schema:recipeIngredient']![0]!.references;
  const next = [
    current[0]!,
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://cook.example/new' } }] },
  ];
  next[0] = {
    parts: [
      { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://cook.example/edited' } },
      current[0]!.parts[0]!,
    ],
  };
  expect(recipeEvidenceChanges(current, next).map((entry) => entry.change)).toEqual(['edited', 'added']);
  expect(recipeEvidenceChanges(next, current).map((entry) => entry.change)).toEqual(['edited', 'removed']);
});

test('uses emitted fields, exact native quantities and selected targets; refuses invented profiles, units and document licences', async () => {
  const fixture = recipeFixture();
  expect(recipeFields(fixture.release, 'ja')).toContain('wdt:P186');
  expect(recipeFields(fixture.release, 'en')).not.toContain('schema:madeFromMaterial');
  expect(recipeTarget(fixture.release, 'schema:suitableForDiet', 'skos:Concept')).toBe(true);
  expect(recipeTarget(fixture.release, 'schema:suitableForDiet', 'schema:Recipe')).toBe(false);
  for (const mutate of [
    (item: ReturnType<typeof recipeExample>) => {
      item.type = 'schema:HowTo';
    },
    (item: ReturnType<typeof recipeExample>) => {
      item.statements['schema:cookTime']![0]!.value = { type: 'value', content: { amount: 'PT25M', unit: 'minute' } };
    },
    (item: ReturnType<typeof recipeExample>) => {
      item.statements['schema:recipeYield']![0]!.value = { type: 'value', content: { amount: '+0', unit: '1' } };
    },
    (item: ReturnType<typeof recipeExample>) => {
      item.statements['schema:recipeInstructions']![0]!.value = {
        type: 'value',
        content: { document: 'https://recipe-site.example/method' },
      };
    },
  ]) {
    const item = recipeExample();
    mutate(item);
    expect(validateRecipe(fixture.release, item, 'en').length).toBeGreaterThan(0);
    expect(await fixture.transport.create({ item, key: crypto.randomUUID() })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  }
  expect(fixture.calls.filter((call) => call.method === 'POST')).toEqual([]);
  delete fixture.release.types['schema:Recipe'];
  expect(recipeFields(fixture.release, 'en')).toEqual([]);
});

test('uncertain writes retain exact keys/payloads; per-field failures preserve current reading and native CSRF denial', async () => {
  const fixture = recipeFixture('uncertain');
  const command = { item: recipeExample(), key: crypto.randomUUID() };
  expect(await fixture.transport.create(command)).toEqual({ ok: false, reason: 'unavailable' });
  expect(await fixture.transport.create(command)).toMatchObject({ ok: true, id: recipeId });
  const writes = fixture.calls.filter((call) => call.method === 'POST');
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  expect(writes[0]!.key).toBe(writes[1]!.key);
  expect(fixture.receipts.size).toBe(1);
  const source = fixture.publicRead.subject.statements['schema:cookTime']![0]!;
  const correction = { id: recipeId, key: crypto.randomUUID(), statement: statementInput(source) };
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['invalid', 'invalid'],
    ['conflict', 'stale'],
  ] as const) {
    fixture.setScenario(scenario);
    expect(await fixture.transport.propose(correction)).toMatchObject({ ok: false, reason });
    expect(fixture.publicRead.subject.statements['schema:cookTime']![0]).toEqual(source);
  }
  fixture.setScenario('uncertain');
  const env = {
    AUTH_ISSUER: 'https://auth.invalid',
    API_RESOURCE: 'https://kernel.invalid',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'site',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {},
  } as Partial<SessionEnv>;
  const request = new Request('https://site.invalid/api', {
    method: 'POST',
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://other.invalid',
      'x-csrf-token': 'wrong',
    },
  });
  expect(await createRecipe(fixture.client, request, env, command, 'en')).toEqual({ ok: false, reason: 'denied' });
  fixture.setScenario('reader-unavailable');
  expect(await fixture.transport.create(command)).toEqual({ ok: true, id: recipeId, reader: { state: 'unavailable' } });
  fixture.setScenario('ready');
  expect(await fixture.transport.read(recipeId)).toMatchObject({ state: 'ready' });
});
