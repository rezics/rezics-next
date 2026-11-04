import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import {
  appearanceAgeProperty,
  appearanceProperty,
  characterWorkIdentityOverlay,
  characterWorkType,
  identityProperty,
} from '../../src/presentation/semantic-page.ts';
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

const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value' as const, content } });
const cited = (id: string, content: unknown, qualifiers: ReturnType<typeof snak>[] = []) => ({
  ...snak(id, content),
  qualifiers,
  references: [{ parts: [snak('schema:url', 'https://example.test/character-work')] }],
});

async function create(type: string, label: string) {
  const created = await driver.request('editor', 'POST', '/v1/subjects', { type, labels: { en: label } }, key());
  status(created, 201, `create ${label}`);
  const subject = created.body.subject as { id: string };
  return subject.id;
}

async function adopt(subject: string, statement: ReturnType<typeof cited>) {
  const path = `/v1/subjects/${subject}`;
  const proposed = await driver.request('editor', 'POST', `${path}/candidates`, { statement }, key());
  status(proposed, 201, `propose ${statement.property.id}`);
  const candidate = proposed.body.candidate as string;
  const accepted = await driver.request(
    'acceptor',
    'POST',
    `${path}/candidates/${candidate}:accept`,
    { context: GLOBAL_CONTEXT, expected_head: null },
    key(),
  );
  status(accepted, 200, `accept ${statement.property.id}`);
  const target =
    statement.value.type === 'value' && typeof statement.value.content === 'string'
      ? statement.value.content
      : undefined;
  const adopted = await driver.request(
    'acceptor',
    'POST',
    `${path}:adopt`,
    {
      context: GLOBAL_CONTEXT,
      property: statement.property.id,
      ...(target ? { target } : {}),
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    },
    key(),
  );
  status(adopted, 200, `adopt ${statement.property.id}`);
  return candidate;
}

async function waitLinks(id: string, property: string, direction: 'links' | 'relations' = 'links') {
  const path = `/v1/subjects/${id}/${direction}?property=${encodeURIComponent(property)}&limit=20`;
  for (let step = 0; step < 40; step++) {
    const page = await driver.request('anonymous', 'GET', path);
    if (page.status === 200 && ((page.body.links ?? page.body.relations) as unknown[] | undefined)?.length) return page;
    await Bun.sleep(50);
  }
  const last = await driver.request('anonymous', 'GET', path);
  status(last, 200, `links ${property}`);
  return last;
}

