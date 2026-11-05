import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { subjectHref } from '../src/subject/subject-href.ts';
import { startNativeWebStack, type NativeWebStack } from './native/stack';

// Global Context (services/kernel/src/semantic/definitions.ts). Not imported: that module loads Kernel SQL before the
// native stack registers its loader.
const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
const marker = `journeyquote${crypto.randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
const original = 'I will return.';
const corrected = 'I will return soon.';
const source = (id: string, content: unknown) => ({
  property: { id },
  value: { type: 'value', content },
  references: [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/journey-quotation' } },
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
let work: Subject;
let speaker: Subject;
let quotation: Subject;

beforeAll(async () => {
  stack = await startNativeWebStack();
  work = (await command('/v1/subjects', { type: 'schema:Book', labels: { en: `${marker} work` } })).subject;
  speaker = (await command('/v1/subjects', { type: 'wd:Q95074', labels: { en: `${marker} speaker` } })).subject;
  quotation = (
    await command('/v1/subjects', {
      type: 'schema:Quotation',
      labels: { en: original },
      statements: {
        'schema:text': [
          source('schema:text', { language: 'en', document: fromPlainText(original), licence: 'CC-BY-4.0' }),
        ],
        'schema:about': [source('schema:about', work.id)],
        'schema:spokenByCharacter': [source('schema:spokenByCharacter', speaker.id)],
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
    status: path === '/v1/subjects' || path.endsWith('/candidates') ? 201 : 200,
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

async function served(path: string, persona?: string) {
  const response = await stack.request(`${stack.web}${path}`, persona);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  return (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
}

async function publicRead(id: string) {
  const response = await stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { subject: Subject }).subject;
}

test('the original Quotation is admitted through the real API with text, work and speaker', async () => {
  const read = await publicRead(quotation.id);
  expect(read.type).toBe('schema:Quotation');
  expect(read.statements['schema:about']![0]!.value.content).toBe(work.id);
  expect(read.statements['schema:spokenByCharacter']![0]!.value.content).toBe(speaker.id);
  const text = read.statements['schema:text']![0]!.value.content as { document: string; language: string };
  expect(text.language).toBe('en');
  const oracle = await stack.kernel(`/v1/documents/${text.document}`);
  expect(oracle.status).toBe(200);
  const { document } = (await oracle.json()) as { document: { language: string; body: unknown } };
  expect(document.language).toBe('en');
  expect(document.body).toEqual(fromPlainText(original));
});

test('anonymous and signed-in Quotation pages show its body, and the companion lists it from the work', async () => {
  const anonymous = await served(href(quotation));
  const alice = await served(href(quotation), 'alice');
  expect(anonymous).toContain(original);
  expect(alice).toContain(original);
  const companion = await served(`${href(work)}/quotations?quote=${quotation.id}`);
  expect(companion).toContain(original);
});

test('the linked work serves and the Quotation serves again after returning', async () => {
  expect((await stack.request(`${stack.web}${href(work)}`)).status).toBe(200);
  expect(await served(href(quotation), 'alice')).toContain(original);
});

test('a signed-in body correction is proposed, accepted, adopted and read back publicly', async () => {
  const proposed = await write(
    `/v1/subjects/${quotation.id}/candidates`,
    {
      statement: source('schema:text', {
        language: 'en',
        document: fromPlainText(corrected),
        licence: 'CC-BY-4.0',
      }),
    },
    'alice',
  );
  const candidate = proposed.candidate as string;
  const accepted = await write(
    `/v1/subjects/${quotation.id}/candidates/${candidate}:accept`,
    { context: GLOBAL_CONTEXT, expected_head: null },
    'steward',
  );
  expect(accepted).toMatchObject({ acceptance: { candidate, decision: 'accept' } });
  const adopted = await write(
    `/v1/subjects/${quotation.id}:adopt`,
    {
      context: GLOBAL_CONTEXT,
      property: 'schema:text',
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    },
    'acceptor',
  );
  expect(adopted).toHaveProperty('adoption');

  const read = await publicRead(quotation.id);
  const text = read.statements['schema:text']![0]!.value.content as { document: string };
  const oracle = (await (await stack.kernel(`/v1/documents/${text.document}`)).json()) as {
    document: { body: unknown };
  };
  expect(oracle.document.body).toEqual(fromPlainText(corrected));
  expect(await served(href(quotation))).toContain(corrected);
});
