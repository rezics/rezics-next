import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the owner Collection editor joins the browse route in AppShell and keeps pattern stories for detail cases', () => {
  const story = source('../src/stories/library-collection-editor.stories.tsx');
  const page = source('../src/stories/page.tsx');
  const root = source('../.storybook/route-root.tsx');

  expect(story).toContain("title: 'Patterns/Collection Editor'");
  expect(page).toContain("import '../../.storybook/route-root'");
  expect(root).toContain('return <AppShell>{children}</AppShell>');
  expect(story).not.toContain("import { AppShell } from '../shell/shell'");

  const exports = [...story.matchAll(/export const (\w+): Story =/g)];
  const scenarios = Object.fromEntries(
    exports.map((entry, index) => [entry[1]!, story.slice(entry.index, exports[index + 1]?.index ?? story.length)]),
  );
  expect(scenarios.OwnerEdit).toContain(
    '<PageStory visitor="Signed In" path={pagePaths[\'library-collection\']} credentialMode="session" />',
  );
  expect(scenarios.OwnerEdit).toContain("setCollectionStoryMode('private', true)");
  expect(scenarios.OwnerEdit).toContain("userEvent.keyboard('{Enter}')");
  expect(scenarios.OwnerEdit).toContain('m.library_collection_edit()');
  expect(scenarios.OwnerEdit).toContain('m.library_collection_save()');
  expect(scenarios.OwnerEdit).toContain('m.library_collection_title()');
  expect(scenarios.OwnerEdit).toContain('m.library_collection_cancel()');
  expect(scenarios.OwnerEdit).toContain("findByRole('main')");
  expect(scenarios.OwnerEdit).toContain('m.account_menu()');
  expect(scenarios.OwnerEdit).not.toContain('<PatternStory');
  expect(scenarios.OwnerEdit).not.toContain('<CollectionPage');
  expect(scenarios.Details).toContain('renderEditor()');
  expect(scenarios.Reordering).toContain('renderEditor()');
  expect(story).toContain('<PatternStory visitor="Signed In" path={pagePaths[\'library-collection\']}>');

  expect(story).toContain("window.matchMedia('(max-width: 767px)').matches");
  expect(story).toContain("window.matchMedia('(pointer: coarse)').matches");
  expect(story).not.toContain("matchMedia('(min-width: 640px)')");
});
