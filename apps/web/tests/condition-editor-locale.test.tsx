import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { ConditionEditor } from '../src/search/condition-editor';
import { CONDITION_POINTER, conditionMetadata } from '../src/search/condition-editor-model';
import { ConditionRangeInput } from '../src/search/condition-range-input';

test('condition editor labels and errors follow the explicit reader locale while ambient English differs', () => {
  const previous = getLocale();
  setLocale('en', { reload: false });
  try {
    const locale = 'ja';
    const options = { locale };
    const languages = ['zh-Hant', 'fr'];
    const metadata = conditionMetadata(recording.release);
    metadata.filters = { 'things/one': { filter: { type: { in: ['schema:Book'] } } } };
    const tree: FilterDocument = {
      and: [
        { statement: { property: 'schema:wordCount', range: { gte: 12, unit: '1' } } },
        { saved: 'things/one' },
      ],
    };
    const pointer = `${CONDITION_POINTER}/and/0/statement/range/gte`;
    const html = renderToStaticMarkup(
      createElement(ConditionEditor, {
        value: tree,
        metadata,
        locale,
        languages,
        issues: [{ pointer, code: 'invalid_format' }],
        onChange() {},
        onLanguages() {},
      }),
    );
    expect(html).toContain(m.condition_heading({}, options));
    expect(html).not.toContain(m.condition_heading());
    expect(html).toContain(m.condition_languages_label({}, options));
    expect(html).toContain(m.refinement_lower({}, options));
    expect(html).toContain(m.condition_saved_filter_reference({}, options));
    expect(html).toContain(
      m.search_reader_condition_format({ field: m.refinement_lower({}, options) }, options),
    );
    expect(html).not.toContain(m.search_reader_condition_format({ field: m.refinement_lower() }));
    expect([...html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)].map((match) => match[1]!.trim())).toEqual([
      'zh-Hant',
      'fr',
    ]);

    const range = renderToStaticMarkup(
      createElement(ConditionRangeInput, {
        value: 12,
        draft: { current: { raw: '1e+', value: 12 } },
        datatype: 'quantity',
        label: m.refinement_lower({}, options),
        locale,
        onValue() {},
        id: 'range-draft',
        'aria-invalid': false,
      }),
    );
    expect(range).toContain(
      m.search_reader_condition_format({ field: m.refinement_lower({}, options) }, options),
    );
    expect(range).not.toContain(m.search_reader_condition_format({ field: m.refinement_lower() }));
    expect(getLocale()).toBe('en');
  } finally {
    setLocale(previous, { reload: false });
  }
});
