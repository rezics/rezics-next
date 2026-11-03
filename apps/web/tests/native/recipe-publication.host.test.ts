import { afterAll, expect, test } from 'bun:test';
import { checkDocument, fromPlainText } from '@rezics/document';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startNativeWebStack, type NativeWebStack } from './stack';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll } from './lifecycle.ts';

const minute = 'http://www.wikidata.org/entity/Q7727';
const english = ['Rinse the rice.', 'Add water.', 'Simmer for 25 minutes.'];
const japanese = ['米を洗う。', '水を加える。', '25分間煮る。'];
const documents = { en: fromPlainText(english.join('\n')), ja: fromPlainText(japanese.join('\n')) };
const statement = (id: string, content: unknown) => ({
  property: { id },
  value: { type: 'value', content },
  references: [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/original-rice' } },
      ],
    },
  ],
});
type PublicSubject = {
  id: string;
  type: string;
  labels: Record<string, string>;
  statements: Record<string, { id: string; value: { type: string; content: unknown } }[]>;
};
type PublicRead = { subject: PublicSubject; related: Record<string, unknown> };
let stack: NativeWebStack;
let recipe: PublicSubject;
let publicRead: PublicRead;
let pageRead: { reads: Record<string, { status: number; body: PublicRead }> };
const lifecycle = new NativeTestLifecycle('native Recipe publication suite');

