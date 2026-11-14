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
    expect(html).toContain(m.library_rule_review_current_read());
    expect(html).toMatch(/<button\b[^>]*type="submit"[^>]*\sdisabled=""/);
    expect(html).not.toContain(m.library_rule_edit());
  }
});

test('uncertain creation and update name the original request even when save normally returns to results', () => {
  for (const creating of [true, false]) {
    const html = renderToStaticMarkup(
      <CollectionRuleControls
        creating={creating}
        pending={false}
        conflict={false}
        uncertain
        hasFilter
        savedId={null}
        collectionId={creating ? null : 'existing'}
        navigateAfterSave
        refresh={() => {}}
      />,
    );
    expect(html).toContain(
      creating ? m.library_rule_retry_create_original() : m.library_rule_retry_save_original(),
    );
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain(m.library_rule_save_and_view_results());
    expect(html).not.toContain(m.library_rule_create_and_view_results());
  }
});
