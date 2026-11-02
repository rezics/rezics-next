import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { ConditionEditor } from '../src/search/condition-editor';
import { conditionMetadata } from '../src/search/condition-editor-model';

test('released statement and qualifier choices retain exact IDs beside colliding names', () => {
  const metadata = conditionMetadata(recording.release);
  metadata.properties['schema:author'] = {
    ...metadata.properties['schema:author']!,
    qualifiers: ['schema:isPartOf'],
  };
  const tree: FilterDocument = {
    and: [
      { statement: { property: 'wdt:P361', in: [''] } },
      {
        statement: {
          property: 'schema:author',
          in: [''],
          qualifiers: [{ property: 'wdt:P361', in: [''] }],
        },
      },
    ],
  };
  const saved = JSON.stringify(tree);
  const html = renderToStaticMarkup(
    createElement(ConditionEditor, { value: tree, metadata, locale: 'zh-Hans', issues: [], onChange() {} }),
  );
  const colliding = [...html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)]
    .map(([select]) => select)
    .filter((select) => select.includes('所属实体 (wdt:P361)') && select.includes('所属实体 (schema:isPartOf)'));

  expect(colliding).toHaveLength(2);
  for (const select of colliding) {
    expect(select).toContain('value="wdt:P361" selected="">所属实体 (wdt:P361)</option>');
    expect(select).toContain('value="schema:isPartOf">所属实体 (schema:isPartOf)</option>');
  }
  expect(JSON.stringify(tree)).toBe(saved);
});
