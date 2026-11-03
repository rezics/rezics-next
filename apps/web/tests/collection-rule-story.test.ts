import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { savedRuleReadyId, savedRuleUnavailableId } from '../src/kernel/fake/collection-rules';
import { CollectionRuleEditor } from '../src/library/collection-rule-editor';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Collection rule editor Pages stories have a genuine existing page shell main while denied and unavailable rule bodies stay private and truthful', () => {
  const story = source('../src/stories/library-collection-rule.stories.tsx');
  const page = source('../src/stories/page.tsx');
  const root = source('../.storybook/route-root.tsx');
  const shell = source('../src/shell/shell.tsx');
  const sidebar = source('../../../packages/ui/src/shadcn/sidebar.tsx');
  const editor = source('../src/library/collection-rule-editor.tsx');
  const fake = source('../src/kernel/fake/collection-rules.ts');

  expect(story).toContain("title: 'Pages/Library/Collection rule'");
  expect(story).toContain("import { AppShell } from '../shell/shell'");
  expect(shell).toMatch(/<SidebarInset\s+id="main-content"/);
  expect(sidebar).toMatch(/function SidebarInset\b[\s\S]*?return\s*\(\s*<main\b/);
  expect(story).not.toMatch(/<main\b/);
  expect(editor).not.toMatch(/<main\b/);

  // The routed examples already receive the production shell from PageStory's root.
  expect(page).toContain("import '../../.storybook/route-root'");
  expect(root).toContain('return <AppShell>{children}</AppShell>');
  const exports = [...story.matchAll(/export const (\w+): Story =/g)];
  expect(exports.map((entry) => entry[1])).toEqual([
    'Draft',
    'ActualCreate',
    'ActualReady',
    'PrivateUnavailable',
    'Denied',
  ]);
  const scenarios = Object.fromEntries(
    exports.map((entry, index) => [entry[1]!, story.slice(entry.index, exports[index + 1]?.index ?? story.length)]),
  );
  for (const name of ['Draft', 'Denied']) {
    expect(scenarios[name]).toMatch(/<PatternStory\b[^>]*>\s*<AppShell>[\s\S]*<\/AppShell>\s*<\/PatternStory>/);
    expect(scenarios[name]).toContain("findByRole('main')");
  }
  expect(scenarios.ActualCreate).toContain('<PageStory visitor="Signed In" path="/library/rules/new" />');
  expect(scenarios.ActualCreate).toContain('pageReady');
  expect(scenarios.ActualCreate).toContain("name: m.library_collection_create()");
  expect(scenarios.ActualCreate).toContain('toBeInvalid()');
  expect(scenarios.ActualReady).toContain('path={`/collections/${savedRuleReadyId}/rule`}');
  expect(scenarios.ActualReady).toContain("name: m.library_rule_edit()");
  expect(scenarios.ActualReady).toContain("main.querySelector('form')");
  expect(scenarios.ActualReady).toContain("name: m.library_rule_members()");
  expect(scenarios.PrivateUnavailable).toContain('path={`/collections/${savedRuleUnavailableId}/rule`}');
  for (const [name, message] of [
    ['Denied', 'library_rule_denied'],
    ['PrivateUnavailable', 'library_rule_unavailable'],
  ] as const) {
    const scenario = scenarios[name];
    expect(scenario).toContain('within(main)');
    expect(scenario).toContain(`toHaveTextContent(m.${message}())`);
    expect(scenario).toContain(`getByText(m.${message}())).toBeVisible()`);
    expect(scenario).toContain("main.querySelector('form, input, select, textarea')");
    expect(scenario).toContain("queryByRole('link', { name: m.library_rule_members() })");
    expect(scenario).toContain('userEvent.click');
  }
  expect(fake).toContain("status: 200, rule: savedRule");
  expect(fake).toContain("code: 'dependency_unavailable'");
  expect(fake).not.toMatch(/members:\s*\[/);
  expect(story).toContain('choices: unavailableRuleChoices()');
  expect(story).toContain('current recorded preview at kernel.local');
  expect(story).toContain('do not establish native execution');
  expect(story).not.toMatch(/ok:\s*true|viewport|maxWidth/);
});

test('saved-rule preview answers the delivered GET schema and refuses invented write or member execution', async () => {
  const fetch = createStoryRecordedKernelFetch();
  const rule = await fetch(`http://kernel.local/v1/collections/${savedRuleReadyId}/rule`);
  expect(rule.status).toBe(200);
  const body = (await rule.json()) as { rule: Record<string, unknown>; collection?: unknown };
  expect(body.collection).toBeUndefined();
  expect(body.rule).toMatchObject({
    filter: { and: [{ owner: { presence: true } }, { type: { in: ['schema:Book'] } }] },
    sort: 'id',
    revision: 1,
    collectionRevision: 1,
    sourceGeneration: '1',
  });
  expect(String(body.rule.releaseDigest)).toMatch(/^sha256:/);
  const collection = await fetch(`http://kernel.local/v1/collections/${savedRuleReadyId}`);
  expect(collection.status).toBe(200);
  const metadata = (await collection.json()) as { collection: Record<string, unknown> };
  expect(metadata.collection).toMatchObject({
    id: savedRuleReadyId,
    title: 'Private saved definition',
    membershipKind: 'dynamic',
  });
  expect(metadata.collection).not.toHaveProperty('rule');
  expect(metadata.collection).not.toHaveProperty('filter');
  expect((await fetch(`http://kernel.local/v1/collections/${savedRuleReadyId}/rule`, { method: 'PUT' })).status).toBe(
    503,
  );
  expect((await fetch(`http://kernel.local/v1/collections/${savedRuleReadyId}/members`)).status).not.toBe(200);
  expect((await fetch(`http://kernel.local/v1/collections/${savedRuleUnavailableId}/rule`)).status).toBe(503);
});

test('refused rule bodies render only the localized refusal and retry without an editable definition', () => {
  const previous = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      for (const state of ['denied', 'unavailable'] as const) {
        const html = renderToStaticMarkup(
          createElement(CollectionRuleEditor, {
            page: { state },
            viewerId: 'owner',
            collectionId: 'saved',
            admitted: ['collection_rule.get', 'collection_rule.update'],
            csrfToken: 'current-csrf',
            save: async () => ({ ok: false, reason: 'unavailable' }),
            reload: async () => ({ state }),
          }),
        );
        const expectedMessage = state === 'denied' ? m.library_rule_denied() : m.library_rule_unavailable();
        const otherMessage = state === 'denied' ? m.library_rule_unavailable() : m.library_rule_denied();
        expect(html).toContain('role="alert"');
        expect(html).toContain(renderToStaticMarkup(createElement('p', null, expectedMessage)));
        expect(html).not.toContain(renderToStaticMarkup(createElement('p', null, otherMessage)));
        expect(html).toContain(m.library_follow_retry());
        expect(html).not.toMatch(/<(?:form|input|select|textarea|a)\b/);
        expect(html).not.toContain(m.library_rule_members());
      }
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});
