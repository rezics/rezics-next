import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { fromPlainText } from '@rezics/document';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { RecipeCreateReview, RecipeCorrectionReview } = await import('../src/features/catalogue/recipe-editor-review');
const { recipeEvidence } = await import('../src/features/catalogue/recipe-editor');
const { recipeFixture, recipeExample } = await import('../src/kernel/fake/recipe-editor');
const part = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value' as const, content } });
const group = (id: string, content = 'https://cook.example/equal') => ({ parts: [part(id, content)] });
const locale = 'en';
const onJump = () => {};
function fixture(property = 'schema:recipeIngredient') {
  const { release } = recipeFixture();
  release.properties['schema:sameAs']!.labels = { ja: '同一の項目' };
  const statement = recipeExample().statements[property]![0]!;
  statement.references = [group('schema:url'), group('schema:sameAs'), group('schema:url'), { parts: [] }];
  statement.qualifiers = [part('unknown:original-property', 'unknown'), part('schema:inLanguage', 'en')];
  statement.rank = 'preferred';
  return {
    row: { id: 'retained-row', statement, definition: release.properties[property]! },
    read: { release, source: null, public: { related: {}, subject: { type: 'schema:Recipe' } } },
    locale,
    onJump,
    stale: false,
  };
}

test('create and correction preserve property meaning, rank, fallback language and ordered evidence', () => {
  const props = fixture();
  const before = JSON.stringify(props.row.statement);
  const created = render(<RecipeCreateReview {...props} terms={[]} rows={[props.row]} />);
  expect(created).toContain('<code class="break-all">schema:recipeIngredient</code>');
  expect(created).toContain('lang="ja">同一の項目');
  expect(created).toContain('unknown:original-property</code>');
  expect(created).toContain(m.candidate_rank_preferred());
  expect(created).toContain(m.facts_reuse_empty());
  const identifiers = [...created.matchAll(/<code[^>]*>(.*?)<\/code>/g)].map((entry) => entry[1]);
  expect(identifiers).toEqual([
    'schema:recipeIngredient',
    'unknown:original-property',
    'schema:inLanguage',
    'schema:url',
    'schema:sameAs',
    'schema:url',
  ]);
  const source = { ...structuredClone(props.row.statement), rank: 'deprecated' as const };
  source.references = [
    group('schema:url', 'https://cook.example/old'),
    group('schema:sameAs'),
    group('schema:url'),
    group('schema:url', 'https://cook.example/removed'),
    { parts: [] },
  ];
  props.row.statement.references.pop();
  const corrected = render(<RecipeCorrectionReview {...props} row={{ ...props.row, source }} />);
  const changes = corrected.slice(corrected.indexOf(`aria-label="${m.correction_references()}"`));
  expect(changes).toContain('https://cook.example/old');
  expect(changes).toContain('https://cook.example/equal');
  expect(changes).toContain('https://cook.example/removed');
  for (const label of [
    m.recipe_review_current(),
    m.recipe_review_statement(),
    m.recipe_evidence_edited(),
    m.recipe_evidence_retained(),
    m.recipe_evidence_removed(),
  ])
    expect(changes).toContain(label);
  expect(corrected).toContain(m.changes_rank_deprecated());
  props.row.statement.references.push({ parts: [] });
  expect(JSON.stringify(props.row.statement)).toBe(before);
  expect(render(<RecipeCorrectionReview {...props} />)).toContain(m.facts_no_value());
});

test('authored current and proposed documents retain safe bodies and only supplied originality', () => {
  const props = fixture('schema:recipeInstructions');
  const source = structuredClone(props.row.statement);
  source.value = part('unused', {
    language: 'en',
    licence: 'CC0-1.0',
    document: fromPlainText('Current instructions'),
  }).value;
  const html = render(<RecipeCorrectionReview {...props} row={{ ...props.row, source, original: true }} />);
  expect(html.match(/Current instructions/g)).toHaveLength(1);
  expect(html.match(/Simmer my lentils gently, then serve the soup\./g)).toHaveLength(1);
  expect(html.match(new RegExp(m.recipe_original(), 'g'))).toHaveLength(1);
  expect(html).not.toContain(m.correction_error_required());
  expect(html).toContain('CC0-1.0');
  expect(html).toContain('schema:sameAs</code>');
  props.row.statement.value = part('unused', {
    language: 'en',
    licence: 'CC0-1.0',
    document: { unsafe: '<script>bad</script>' },
  }).value;
  const invalid = render(<RecipeCreateReview {...props} rows={[{ ...props.row, original: false }]} terms={[]} />);
  expect(invalid).toContain(m.correction_error_invalid_format());
  expect(invalid).not.toContain('<script>');
  expect(invalid).toContain(m.facts_review_open_field());
  const scaffold: StatementInput = {
    ...props.row.statement,
    references: [
      { parts: [part('schema:url', '')] },
      {
        parts: [
          part('test:zero', 0),
          part('test:false', false),
          { property: { id: 'test:none' }, value: { type: 'novalue' } },
        ],
      },
    ],
  };
  expect(recipeEvidence(scaffold).references).toEqual(scaffold.references.slice(1));
});
