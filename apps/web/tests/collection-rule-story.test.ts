import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
  expect(exports.map((entry) => entry[1])).toEqual(['Draft', 'ActualCreate', 'PrivateUnavailable', 'Denied']);
  const scenarios = Object.fromEntries(
    exports.map((entry, index) => [entry[1]!, story.slice(entry.index, exports[index + 1]?.index ?? story.length)]),
  );
  for (const name of ['Draft', 'Denied']) {
    expect(scenarios[name]).toMatch(/<PatternStory\b[^>]*>\s*<AppShell>[\s\S]*<\/AppShell>\s*<\/PatternStory>/);
    expect(scenarios[name]).toContain("findByRole('main')");
  }
  expect(scenarios.ActualCreate).toContain('<PageStory visitor="Signed In" path="/library/rules/new" />');
  expect(scenarios.ActualCreate).toContain('play: pageReady');
  expect(scenarios.PrivateUnavailable).toContain(
    '<PageStory visitor="Signed In" path="/collections/saved-rule-unavailable/rule" />',
  );
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
  expect(story).toContain('choices: unavailableRuleChoices()');
  expect(story).toContain('current recorded preview at kernel.local');
  expect(story).toContain('do not establish native execution');
  expect(story).not.toMatch(/ok:\s*true|viewport|maxWidth/);
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
            csrfToken: '',
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
