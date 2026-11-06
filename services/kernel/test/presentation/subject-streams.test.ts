import { expect, test } from 'bun:test';
import { planReads, platformRegistry, resolveView, type CompositionDocument } from '@rezics/composition';
import { bundledRelease } from '@rezics/definitions/bundled';
import { platformProfile } from '../../src/presentation/setup';
import { selectSubjectStream, subjectStreams } from '../../src/presentation/subject-streams';

const subject = '018f0000-0000-7000-8000-00a000000001';
const profile = platformProfile();
function document(type: string, view: 'credits' | 'works' | 'contents') {
  return resolveView(profile, { type, bases: bundledRelease.types[type]!.bases }, view)!.document;
}

test('shipped work and inverse credit views retain every released role and select one bounded native stream', () => {
  const roles = Object.entries(bundledRelease.properties)
    .filter(([, property]) => property.relation?.group === 'credit')
    .map(([id]) => id)
    .sort();
  for (const [type, view, direction] of [
    ['schema:Book', 'credits', 'forward'],
    ['schema:Person', 'works', 'inverse'],
    ['schema:Organization', 'works', 'inverse'],
    ['wd:Q20631656', 'credits', 'forward'],
  ] as const) {
    const doc = document(type, view);
    const entries = subjectStreams(doc, { subject });
    expect(entries.map(({ property }) => property).sort()).toEqual(roles);
    expect(entries.every((entry) => entry.direction === direction)).toBe(true);
    const defaultSelection = selectSubjectStream(entries, undefined, undefined)!;
    expect(defaultSelection.selected).toBe(entries[0]!.node);
    for (const entry of entries) {
      const selection = selectSubjectStream(entries, entry.node, undefined)!;
      expect(selection.selected).toBe(entry.node);
      const plan = planReads(platformRegistry, doc, { subject });
      expect(plan.reads[plan.nodes[selection.selected!]!]).toMatchObject({
        kind: direction === 'inverse' ? 'links' : 'relations',
        id: subject,
        property: entry.property,
        limit: 8,
      });
    }
    expect(selectSubjectStream(entries, undefined, entries.at(-1)!.node)?.selected).toBe(entries.at(-1)!.node);
    const last = entries.at(-1)!;
    expect(selectSubjectStream(entries, undefined, undefined, { [last.property]: 3 })?.selected).toBe(
      direction === 'forward' ? last.node : entries[0]!.node,
    );
  }
});

test('book parts and episodic contents keep distinct released streams without inventing an order', () => {
  const doc = document('schema:Book', 'contents');
  const entries = subjectStreams(doc, { subject });
  expect(entries.map(({ property }) => property)).toEqual(['wdt:P361', 'schema:isPartOf']);
  expect(selectSubjectStream(entries, undefined, undefined)?.selected).toBeUndefined();
  expect(selectSubjectStream(entries, 'episodes', undefined)?.selected).toBe('episodes');
  const before = structuredClone(doc);
  subjectStreams(doc, { subject });
  expect(doc).toEqual(before);
});

test('a nested native full stream is discovered once while a preview remains a shared subject read', () => {
  const doc: CompositionDocument = {
    root: { props: {} },
    content: [
      {
        type: 'Stack',
        props: {
          id: 'body',
          children: [
            { type: 'Credits', props: { id: 'preview', direction: 'forward', property: 'schema:director', limit: 4 } },
            {
              type: 'Credits',
              props: { id: 'directors', direction: 'forward', property: 'schema:director', limit: 8, paged: true },
            },
          ],
        },
      },
    ],
  };
  const entries = subjectStreams(doc, { subject });
  expect(entries).toEqual([{ node: 'directors', property: 'schema:director', direction: 'forward' }]);
  const plan = planReads(platformRegistry, doc, { subject });
  expect(plan.reads[plan.nodes.preview!]).toEqual({ kind: 'subject', id: subject });
  expect(selectSubjectStream([], undefined, undefined)).toBeUndefined();
});

test('native HTTP selection returns the exact qualified relation window and rejects foreign stream input', async () => {
  const { createSemanticDriver } = await import('../semantic/outcome-driver');
  const driver = await createSemanticDriver(undefined, { strictCleanup: true });
  const key = () => ({ 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) });
  try {
    const person = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      { type: 'schema:Person', labels: { en: 'Mira Quill' } },
      key(),
    );
    expect(person.status, JSON.stringify(person.body)).toBe(201);
    const personId = (person.body.subject as { id: string }).id;
    const statement = {
      property: { id: 'schema:director' },
      value: { type: 'value', content: personId },
      qualifiers: [
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'M. Lantern' } },
        { property: { id: 'schema:position' }, value: { type: 'value', content: { amount: '+7', unit: '1' } } },
      ],
      references: [
        {
          parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/credits' } }],
        },
      ],
    };
    const work = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      { type: 'schema:VideoGame', labels: { en: 'Lantern Voyage' }, statements: { 'schema:director': [statement] } },
      key(),
    );
    expect(work.status, JSON.stringify(work.body)).toBe(201);
    const id = (work.body.subject as { id: string }).id;
    const target = { subject: id, view: 'credits' };
    const initial = await driver.request('anonymous', 'POST', '/v1/pages:read', { target });
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body.streams).toMatchObject({ selected: 'credit-schema-director' });
    const selected = await driver.request('editor', 'POST', '/v1/pages:read', {
      target,
      stream: 'credit-schema-director',
      languages: ['en'],
    });
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    const body = selected.body as unknown as {
      streams: { selected: string };
      document: CompositionDocument;
      reads: Record<
        string,
        {
          status: number;
          body: { relations?: { target: string; statement: { qualifiers: unknown[]; references: unknown[] } }[] };
        }
      >;
    };
    expect(body.streams.selected).toBe('credit-schema-director');
    expect(body.document).toEqual(document('schema:VideoGame', 'credits'));
    const plan = planReads(platformRegistry, body.document, { subject: id });
    const result = body.reads[plan.nodes['credit-schema-director']!]!;
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.relations).toHaveLength(1);
    expect(result.body.relations![0]!.target).toBe(personId);
    expect(result.body.relations![0]!.statement.qualifiers).toEqual([
      expect.objectContaining({
        property: expect.objectContaining({ id: 'wdt:P1932' }),
        value: statement.qualifiers[0]!.value,
      }),
      expect.objectContaining({
        property: expect.objectContaining({ id: 'schema:position' }),
        value: statement.qualifiers[1]!.value,
      }),
    ]);
    expect(result.body.relations![0]!.statement.references).toHaveLength(1);
    for (const [name, descriptor] of Object.entries(plan.reads))
      if (descriptor.kind === 'relations' && name !== plan.nodes['credit-schema-director'])
        expect(body.reads[name]?.status).toBe(204);
    for (const request of [
      { target, stream: 'not-a-released-node' },
      { target: { subject: id }, stream: 'credit-schema-director' },
      { target, stream: 'credit-schema-director', continuation: { node: 'credit-schema-author', cursor: 'opaque' } },
    ]) {
      const rejected = await driver.request('anonymous', 'POST', '/v1/pages:read', request);
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
      expect(rejected.body.code).toBe('invalid_request');
    }
  } finally {
    await driver.close();
  }
}, 120_000);
