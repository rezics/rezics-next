import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFilter, type FilterDocument, type FilterStatement } from '@rezics/filter';
import type { ConditionMetadata } from '../src/search/condition-editor-model';
import {
  conditionConceptProperty,
  conditionConceptSelection,
  conditionConceptSuggestionFilter,
  conditionConceptReferenceFor,
  parseConditionConceptReference,
} from '../src/search/condition-concept-model';
import { changeStatementProperty } from '../src/search/condition-property-edit';
import { ConditionConceptPicker } from '../src/search/condition-concept-picker';
import { PredicateDescription } from '../src/search/search-context/predicate';

const metadata: ConditionMetadata = {
  types: {
    'skos:Concept': {},
    'app:Genre': { bases: ['skos:Concept'] },
    'app:Work': {},
  },
  properties: {
    'schema:genre': {
      datatype: 'wikibase-item',
      relation: { group: 'classification' },
      targets: ['skos:Concept'],
    },
    'schema:keywords': {
      datatype: 'wikibase-item',
      relation: { group: 'classification' },
      targets: ['skos:Concept'],
    },
    'schema:name': { datatype: 'string' },
  },
};

const lookup = {
  enabled: false,
  blocked: 'scope' as const,
  releaseDigest: 'release-current',
  key: 'current-reader-locale-request',
};
type ConceptDocument = { statement: Extract<FilterStatement, { in: readonly string[] }> };

describe('Search Concept conditions', () => {
  it('admits only released Concept classification properties and derives suggestion types from inheritance', () => {
    expect(conditionConceptProperty(metadata.properties['schema:genre'])).toBe(true);
    expect(conditionConceptProperty(metadata.properties['schema:name'])).toBe(false);
    expect(conditionConceptSuggestionFilter(metadata)).toBe(
      JSON.stringify({ type: { in: ['skos:Concept', 'app:Genre'] } }),
    );
  });

  it('writes exact and descendant meaning explicitly while retaining same-statement qualifiers', () => {
    const original: FilterDocument = {
      statement: {
        property: 'schema:genre',
        in: ['concept-old'],
        qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
      },
    };
    const exact = conditionConceptSelection(original, 'concept-new', 'scheme-a', false);
    const descendants = conditionConceptSelection(original, 'concept-new', 'scheme-a', true);
    expect(exact).toEqual({
      statement: {
        property: 'schema:genre',
        in: ['concept-new'],
        concept: { scheme: 'scheme-a', includeChildren: false },
        qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
      },
    });
    expect(descendants).toEqual({
      statement: {
        property: 'schema:genre',
        in: ['concept-new'],
        concept: { scheme: 'scheme-a', includeChildren: true },
        qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
      },
    });
    expect(parseFilter(JSON.parse(JSON.stringify(descendants)))).toEqual(descendants);
  });

  it('keeps native meaning when moving between admitted tag properties and requires confirmation to leave them', () => {
    const existing: FilterDocument = {
      statement: {
        property: 'schema:genre',
        in: ['concept-a'],
        concept: { scheme: 'scheme-a', includeChildren: true },
        qualifiers: [{ property: 'rezics:spoilerLevel', in: ['2'] }],
      },
    };
    expect(changeStatementProperty(existing, 'schema:keywords', metadata.properties)).toMatchObject({
      requiresConfirmation: false,
      next: existing,
    });
    expect(changeStatementProperty(existing, 'schema:name', metadata.properties).requiresConfirmation).toBe(true);
  });

  it('shows a retained shared filter with its scheme and exact or descendant meaning while lookups are closed', () => {
    const exact: ConceptDocument = {
      statement: { property: 'schema:genre', in: ['concept-a'], concept: { scheme: 'scheme-a' } },
    };
    const descendants: ConceptDocument = {
      statement: {
        property: 'schema:genre',
        in: ['concept-a'],
        concept: { scheme: 'scheme-a', includeChildren: true },
      },
    };
    const render = (value: ConceptDocument) =>
      renderToStaticMarkup(
        <ConditionConceptPicker value={value} lookup={lookup} locale="en" disabled onChange={() => {}} />,
      );
    expect(render(exact)).toContain('Scheme scheme-a · Exact Concept');
    expect(render(descendants)).toContain('Scheme scheme-a · This Concept and its admitted descendants');
  });

  it('does not reuse a label or identity after a reader or current Concept replacement', () => {
    const stale = { status: 'ready' as const, id: 'concept-old', label: 'Old label', schemes: [{ id: 'scheme-a' }] };
    expect(conditionConceptReferenceFor('concept-new', stale)).toBeUndefined();
    expect(parseConditionConceptReference(stale, 'concept-new')).toEqual({
      status: 'unavailable',
      id: 'concept-new',
    });
  });

  it('explains exact and descendant execution in the result predicate', () => {
    const describe = (includeChildren: boolean) =>
      renderToStaticMarkup(
        <PredicateDescription
          value={{
            statement: {
              property: 'schema:genre',
              in: ['concept-a'],
              concept: { scheme: 'scheme-a', includeChildren },
            },
          }}
          locale="en"
          label={(id) => ({ 'schema:genre': 'Genre', 'concept-a': 'Drama', 'scheme-a': 'Film genres' })[id] ?? id}
        />,
      );
    expect(describe(false)).toContain('Scheme Film genres: Exact Concept');
    expect(describe(true)).toContain('Scheme Film genres: This Concept and its admitted descendants');
  });
});
