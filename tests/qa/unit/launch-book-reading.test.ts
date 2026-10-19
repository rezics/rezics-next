import { expect, test } from 'bun:test';
import { classicChapterIdentity } from '../../../scripts/dev/seed/classics-text-step.ts';
import { prepareLaunchBookReading } from '../../../scripts/load/launch-book-reading.ts';
import type { CorpusApi } from '../../../scripts/load/work-profile-corpus.ts';

const actor = 'https://rezics.com/id/11111111-1111-4111-a111-111111111111';
const book = { work: 'https://rezics.com/id/22222222-2222-4222-a222-222222222222',
  mainVersion: 'https://rezics.com/id/33333333-3333-4333-a333-333333333333', workRevision: 'work-head' };

function fixture(failPublication = false) {
  const commands: Array<{ key: string; path: string; body: Record<string, unknown> }> = [];
  const grants = new Set<string>();
  let chapter = 0;
  const api: CorpusApi = {
    async read<T>() { return { revision: 'current-head' } as T; },
    async command<T>(key, command) {
      const body = command.body as Record<string, unknown>;
      commands.push({ key, path: command.path, body });
      let result: unknown = {};
      if (command.path === '/v1/agents') result = { agent: actor };
      if (command.path === '/v1/contributions') result = { contribution: 'contribution', draftRevision: 'draft' };
      if (command.path === '/v1/contribution-publications') {
        expect(grants.has('contribution.read:contribution:read:contribution')).toBe(true);
        result = { publicationDecision: 'main-publication' };
      }
      if (command.path === '/v1/compositions') result = { structure: 'composition', revision: 'composition-head' };
      if (command.path.endsWith('/chapters')) result = {
        post: classicChapterIdentity(book.work, actor, 'pride', chapter++).work, compositionRevision: `head-${chapter}`,
      };
      if (command.path === '/v1/rights/use-assessments') result = { assessmentId: 'rights-assessment' };
      if (command.path === '/v1/content-drafts') result = { revisionId: 'content-draft', byteDigest: 'content-digest',
        sourcePosition: { dataEpoch: 'content-epoch' } };
      if (command.path === '/v1/content-publications') result = failPublication
        ? { status: 'rejected' } : { status: 'active', decision: 'chapter-publication' };
      return result as T;
    },
  };
  return { api, commands, grants, authorize: async (scope: string, action: string) => { grants.add(`${action}:${scope}`); } };
}

test('launch reading retains genuine Gutenberg bodies with separate Main and Content rights', async () => {
  const f = fixture();
  const prepared = await prepareLaunchBookReading({ ...f, actor, book, token: 'fixture-token', signal: AbortSignal.timeout(10_000) });
  expect(prepared.chapters.length).toBeGreaterThanOrEqual(2);
  expect(prepared.chapters.every(chapter => chapter.body.length > 200)).toBe(true);
  expect(prepared.source.byteDigest).toBe('3f6bb9d6f78e0293b56acd4714dd68cb7d6d1d293402031ce9d5a216bcaf9d75');
  const drafts = f.commands.filter(command => command.path === '/v1/content-drafts');
  expect(drafts.map(command => command.body.body)).toEqual(prepared.chapters.map(chapter => chapter.body));
  expect(drafts.every(command => command.body.profile === 'content-public-domain-text-v1')).toBe(true);
  const selections = f.commands.filter(command => command.path === '/v1/publication-selections');
  expect(selections[0]!.body).toMatchObject({ contribution: 'contribution', publicationDecision: 'main-publication',
    context: { kind: 'main-version-default', id: book.mainVersion } });
  const eligibility = f.commands.filter(command => command.path === '/v1/content-search-eligibility');
  expect(eligibility).toHaveLength(prepared.chapters.length);
  expect(eligibility.every(command => command.body.profile === 'content-search-eligibility-v2'
    && command.body.rightsBasis === 'public-domain' && command.body.publicationDecision === 'chapter-publication')).toBe(true);
  expect(f.commands.some(command => command.body.profile === 'work-structure-publication-v1')).toBe(false);
  expect(f.commands.filter(command => command.path === '/v1/rights/use-assessments')
    .every(command => ['synopsis', 'body'].includes((command.body.material as { component: string }).component))).toBe(true);
});

test('an unpublished exact chapter cannot acquire a successful reading preparation', async () => {
  const f = fixture(true);
  await expect(prepareLaunchBookReading({ ...f, actor, book, token: 'fixture-token', signal: AbortSignal.timeout(10_000) }))
    .rejects.toThrow('not published');
  expect(f.commands.some(command => command.path === '/v1/content-search-eligibility')).toBe(false);
});
