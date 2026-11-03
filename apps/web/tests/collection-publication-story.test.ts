import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { answerFakeRoute } from '../src/kernel/fake-modules';
import { publicationStoryIds } from '../src/kernel/fake/collection-publication';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Collection publication Pages stories enter the publish route through PageStory without implying native publication', () => {
  const story = source('../src/stories/library-collection-publication.stories.tsx');
  const page = source('../src/stories/page.tsx');
  const root = source('../.storybook/route-root.tsx');
  const shell = source('../src/shell/shell.tsx');
  const sidebar = source('../../../packages/ui/src/shadcn/sidebar.tsx');
  const view = source('../src/library/collection-publication-page.tsx');

  expect(story).toContain("title: 'Pages/Library/Collection publication'");
  expect(story).toContain("import { PageStory, pageReady } from './page'");
  expect(page).toContain("import '../../.storybook/route-root'");
  expect(root).toContain('return <AppShell>{children}</AppShell>');
  expect(shell).toMatch(/<SidebarInset\s+id="main-content"/);
  expect(sidebar).toMatch(/function SidebarInset\b[\s\S]*?return\s*\(\s*<main\b/);
  expect(story).not.toMatch(/<main\b/);
  expect(view).not.toMatch(/<main\b/);
  expect(story).toContain("return within(within(canvasElement).getByRole('main'))");
  expect(story).toContain('<PageStory visitor="Signed In" path={`/collections/${id}/publish`} />');

  const exports = [...story.matchAll(/export const (\w+): Story =/g)];
  expect(exports.map((entry) => entry[1])).toEqual([
    'SelectedEmpty',
    'SelectedNonempty',
    'Denied',
    'Stale',
    'SourceUnavailable',
    'Retry',
  ]);
  const scenarios = Object.fromEntries(
    exports.map((entry, index) => [entry[1]!, story.slice(entry.index, exports[index + 1]?.index ?? story.length)]),
  );
  expect(scenarios.SelectedEmpty).toContain('publishRoute(publicationStoryIds.ready)');
  expect(scenarios.SelectedNonempty).toContain('publishRoute(publicationStoryIds.ready)');
  expect(scenarios.Denied).toContain('publishRoute(publicationStoryIds.denied)');
  expect(scenarios.Stale).toContain('publishRoute(publicationStoryIds.stale)');
  expect(scenarios.SourceUnavailable).toContain('publishRoute(publicationStoryIds.unavailable)');
  expect(scenarios.Retry).toContain('publishRoute(publicationStoryIds.retry)');
  for (const scenario of Object.values(scenarios)) {
    expect(scenario).toContain('play:');
    expect(scenario).toContain('expect(');
  }

  expect(story).toContain('Actual `/collections/$id/publish` PageStory coverage');
  expect(story).toContain('No positive publication provider.');
  expect(story).toContain('native publication and promoted-main proof remain pending.');
  expect(story).not.toMatch(/ok:\s*true/);
  expect(story).not.toContain('CollectionPublicationPageView');
});

test('publication story kernel answers recorded dynamic membership and only refused publishSelected outcomes', async () => {
  const origin = 'http://kernel.local';
  const read = async (id: string, members = false) =>
    answerFakeRoute('story', new Request(`${origin}/v1/collections/${id}${members ? '/members' : ''}`));
  const write = async (id: string) =>
    answerFakeRoute(
      'story',
      new Request(`${origin}/v1/collections/${encodeURIComponent(id)}:publishSelected`, { method: 'POST' }),
    );

  for (const id of Object.values(publicationStoryIds)) {
    const collection = await read(id);
    expect(collection).toMatchObject({
      status: 200,
      collection: {
        id,
        curatorAccountId: 'story-viewer',
        membershipKind: 'dynamic',
        revision: 7,
      },
    });
    expect(collection).not.toHaveProperty('collection.builtinKind');
    expect(JSON.stringify(collection)).not.toMatch(/note|generation|"ok":true/);
  }

  const members = await read(publicationStoryIds.ready, true);
  expect(members).toMatchObject({ status: 200, next: 'another-native-page' });
  expect(members?.members).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'dynamic',
        subjectId: expect.any(String),
        subject: expect.objectContaining({ id: expect.any(String) }),
      }),
    ]),
  );
  expect(JSON.stringify(members)).not.toMatch(/"note"|generation|"ok":true/);
  expect(await read(publicationStoryIds.unavailable, true)).toEqual({
    status: 503,
    code: 'dependency_unavailable',
  });

  expect(await write(publicationStoryIds.ready)).toEqual({ status: 503 });
  expect(await write(publicationStoryIds.denied)).toEqual({ status: 403 });
  expect(await write(publicationStoryIds.stale)).toEqual({ status: 409 });
  expect(await write(publicationStoryIds.retry)).toEqual({ status: 500 });
  expect(await write(publicationStoryIds.unavailable)).toBeUndefined();
});
