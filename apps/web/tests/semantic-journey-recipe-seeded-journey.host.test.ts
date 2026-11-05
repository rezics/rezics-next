import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { GLOBAL_CONTEXT } from '../../../services/kernel/src/semantic/definitions.ts';
import { subjectHref } from '../src/subject/subject-href.ts';
import { startNativeWebStack, type NativeWebStack } from './native/stack';

const minute = 'http://www.wikidata.org/entity/Q7727';
const marker = `journeyrecipe${crypto.randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
const steps = ['Rinse the rice.', 'Add water.', 'Simmer for 25 minutes.'];
const source = (id: string, content: unknown) => ({
  property: { id },
  value: { type: 'value', content },
  references: [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/journey-recipe' } },
      ],
    },
  ],
});
type Subject = {
  id: string;
  type: string;
  labels: Record<string, string>;
  statements: Record<string, { id: string; value: { type: string; content: any } }[]>;
};

let stack: NativeWebStack;
let diet: Subject;
let recipe: Subject;
let correction: string;

beforeAll(async () => {
  stack = await startNativeWebStack();
  diet = (await command('/v1/subjects', { type: 'skos:Concept', labels: { en: `${marker} diet` } })).subject;
  recipe = (
    await command('/v1/subjects', {
      type: 'schema:Recipe',
      labels: { en: `${marker} stew` },
      statements: {
        'schema:cookTime': [source('schema:cookTime', { amount: '+25', unit: minute })],
        'schema:recipeYield': [source('schema:recipeYield', { amount: '+4', unit: '1' })],
        'schema:recipeIngredient': [
          source('schema:recipeIngredient', { language: 'en', text: '200 g rice' }),
        ],
        'schema:recipeInstructions': [
          source('schema:recipeInstructions', {
            language: 'en',
            document: fromPlainText(steps.join('\n')),
            licence: 'CC-BY-4.0',
          }),
        ],
        'schema:suitableForDiet': [source('schema:suitableForDiet', diet.id)],
      },
    })
  ).subject;
}, 300_000);

afterAll(async () => {
  await stack?.stop();
}, 180_000);

async function write(path: string, body: unknown, persona = 'editor') {
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
    status: path === '/v1/subjects' ? 201 : 200,
    body: undefined,
  });
  return result as Record<string, any>;
}

async function command(path: string, body: unknown, persona = 'editor') {
  return (await write(path, body, persona)) as { subject: Subject };
}

function href(subject: Subject) {
  return subjectHref({ id: subject.id, label: subject.labels.en! }, 'en').href;
}

async function served(subject: Subject, persona?: string) {
  const response = await stack.request(`${stack.web}${href(subject)}`, persona);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  const html = await response.text();
  const jsonld = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap(
    (match) => {
      const value = JSON.parse(match[1]!);
      return [value, ...(value['@graph'] ?? [])];
    },
  );
  const recipeNode = jsonld.find((node) => node['@type'] === 'Recipe');
  return { html: html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), recipe: recipeNode };
}

async function publicRead(id: string) {
  const response = await stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { subject: Subject }).subject;
}

test('the authored Recipe exists through the real API with diet, duration, yield and instructions', async () => {
  const read = await publicRead(recipe.id);
  expect(read.type).toBe('schema:Recipe');
  expect(read.statements['schema:cookTime']![0]!.value.content).toMatchObject({ amount: '+25', unit: minute });
  expect(read.statements['schema:recipeYield']![0]!.value.content).toMatchObject({ amount: '+4', unit: '1' });
  expect(read.statements['schema:suitableForDiet']![0]!.value.content).toBe(diet.id);
  const instructions = read.statements['schema:recipeInstructions']![0]!.value.content as {
    document: string;
    digest: string;
  };
  const oracle = await stack.kernel(`/v1/documents/${instructions.document}`);
  expect(oracle.status).toBe(200);
  const { document } = (await oracle.json()) as { document: { digest: string; language: string; body: unknown } };
  expect(document.language).toBe('en');
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeDocument(fromPlainText(steps.join('\n')))))),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  expect(document.digest).toBe(digest);
});

test('anonymous and signed-in served pages show the same instructions, duration and linked diet', async () => {
  const anonymous = await served(recipe);
  const alice = await served(recipe, 'alice');
  for (const page of [anonymous, alice]) {
    let previous = -1;
    for (const step of steps) {
      const position = page.html.indexOf(step);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(page.html).toContain(href(diet));
    expect(page.recipe).toMatchObject({ cookTime: 'PT25M' });
  }
  expect(alice.html).toContain(`${href(recipe)}/recipe`);
});

test('a linked Subject serves and the Recipe serves again after returning', async () => {
  const dietPage = await stack.request(`${stack.web}${href(diet)}`);
  expect(dietPage.status).toBe(200);
  const back = await served(recipe, 'alice');
  expect(back.html).toContain(steps[0]!);
});

test('a signed-in cook-time correction is proposed, accepted, adopted and read back publicly', async () => {
  const proposed = await stack.kernel(
    `/v1/subjects/${recipe.id}/candidates`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ statement: source('schema:cookTime', { amount: '+30', unit: minute }) }),
    },
    'alice',
  );
  expect(proposed.status).toBe(201);
  correction = ((await proposed.json()) as { candidate: string }).candidate;

  const accepted = await write(
    `/v1/subjects/${recipe.id}/candidates/${correction}:accept`,
    { context: GLOBAL_CONTEXT, expected_head: null },
    'steward',
  );
  expect(accepted).toMatchObject({ acceptance: { candidate: correction, decision: 'accept' } });
  const adopted = await write(
    `/v1/subjects/${recipe.id}:adopt`,
    {
      context: GLOBAL_CONTEXT,
      property: 'schema:cookTime',
      mode: 'replace',
      selection: [{ candidate: correction, rank: 'normal' }],
      expected_head: null,
    },
    'acceptor',
  );
  expect(adopted).toHaveProperty('adoption');

  const read = await publicRead(recipe.id);
  expect(read.statements['schema:cookTime']![0]!.value.content).toMatchObject({ amount: '+30', unit: minute });
  const anonymous = await served(recipe);
  expect(anonymous.recipe).toMatchObject({ cookTime: 'PT30M' });
});