test('a reader follows a Character identity and work appearance ages through native adoption and the production page', async () => {
  expect(characterWorkIdentityOverlay(bundledRelease, characterWorkType, 'en')?.unavailable).toEqual([]);
  const stripped = structuredClone(bundledRelease);
  delete stripped.properties[identityProperty];
  delete stripped.properties[appearanceAgeProperty];
  for (const id of ['wdt:P26', 'wdt:P3373', 'wdt:P22', 'wdt:P25', 'wdt:P451', 'rezics:characterRival'])
    delete stripped.properties[id];
  stripped.properties[appearanceProperty] = {
    ...stripped.properties[appearanceProperty]!,
    qualifiers: stripped.properties[appearanceProperty]!.qualifiers.filter((id) => id !== appearanceAgeProperty),
  };
  expect(characterWorkIdentityOverlay(stripped, characterWorkType, 'en')?.unavailable.map((item) => item.id).sort()).toEqual([
    'age-at-appearance',
    'character-relationship',
    'main-character-linkage',
  ]);

  const alice = await create(characterWorkType, 'Alice');
  const twin = await create(characterWorkType, 'Twin');
  const spring = await create('schema:VideoGame', 'Spring work');
  const autumn = await create('schema:VideoGame', 'Autumn work');
  const role = await create('skos:Concept', 'Main');
  await adopt(alice, cited(identityProperty, twin, [snak('rezics:spoilerLevel', { amount: '+1', unit: '1' })]));
  await adopt(
    spring,
    cited(appearanceProperty, alice, [
      snak('wdt:P3831', role),
      snak(appearanceAgeProperty, { amount: '+16', unit: year }),
    ]),
  );
  await adopt(
    autumn,
    cited(appearanceProperty, alice, [snak(appearanceAgeProperty, { amount: '+18', unit: year })]),
  );

  const wrongTarget = await driver.request(
    'editor',
    'POST',
    `/v1/subjects/${alice}/candidates`,
    { statement: cited(identityProperty, spring) },
    key(),
  );
  expect(wrongTarget.status).toBe(400);
  expect(wrongTarget.body.errors).toContainEqual({
    pointer: '/statement/value/content',
    code: 'out_of_range',
  });
  const wrongQualifier = await driver.request(
    'editor',
    'POST',
    `/v1/subjects/${spring}/candidates`,
    {
      statement: cited(appearanceProperty, alice, [
        snak(appearanceAgeProperty, { amount: '+16', unit: '1' }),
      ]),
    },
    key(),
  );
  expect(wrongQualifier.status).toBe(400);

  const appearances = await waitLinks(alice, appearanceProperty);
  const rows = appearances.body.links as { subject: string; assertion?: { qualifiers: { property: { id: string }; value: { content: unknown } }[] } }[];
  expect(rows).toHaveLength(2);
  const ages = Object.fromEntries(
    rows.map((row) => {
      const age = row.assertion?.qualifiers.find((part) => part.property.id === appearanceAgeProperty);
      return [row.subject, age?.value.content];
    }),
  );
  expect(ages[spring]).toEqual({ amount: '+16', unit: year });
  expect(ages[autumn]).toEqual({ amount: '+18', unit: year });
  const identityPage = await waitLinks(alice, identityProperty, 'relations');
  type IdentityRow = {
    statement: {
      property: { id: string };
      value: { content: unknown };
      qualifiers: { property: { id: string }; value: { content: unknown } }[];
    };
    summary: { id: string } | null;
  };
  const identityRows = identityPage.body.relations as IdentityRow[];
  expect(identityRows[0]?.statement.property.id).toBe(identityProperty);
  expect(identityRows[0]?.statement.value.content).toBe(twin);
  expect(identityRows[0]?.summary?.id).toBe(twin);
  expect(
    identityRows[0]?.statement.qualifiers.some(
      (part) =>
        part.property.id === 'rezics:spoilerLevel' &&
        JSON.stringify(part.value.content) === JSON.stringify({ amount: '+1', unit: '1' }),
    ),
  ).toBe(true);
  await driver.grant('steward', ['moderation:hide'], twin);
  status(
    await driver.request(
      'steward',
      'POST',
      `/v1/subjects/${twin}:hide`,
      { reason: 'Native identity target concealment' },
      key(),
    ),
    200,
    'hide identity target',
  );
  const hiddenIdentity = await driver.request(
    'anonymous',
    'GET',
    `/v1/subjects/${alice}/relations?property=${encodeURIComponent(identityProperty)}&limit=20`,
  );
  status(hiddenIdentity, 200, 'hidden identity relations');
  const hiddenRows = hiddenIdentity.body.relations as IdentityRow[];
  expect(hiddenRows.every((row) => row.summary?.id !== twin)).toBe(true);
  expect(JSON.stringify(hiddenIdentity.body)).not.toContain('Twin');

  const pageOf = (persona: 'anonymous' | 'editor' | 'acceptor') =>
    driver.request(persona, 'POST', '/v1/pages:read', { target: { subject: alice }, languages: ['en'] });
  const anonymous = await pageOf('anonymous');
  const editor = await pageOf('editor');
  const acceptor = await pageOf('acceptor');
  status(anonymous, 200, 'anonymous character page');
  status(editor, 200, 'editor character page');
  status(acceptor, 200, 'acceptor character page');
  type PageBody = {
    unavailable: { id: string }[];
    meanings: Record<string, { text: string }>;
    viewer: { signedIn: boolean; actions: Record<string, string> };
  };
  const anonymousPage = anonymous.body as PageBody;
  const editorPage = editor.body as PageBody;
  const acceptorPage = acceptor.body as PageBody;
  expect(anonymousPage.unavailable).toEqual([]);
  expect(anonymousPage.meanings[identityProperty]!.text.length).toBeGreaterThan(0);
  expect(anonymousPage.viewer).toMatchObject({
    signedIn: false,
    actions: { 'statement:propose': 'denied', 'context:accept': 'denied', 'context:adopt': 'denied' },
  });
  expect(editorPage.viewer).toMatchObject({ signedIn: true, actions: { 'statement:propose': 'allowed' } });
  expect(acceptorPage.viewer.actions).toMatchObject({ 'context:accept': 'allowed', 'context:adopt': 'allowed' });
  expect(anonymous.headers.get('cache-control')).toBe('private, no-store');

  const outsider = await driver.fixtures.person('character-outsider');
  const denied = await driver.fixtures.send(
    outsider,
    'POST',
    `/v1/subjects/${alice}/candidates`,
    { statement: cited(identityProperty, twin) },
    key(),
  );
  expect([401, 403]).toContain(denied.status);
  const outsiderPage = await driver.fixtures.send(outsider, 'POST', '/v1/pages:read', {
    target: { subject: alice },
    languages: ['en'],
  });
  status(outsiderPage, 200, 'outsider character page');
  expect((outsiderPage.body as PageBody).viewer.actions['statement:propose']).toBe('denied');

  const correction = await adopt(
    spring,
    cited(appearanceProperty, alice, [
      snak('wdt:P3831', role),
      snak(appearanceAgeProperty, { amount: '+17', unit: year }),
    ]),
  );
  const refreshed = await waitLinks(alice, appearanceProperty);
  const springAge = (refreshed.body.links as typeof rows).find((row) => row.subject === spring);
  expect(springAge?.assertion?.qualifiers.find((part) => part.property.id === appearanceAgeProperty)?.value.content).toEqual({
    amount: '+17',
    unit: year,
  });
  expect(correction).toEqual(expect.any(String));
}, 180_000);
