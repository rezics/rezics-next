import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollectionRuleControls } from '../src/library/collection-rule-controls';
import { m } from '../src/paraglide/messages.js';
import { getLocale } from '../src/paraglide/runtime.js';

test('confirmed creation links to the saved rule instead of reloading a fresh create form', () => {
  const html = renderToStaticMarkup(
    <CollectionRuleControls
      creating
      pending={false}
      conflict={false}
      hasFilter
      savedId="saved/id"
      collectionId={null}
      refresh={() => {}}
    />,
  );
  expect(html).toContain(`href="/${getLocale()}/collections/saved%2Fid/rule"`);
  expect(html).toContain(m.library_rule_edit());
  expect(html).toContain(`href="/${getLocale()}/collections/saved%2Fid"`);
  expect(html).toMatch(/<button\b[^>]*type="submit"[^>]*\sdisabled=""/);
  expect(html).not.toContain(m.library_collection_reload());
});

test('a refused draft or saved revision still offers explicit recovery without enabling a conflict save', () => {
  for (const creating of [true, false]) {
    const html = renderToStaticMarkup(
      <CollectionRuleControls
        creating={creating}
        pending={false}
        conflict
        hasFilter
        savedId={null}
        collectionId={creating ? null : 'existing'}
        refresh={() => {}}
      />,
    );
    expect(html).toContain(m.library_collection_reload());
    expect(html).toMatch(/<button\b[^>]*type="submit"[^>]*\sdisabled=""/);
    expect(html).not.toContain(m.library_rule_edit());
  }
});
