import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import { prepareStoryArcInitial, storyArcCreateProperties, storyArcCreateRowErrors, createStoryArcFactStore, storyArcCreateControl } from '../src/features/catalogue/story-arc-create-model';
import { storyArcType } from '../src/features/catalogue/story-arc-profile';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import { captureReuse, cloneReferenceGroup, reuseIsStale } from '../src/features/catalogue/reference-reuse';
import type { FactDraft } from '../src/features/catalogue/subject-facts';

const release = {
  types: {
    [storyArcType]: { properties: ['schema:name', 'schema:url', 'rezics:storyArc'] },
  },
  properties: {
    'schema:name': { datatype: 'monolingualtext', multivalued: true, qualifiers: [] },
    'schema:url': { datatype: 'url', multivalued: false, qualifiers: [] },
    'rezics:storyArc': {
      datatype: 'wikibase-item',
      multivalued: true,
      qualifiers: ['schema:position'],
      relation: { group: 'membership', order: 'position' },
    },
  },
} as unknown as Release;

function fact(id: string, property: string, content: unknown): { id: string; property: string; statement: StatementInput } {
  return {
    id,
    property,
    statement: {
      property: { id: property },
      value: { type: 'value', content },
      qualifiers: [],
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://source.example/story-arc' } },
            { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
          ],
        },
      ],
      rank: 'preferred',
    },
  };
}

const terms = {
  type: storyArcType,
  labels: { en: 'Arc', ja: '編' },
  descriptions: { ja: '物語の区間' },
  aliases: { en: ['Arc name'] },
};

test('StoryArc initial fields derive from exact released scalar admission', () => {
  expect(storyArcCreateProperties(release)).toEqual(['schema:name', 'schema:url']);
});

test('preparation preserves multilingual terms, full groups, normal rank, and unsupported entered evidence', () => {
  const store = createStoryArcFactStore();
  const name = fact('name-ja', 'schema:name', { text: '旅の編', language: 'ja' });
  const unsupported = fact('relation', 'rezics:storyArc', '123e4567-e89b-12d3-a456-426614174000');
  unsupported.statement.qualifiers = [
    { property: { id: 'schema:position' }, value: { type: 'value', content: '1' } },
  ];
  store.update([name, unsupported]);
  const result = prepareStoryArcInitial(terms, store.getSnapshot(), release, store);

  expect(result.item).toMatchObject({ labels: terms.labels, descriptions: terms.descriptions, aliases: terms.aliases });
  expect(result.item.statements?.['schema:name']?.[0]).toMatchObject({
    value: { type: 'value', content: { text: '旅の編', language: 'ja' } },
    rank: 'normal',
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://source.example/story-arc' } },
          { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
        ],
      },
    ],
  });
  expect(result.item.statements?.['rezics:storyArc']?.[0]?.qualifiers).toEqual(unsupported.statement.qualifiers);
  expect(result.errors).toEqual([{ pointer: '/statements/rezics:storyArc/0', code: 'unsupported' }]);
});

test('a property removed from the active release blocks creation and remains in the repair item', () => {
  const active = {
    ...release,
    types: { [storyArcType]: { properties: ['schema:name'] } },
  } as unknown as Release;
  const store = createStoryArcFactStore();
  const url = fact('url', 'schema:url', 'https://example.org/arc');
  store.update([url]);
  const prepared = prepareStoryArcInitial(terms, store.getSnapshot(), active, store);

  expect(prepared.errors).toEqual([{ pointer: '/statements/schema:url/0', code: 'unsupported' }]);
  expect(prepared.item.statements?.['schema:url']?.[0]?.value.content).toBe('https://example.org/arc');
});

test('reference reuse review is invalidated when its source or destination changes', () => {
  const source = fact('source', 'schema:url', 'https://example.org/arc');
  const destination = fact('destination', 'schema:sameAs', 'https://example.net/arc');
  const drafts: FactDraft[] = [source, destination].map((row) => ({
    holder: row.id,
    property: row.property,
    source: null,
    baseline: null,
    statement: row.statement,
    included: true,
  }));
  const reference = {
    holder: source.id,
    property: source.property,
    groupIndex: 0,
    snapshot: cloneReferenceGroup(source.statement.references[0]!),
  };
  const capture = captureReuse(reference, drafts);
  expect(reuseIsStale(reference, drafts, [destination.id], capture)).toBe(false);
  const changed = drafts.map((draft) =>
    draft.holder === destination.id
      ? { ...draft, statement: { ...draft.statement, references: [] } }
      : draft,
  );
  expect(reuseIsStale(reference, changed, [destination.id], capture)).toBe(true);
});

test('nested diagnostics follow holder identity through reorder and keep removed-holder addresses', () => {
  const store = createStoryArcFactStore();
  const first = fact('name-one', 'schema:name', { text: 'Arc one', language: 'en' });
  const second = fact('name-two', 'schema:name', { text: 'Arc two', language: 'en' });
  store.update([first, second]);
  const prepared = prepareStoryArcInitial(terms, store.getSnapshot(), release, store);
  const identity = store.identity(prepared.item)!;
  const errors = storyArcCreateRowErrors(
    [{ pointer: '/statements/schema:name/1/references/0/parts/1/value/content', code: 'invalid_format' }],
    second,
    identity,
  );
  expect(errors).toEqual([{ pointer: '/statement/references/0/parts/1/value/content', code: 'invalid_format' }]);
  expect(identity.byProperty['schema:name']).toEqual(['name-one', 'name-two']);

  const target = storyArcCreateControl(
    '/statements/schema:name/1/references/0/parts/1/value/content',
    release,
    'en',
    [first],
    identity,
  );
  expect(target?.id).toBe('name-two');
  expect(target?.id).not.toBe(first.id);
});
