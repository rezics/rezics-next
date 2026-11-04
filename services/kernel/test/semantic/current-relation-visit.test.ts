import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { appearanceAgeProperty, appearanceProperty, characterWorkType } from '../../src/presentation/semantic-page.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';

const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
const year = 'http://www.wikidata.org/entity/Q577';
let driver: SemanticOutcomeDriver;

beforeAll(async () => {
  driver = await createSemanticDriver(undefined, { strictCleanup: true });
}, 120_000);
afterAll(async () => {
  await driver?.close();
}, 60_000);

function status(response: HttpResponse, wanted: number, phase: string) {
  expect(response.status, `${phase}: ${JSON.stringify(response.body)}`).toBe(wanted);
}

const appearance = (character: string, age: string) => ({
  property: { id: appearanceProperty },
  value: { type: 'value' as const, content: character },
  qualifiers: [
    { property: { id: appearanceAgeProperty }, value: { type: 'value' as const, content: { amount: age, unit: year } } },
  ],
  references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: 'https://example.test/appearance' } }] }],
});

async function create(type: string, label: string, statements?: Record<string, ReturnType<typeof appearance>[]>) {
  const response = await driver.request(
    'editor',
    'POST',
    '/v1/subjects',
    { type, labels: { en: label }, ...(statements ? { statements } : {}) },
    key(),
  );
  status(response, 201, `create ${label}`);
  return (response.body.subject as { id: string }).id;
}

async function waitLinks(character: string, count: number) {
  const path = `/v1/subjects/${character}/links?property=${encodeURIComponent(appearanceProperty)}&limit=20`;
  for (let step = 0; step < 40; step++) {
    const page = await driver.request('anonymous', 'GET', path);
    if (page.status === 200 && (page.body.links as unknown[] | undefined)?.length === count) return;
    await Bun.sleep(50);
  }
  const page = await driver.request('anonymous', 'GET', path);
  status(page, 200, 'character appearances');
  expect(page.body.links).toHaveLength(count);
}

test('compact and expanded appearance visits retain current qualified statements and disclosed targets', async () => {
  const character = await create(characterWorkType, 'Relation visit character');
  const compactWork = await create('schema:VideoGame', 'Compact appearance', {
    [appearanceProperty]: [appearance(character, '+16')],
  });
  const expandedWork = await create('schema:VideoGame', 'Expanded appearance');
  const proposed = await driver.request(
    'editor',
    'POST',
    `/v1/subjects/${expandedWork}/candidates`,
    { statement: appearance(character, '+18') },
    key(),
  );
  status(proposed, 201, 'propose expanded appearance');
  const candidate = proposed.body.candidate as string;
  status(
    await driver.request(
      'acceptor',
      'POST',
      `/v1/subjects/${expandedWork}/candidates/${candidate}:accept`,
      { context: GLOBAL_CONTEXT, expected_head: null },
      key(),
    ),
    200,
    'accept expanded appearance',
  );
  status(
    await driver.request(
      'acceptor',
      'POST',
      `/v1/subjects/${expandedWork}:adopt`,
      {
        context: GLOBAL_CONTEXT,
        property: appearanceProperty,
        target: character,
        mode: 'replace',
        selection: [{ candidate, rank: 'preferred' }],
        expected_head: null,
      },
      key(),
    ),
    200,
    'adopt expanded appearance',
  );

  await waitLinks(character, 2);
  const first = await driver.request(
    'anonymous',
    'GET',
    `/v1/subjects/${character}/links?property=${encodeURIComponent(appearanceProperty)}&limit=1`,
  );
  status(first, 200, 'first inverse appearance page');
  expect(first.body.links).toHaveLength(1);
  const cursor = first.body.next as string;
  expect(cursor).toBeTruthy();
  const second = await driver.request(
    'anonymous',
    'GET',
    `/v1/subjects/${character}/links?property=${encodeURIComponent(appearanceProperty)}&limit=1&cursor=${encodeURIComponent(cursor)}`,
  );
  status(second, 200, 'second inverse appearance page');
  const appearances = [...(first.body.links as Record<string, any>[]), ...(second.body.links as Record<string, any>[])];
  const ages = new Map(
    appearances.map((row) => [
      row.subject,
      row.assertion?.qualifiers.find((part: { property: { id: string } }) => part.property.id === appearanceAgeProperty)
        ?.value.content,
    ]),
  );
  expect(ages.get(compactWork)).toEqual({ amount: '+16', unit: year });
  expect(ages.get(expandedWork)).toEqual({ amount: '+18', unit: year });

  const relation = await driver.request(
    'anonymous',
    'GET',
    `/v1/subjects/${expandedWork}/relations?property=${encodeURIComponent(appearanceProperty)}`,
  );
  status(relation, 200, 'forward expanded appearance');
  const row = (relation.body.relations as Record<string, any>[])[0]!;
  expect(row.statement.id).toBe(candidate);
  expect(row.statement.rank).toBe('preferred');
  expect(row.summary?.id).toBe(character);

  await driver.grant('steward', ['moderation:hide'], character);
  status(
    await driver.request('steward', 'POST', `/v1/subjects/${character}:hide`, { reason: 'Conceal relation target' }, key()),
    200,
    'hide relation target',
  );
  const concealed = await driver.request(
    'anonymous',
    'GET',
    `/v1/subjects/${expandedWork}/relations?property=${encodeURIComponent(appearanceProperty)}`,
  );
  status(concealed, 200, 'concealed relation target');
  expect((concealed.body.relations as Record<string, any>[]).every((entry) => entry.summary?.id !== character)).toBe(true);
});