async function command(path: string, body: unknown, persona = 'editor') {
  const response = await stack.kernel(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify(body),
    },
    persona,
  );
  const result = await response.json();
  expect({ status: response.status, body: response.ok ? undefined : result }).toEqual({
    status: ['/v1/subjects', '/v1/grants'].includes(path) ? 201 : 200,
    body: undefined,
  });
  return result as { subject: PublicSubject };
}
async function read(id: string): Promise<PublicRead> {
  const response = await stack.kernel(`/v1/subjects/${id}`, { headers: { 'accept-language': 'en,ja' } });
  expect(response.status).toBe(200);
  return (await response.json()) as PublicRead;
}
function graph(html: string): Record<string, unknown> {
  const scripts = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  const nodes = scripts.flatMap((match) => {
    const value = JSON.parse(match[1]!);
    return [value, ...(value['@graph'] ?? [])];
  });
  const recipe = nodes.find((node) => node['@type'] === 'Recipe');
  expect(recipe).toBeDefined();
  return recipe;
}
async function served(locale = 'en', subject = recipe) {
  const path = subjectHref({ id: subject.id, label: subject.labels[locale]! }, locale).href;
  const start = stack.kernelRequests().length;
  const response = await stack.request(`${stack.web}${path}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  const html = await response.text();
  const requests = stack.kernelRequests().slice(start);
  expect(requests.filter(({ url }) => url.startsWith('/v1/pages:read'))).toHaveLength(1);
  expect(requests.some(({ url }) => /\/v1\/documents\//.test(url))).toBe(false);
  return { html, jsonld: graph(html), requests };
}

nativeBeforeAll(lifecycle, 300_000, async () => {
  stack = await startNativeWebStack();
  const created = await command('/v1/subjects', {
    type: 'schema:Recipe',
    labels: { en: 'Native public rice', ja: '公開のご飯' },
    statements: {
      'schema:cookTime': [statement('schema:cookTime', { amount: '+25', unit: minute })],
      'schema:recipeInstructions': [
        statement('schema:recipeInstructions', { language: 'en', document: documents.en, licence: 'CC-BY-4.0' }),
      ],
    },
  });
  recipe = created.subject;
  publicRead = await read(recipe.id);
  const response = await stack.kernel('/v1/pages:read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { subject: recipe.id }, languages: ['en'] }),
  });
  expect(response.status).toBe(200);
  pageRead = (await response.json()) as typeof pageRead;
});
afterAll(async () => {
  await stack?.stop();
}, 300_000);
nativeAfterAll(lifecycle, 300_000);

test('native served Recipe duration agrees with its ordinary public read at increasing unrelated record counts', async () => {
  expect(publicRead.subject.statements['schema:cookTime']![0]!.value).toEqual({
    type: 'value',
    content: { amount: '+25', unit: minute },
  });
  let count = 0;
  let baseline: string[] | undefined;
  let bytes: number | undefined;
  for (const population of [0, 1, 8]) {
    for (; count < population; count++)
      await command('/v1/subjects', { type: 'schema:Recipe', labels: { en: `Unrelated native recipe ${count}` } });
    // Warm definitions once before measuring each population, so cold metadata caching is not mistaken for growth.
    await served();
    const result = await served();
    expect(result.jsonld.cookTime).toBe('PT25M');
    expect(result.jsonld.recipeInstructions).toEqual(
      english.map((text) => ({ '@type': 'HowToStep', text, inLanguage: 'en' })),
    );
    const signature = result.requests.map(({ method, url }) => `${method} ${url}`).sort();
    baseline ??= signature;
    bytes ??= JSON.stringify(result.jsonld).length;
    expect(signature).toEqual(baseline);
    expect(JSON.stringify(result.jsonld).length).toBe(bytes);
    const visible = result.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    expect(visible).toContain('Native public rice');
    expect(visible).toContain('25');
    let previous = -1;
    for (const text of english) {
      const position = visible.indexOf(text);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(visible).not.toContain('Unrelated native recipe');
    expect(JSON.stringify(result.jsonld)).not.toContain('Unrelated native recipe');
  }
}, 300_000);

test('native page and public read supply the same validated instruction body to the renderer and JSON-LD', async () => {
  const result = await served();
  expect(result.jsonld.cookTime).toBe('PT25M');
  const planned = Object.values(pageRead.reads).find(
    (entry) => entry.status === 200 && entry.body?.subject?.id === recipe.id,
  );
  expect(planned).toBeDefined();
  const actual = publicRead.subject.statements['schema:recipeInstructions']!;
  expect(planned!.body.subject.statements['schema:recipeInstructions']).toEqual(actual);
  const englishStatement = actual.find(({ value }) => (value.content as { language: string }).language === 'en')!;
  const englishContent = englishStatement.value.content as { language: string; document: string; digest: string };
  const { serializeDocument } = await import('@rezics/document');
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeDocument(documents.en)))),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  expect(englishContent).toEqual({ language: 'en', document: expect.any(String), digest });
  const oracle = await stack.kernel(`/v1/documents/${englishContent.document}`);
  expect(oracle.status).toBe(200);
  expect(oracle.headers.get('cache-control')).toBe('private, no-store');
  const { document } = await oracle.json();
  expect(document).toEqual({
    id: englishContent.document,
    subjectId: recipe.id,
    candidateId: englishStatement.id,
    revision: 1,
    origin: 'account',
    author: expect.any(String),
    licence: 'CC-BY-4.0',
    language: 'en',
    digest,
    availability: 'available',
    body: documents.en,
  });
  expect(checkDocument(document.body)).toBe(true);
  expect((planned!.body as PublicRead & { documents: Record<string, unknown> }).documents[englishStatement.id]).toEqual(
    document,
  );
  expect(result.jsonld.recipeInstructions).toEqual(
    english.map((text) => ({ '@type': 'HowToStep', text, inLanguage: 'en' })),
  );
  const visible = result.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  let previous = -1;
  for (const text of english) {
    const position = visible.indexOf(text);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
  expect(visible).not.toContain(japanese[0]!);
}, 300_000);

test('native different-language publication uses exactly the supplied public Japanese instructions', async () => {
  // The released property is single-valued. A separate authored Recipe supplies the Japanese body.
  const japaneseRecipe = (
    await command('/v1/subjects', {
      type: 'schema:Recipe',
      labels: { en: 'Native Japanese method', ja: '日本語の手順' },
      statements: {
        'schema:cookTime': [statement('schema:cookTime', { amount: '+25', unit: minute })],
        'schema:recipeInstructions': [
          statement('schema:recipeInstructions', { language: 'ja', document: documents.ja, licence: 'CC-BY-4.0' }),
        ],
      },
    })
  ).subject;
  const publicJapanese = await read(japaneseRecipe.id);
  expect(publicJapanese.subject.statements['schema:recipeInstructions']![0]!.value.content).toHaveProperty(
    'language',
    'ja',
  );
  const result = await served('en', japaneseRecipe);
  expect(result.jsonld.cookTime).toBe('PT25M');
  expect(result.jsonld.name).toBe('Native Japanese method');
  expect(result.jsonld.recipeInstructions).toEqual(
    japanese.map((text) => ({ '@type': 'HowToStep', text, inLanguage: 'ja' })),
  );
  const visible = result.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  let previous = -1;
  for (const text of japanese) {
    const position = visible.indexOf(text);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
  expect(visible).not.toContain(english[0]!);
}, 300_000);

test('complete original recipe evidence groups survive a later native correction of one assertion', async () => {
  const created = (
    await command('/v1/subjects', {
      type: 'schema:Recipe',
      labels: { en: 'Complete native recipe' },
      statements: {
        'schema:recipeIngredient': [
          {
            property: { id: 'schema:recipeIngredient' },
            value: { type: 'value', content: { language: 'en', text: '200 g rice' } },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: 'https://example.org/rice' },
                  },
                  { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
                ],
              },
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: 'https://example.org/second' },
                  },
                ],
              },
            ],
          },
        ],
        'schema:cookTime': [statement('schema:cookTime', { amount: '+25', unit: minute })],
        'schema:recipeInstructions': [
          statement('schema:recipeInstructions', {
            language: 'en',
            document: documents.en,
            licence: 'CC-BY-4.0',
          }),
        ],
      },
    })
  ).subject;
  const original = await read(created.id);
  const ingredient = original.subject.statements['schema:recipeIngredient']![0] as {
    id: string;
    value: { type: string; content: unknown };
    references: { parts: { property: { id: string }; value: unknown }[] }[];
  };
  expect(ingredient.references.map((group) => group.parts.map((part) => part.property.id))).toEqual([
    ['schema:url', 'schema:inLanguage'],
    ['schema:url'],
  ]);
  const proposal = await stack.kernel(
    `/v1/subjects/${created.id}/candidates`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({
        statement: {
          property: { id: 'schema:cookTime' },
          value: { type: 'value', content: { amount: '+40', unit: minute } },
          references: statement('schema:cookTime', { amount: '+40', unit: minute }).references,
          rank: 'normal',
        },
      }),
    },
    'editor',
  );
  expect(proposal.status).toBe(201);
  const current = await read(created.id);
  expect(current.subject.statements['schema:recipeIngredient']).toEqual(original.subject.statements['schema:recipeIngredient']);
  expect(current.subject.statements['schema:cookTime']![0]!.value).toEqual({
    type: 'value',
    content: { amount: '+25', unit: minute },
  });
  const method = current.subject.statements['schema:recipeInstructions']![0]!.value;
  expect(method.type).toBe('value');
}, 300_000);

test('native author erasure withholds the actual instruction body from served publication', async () => {
  const withheld = (
    await command('/v1/subjects', {
      type: 'schema:Recipe',
      labels: { en: 'Withheld native recipe' },
      statements: {
        'schema:recipeInstructions': [
          statement('schema:recipeInstructions', {
            language: 'en',
            document: fromPlainText('WITHHELD METHOD'),
            licence: 'CC-BY-4.0',
          }),
        ],
      },
    })
  ).subject;
  const reference = withheld.statements['schema:recipeInstructions']![0]!.value.content as { document: string };
  const erased = await stack.kernel(
    `/v1/documents/${reference.document}`,
    { method: 'DELETE', headers: { 'idempotency-key': `"${crypto.randomUUID()}"` } },
    'editor',
  );
  expect(erased.status).toBe(204);
  // Authored erasure conceals the document even though the semantic reference remains disclosed.
  const erasedRead = await stack.kernel(`/v1/documents/${reference.document}`);
  expect(erasedRead.status).toBe(404);
  expect(await erasedRead.text()).not.toContain('WITHHELD METHOD');
  const hidden = await read(withheld.id);
  expect(hidden.subject.statements['schema:recipeInstructions']).toEqual(
    withheld.statements['schema:recipeInstructions'],
  );
  const path = subjectHref({ id: withheld.id, label: withheld.labels.en! }, 'en').href;
  const response = await stack.request(`${stack.web}${path}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).not.toContain('WITHHELD METHOD');
  expect(graph(html)).not.toHaveProperty('recipeInstructions');
}, 300_000);
