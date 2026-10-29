import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const app = join(import.meta.dir, '..');
const root = resolve(app, '../..');
const recorded = join(app, 'src/kernel/recorded');
mkdirSync(join(root, '.temp'), { recursive: true });
const temporary = mkdtempSync(join(root, '.temp/recorded-responses-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function recordings() {
  return existsSync(recorded) ? [...new Bun.Glob('**/*.json').scanSync({ cwd: recorded })].sort() : [];
}

async function command(args: string[], cwd = app) {
  const run = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

test('each recorded JSON response type-checks against the kernel client', async () => {
  const files = recordings();
  const module = join(temporary, 'recordings.ts');
  const source = [
    "import type { Kernel, KernelClient } from '@rezics/client';",
    'type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };',
    "type Read = Awaited<ReturnType<ReturnType<KernelClient['subjects']>['get']>>;",
    "type SubjectResponse = NonNullable<Read['data']>;",
    "type LinksRead = Awaited<ReturnType<ReturnType<KernelClient['subjects']>['links']['get']>>;",
    "type LinksResponse = NonNullable<LinksRead['data']>;",
    "type MissingResponse = Extract<NonNullable<Read['error']>, { status: 404 | '404' }>['value'];",
    "type SubjectReactionsResponse = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['reactions']['get']>>['data']>;",
    // The generated client declarations do not carry the subject's own-reaction route yet.
    "type SubjectOwnReactionResponse = { kind: 'like' | 'love' | 'laugh' | 'insightful' | 'sad' | null };",
    "type BoardResource = ReturnType<KernelClient['boards']>;",
    "type BoardResponse = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>;",
    "type BoardThreadsResponse = NonNullable<Awaited<ReturnType<BoardResource['threads']['get']>>['data']>;",
    "type AccountsResponse = NonNullable<Awaited<ReturnType<KernelClient['accounts']['get']>>['data']>;",
    // Eden merges threads/:id with threads/:threadId, so ReturnType of threads() has no get or posts.
    "type Routes = Kernel extends { '~Routes': infer Schema } ? Schema : never;",
    'type ThreadRoutes = Routes extends { v1: { threads: infer Threads } } ? Threads : never;',
    "type ThreadNode = ThreadRoutes extends { ':id': infer Node } ? Node : never;",
    'type ThreadResponse = ThreadNode extends { get: { response: { 200: infer Body } } } ? Body : never;',
    'type PostsResponse = ThreadNode extends { posts: { get: { response: { 200: infer Body } } } } ? Body : never;',
    "type SearchResponse = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;",
    "type FacetsResponse = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$facets']['post']>>['data']>;",
    'type DefinitionRoutes = Routes extends { v1: { definitions: infer Definitions } } ? Definitions : never;',
    'type DefinitionsActiveResponse = DefinitionRoutes extends { active: { get: { response: { 200: infer Body } } } } ? Body : never;',
    "type DefinitionsReleaseResponse = DefinitionRoutes extends { releases: { ':digest': { get: { response: { 200: infer Body } } } } } ? Body : never;",
    "type PageReadResult = Awaited<ReturnType<KernelClient['pages']['$read']['post']>>;",
    "type PageResponse = NonNullable<PageReadResult['data']>;",
    "type PageMissingResponse = Extract<NonNullable<PageReadResult['error']>, { status: 404 | '404' }>['value'];",
    "type Data<T extends Promise<{ data: unknown }>> = NonNullable<Awaited<T>['data']>;",
    "type SubjectRatingsResponse = Data<ReturnType<ReturnType<KernelClient['subjects']>['ratings']['get']>>;",
    "type SubjectSourceStatisticsResponse = Data<ReturnType<ReturnType<KernelClient['subjects']>['source-statistics']['get']>>;",
    "type SessionRoutes = ReturnType<KernelClient['progressSessions']>;",
    "type CollectionRoutes = ReturnType<KernelClient['collections']>;",
    "type LibraryEntriesResponse = Data<ReturnType<KernelClient['libraryEntries']['get']>>;",
    "type CollectionsResponse = Data<ReturnType<KernelClient['collections']['get']>>;",
    "type CollectionResponse = Data<ReturnType<CollectionRoutes['get']>>;",
    "type CollectionMembersResponse = Data<ReturnType<CollectionRoutes['members']['get']>>;",
    "type CopiesResponse = Data<ReturnType<KernelClient['copies']['get']>>;",
    "type FollowsResponse = Data<ReturnType<KernelClient['follows']['get']>>;",
    "type ProgressSessionsResponse = Data<ReturnType<KernelClient['progressSessions']['get']>>;",
    "type ProgressSessionResponse = Data<ReturnType<SessionRoutes['get']>>;",
    "type ProgressChangesResponse = Data<ReturnType<SessionRoutes['changes']['get']>>;",
    "type ProgressUnitsResponse = Data<ReturnType<SessionRoutes['completedUnits']['get']>>;",
    "type PublishedLogsResponse = Data<ReturnType<KernelClient['publishedLogs']['get']>>;",
    "type PublishedLogResponse = Data<ReturnType<ReturnType<KernelClient['publishedLogs']>['get']>>;",
    "type PreferencesResponse = Data<ReturnType<ReturnType<KernelClient['accounts']>['preferences']['get']>>;",
    "type SpaceAddressResponse = Data<ReturnType<ReturnType<KernelClient['spaceAddresses']>['get']>>;",
    "type SpaceResponse = Data<ReturnType<ReturnType<KernelClient['spaces']>['get']>>;",
    "type RealmRoutes = ReturnType<KernelClient['realms']>;",
    "type RealmResponse = Data<ReturnType<RealmRoutes['get']>>;",
    "type RealmBoardsResponse = Data<ReturnType<RealmRoutes['boards']['get']>>;",
    "type RealmPublicationsResponse = Data<ReturnType<RealmRoutes['publications']['get']>>;",
    "type RealmMemberResponse = Data<ReturnType<RealmRoutes['members']['me']['get']>>;",
    'type RealmSubjectsResponse = { subjects: Record<string, SubjectResponse> };',
    'type NoContentResponse = { status: 204 };',
    "type MyRealmsResponse = Data<ReturnType<KernelClient['me']['realms']['get']>>;",
    "type OfferResponse = Data<ReturnType<ReturnType<KernelClient['offers']>['get']>>;",
    "type OrderResponse = Data<ReturnType<ReturnType<KernelClient['orders']>['get']>>;",
  ];
  const responseType: Record<string, string> = {
    'accounts.json': 'AccountsResponse',
    'missing-subject.json': 'MissingResponse',
    'missing-subject-page.json': 'PageMissingResponse',
    'home-page.json': 'PageResponse',
    'agent-page.json': 'PageResponse',
    'agent-page-reader.json': 'PageResponse',
    'subject.json': 'SubjectResponse',
    'subject-uncovered.json': 'SubjectResponse',
    'subject-page.json': 'PageResponse',
    'subject-ratings.json': 'SubjectRatingsResponse',
    'subject-source-statistics.json': 'SubjectSourceStatisticsResponse',
    'zone-subject-page.json': 'PageResponse',
    'subject-reactions.json': 'SubjectReactionsResponse',
    'subject-reaction.json': 'SubjectOwnReactionResponse',
    'board.json': 'BoardResponse',
    'board-threads.json': 'BoardThreadsResponse',
    'thread.json': 'ThreadResponse',
    'thread-posts.json': 'PostsResponse',
    'search.json': 'SearchResponse',
    'search-empty.json': 'SearchResponse',
    'search-facets.json': 'FacetsResponse',
    'search-typed.json': 'SearchResponse',
    'definitions-active.json': 'DefinitionsActiveResponse',
    'definitions-release.json': 'DefinitionsReleaseResponse',
    'library-entries.json': 'LibraryEntriesResponse',
    'library-continue-entries.json': 'LibraryEntriesResponse',
    'library-collections.json': 'CollectionsResponse',
    'subject-links.json': 'LinksResponse',
    'library-collection.json': 'CollectionResponse',
    'library-collection-members.json': 'CollectionMembersResponse',
    'library-copies.json': 'CopiesResponse',
    'library-follows.json': 'FollowsResponse',
    'library-progress-sessions.json': 'ProgressSessionsResponse',
    'library-continue-progress-sessions.json': 'ProgressSessionsResponse',
    'library-progress-session.json': 'ProgressSessionResponse',
    'library-progress-changes.json': 'ProgressChangesResponse',
    'library-progress-units.json': 'ProgressUnitsResponse',
    'library-published-log.json': 'PublishedLogResponse',
    'library-published-logs.json': 'PublishedLogsResponse',
    'settings-preferences.json': 'PreferencesResponse',
    'space-address.json': 'SpaceAddressResponse',
    'space.json': 'SpaceResponse',
    'realm.json': 'RealmResponse',
    'realm-boards.json': 'RealmBoardsResponse',
    'realm-publications.json': 'RealmPublicationsResponse',
    'realm-member.json': 'RealmMemberResponse',
    'realm-subjects.json': 'RealmSubjectsResponse',
    'realm-participation.json': 'NoContentResponse',
    'my-realms.json': 'MyRealmsResponse',
    'offer.json': 'OfferResponse',
    'offer-cjk.json': 'OfferResponse',
    'offer-delisted.json': 'OfferResponse',
    'order-paid.json': 'OrderResponse',
    'order-pending.json': 'OrderResponse',
    'order-failed.json': 'OrderResponse',
    'thread-owned.json': 'ThreadResponse',
    'thread-owned-posts.json': 'PostsResponse',
    'board-realm.json': 'BoardResponse',
    'board-realm-realm.json': 'RealmResponse',
    'board-realm-threads.json': 'BoardThreadsResponse',
    'board-realm-thread.json': 'ThreadResponse',
    'board-realm-thread-posts.json': 'PostsResponse',
  };
  for (const file of files) {
    const name = basename(file).replace(/-(?:en|zh-Hans)\.json$/, '.json');
    const original = basename(file);
    if (name !== original && responseType[name]) responseType[original] = responseType[name]!;
  }
  const unmapped = files.filter((file) => !(basename(file) in responseType));
  expect(unmapped, `Recorded JSON files without a kernel response type: ${unmapped.join(', ')}`).toEqual([]);
  files.forEach((file, index) => {
    const path = join(recorded, file);
    const json = readFileSync(path, 'utf8').trim();
    source.push(`import recording${index} from ${JSON.stringify(path)};`);
    // JSON imports widen discriminants to string. Restore only the exact literal shape read from that same file.
    source.push(`const literal${index} = ${json} as const;`);
    source.push(`(recording${index} as Mutable<typeof literal${index}>) satisfies ${responseType[basename(file)]!};`);
  });
  writeFileSync(module, `${source.join('\n')}\n`);
  const config = join(temporary, 'tsconfig.json');
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(root, 'tsconfig.base.json'),
      compilerOptions: {
        resolveJsonModule: true,
        types: ['bun'],
        paths: { '@rezics/client': [join(root, 'packages/client/src/index.ts')] },
      },
      files: [module],
    }),
  );
  const run = await command([join(root, 'node_modules/.bin/tsc'), '--noEmit', '-p', config]);
  expect(run.code, run.output).toBe(0);
  expect(files, 'a successful empty compilation does not cover the recorded page responses').toEqual(
    expect.arrayContaining([
      'subject.json',
      'missing-subject.json',
      'board.json',
      'board-threads.json',
      'thread.json',
      'thread-posts.json',
      'search.json',
      'search-empty.json',
      'offer.json',
      'order-paid.json',
      'thread-owned.json',
    ]),
  );
}, 120_000);

test('the recorded response check is not in the page story test', () => {
  const pageStories = readFileSync(join(import.meta.dir, 'page-stories.test.ts'), 'utf8');
  expect(pageStories).not.toContain('each recorded response type-checks against the kernel client');
});
