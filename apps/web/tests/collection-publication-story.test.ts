import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Collection publication Pages stories compose a real existing page shell and main or are honestly classified without implying native publication', () => {
  const story = source('../src/stories/library-collection-publication.stories.tsx');
  const shell = source('../src/shell/shell.tsx');
  const sidebar = source('../../../packages/ui/src/shadcn/sidebar.tsx');
  const page = source('../src/library/collection-publication-page.tsx');

  expect(story).toContain("title: 'Pages/Library/Collection publication'");
  expect(story).toContain("import { AppShell } from '../shell/shell'");
  expect(story).toContain(
    "import { CollectionPublicationPageView } from '../library/collection-publication-page'",
  );
  // The family decorator puts every existing render inside the same production shell.
  const decorators = story.slice(story.indexOf('decorators:'), story.indexOf('parameters:'));
  expect(decorators).toMatch(
    /<PatternStory\s+visitor="Signed In"\s+path=\{`\/collections\/\$\{publicationExample.address.id\}\/publish`\}>\s*<AppShell>\s*<Story\s*\/>\s*<\/AppShell>\s*<\/PatternStory>/,
  );
  expect(shell).toMatch(/<SidebarInset\s+id="main-content"/);
  expect(sidebar).toMatch(/function SidebarInset\b[\s\S]*?return\s*\(\s*<main\b/);
  expect(story).not.toMatch(/<main\b/);
  expect(page).not.toMatch(/<main\b/);
  expect(story).toContain("return within(await within(canvasElement).findByRole('main'))");

  const exports = [...story.matchAll(/export const (\w+): Story =/g)];
  expect(exports.map((entry) => entry[1])).toEqual([
    'SelectedEmpty',
    'SelectedNonempty',
    'Denied',
    'Stale',
    'SourceUnavailable',
    'Retry',
  ]);
  for (let index = 0; index < exports.length; index++) {
    const scenario = story.slice(exports[index]!.index, exports[index + 1]?.index ?? story.length);
    expect(scenario).toContain('render:');
    expect(scenario).toContain('play:');
    expect(scenario).toContain('expect(');
  }

  expect(story).toContain('Illustrative selection/refusal examples');
  expect(story).toContain('No positive publication provider.');
  expect(story).toContain('native publication and promoted-main proof remain pending.');
  expect(story).not.toMatch(/ok:\s*true/);
});
