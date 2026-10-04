import { expect, test } from 'bun:test';
import { publishClassicChapters, classicChapterIdentity, ensureClassicBookType } from '../../../scripts/dev/seed/classics-text-step.ts';
import { adoptClassic } from '../../../scripts/dev/seed/classics-step.ts';
import { SeedApiError, type SeedApi } from '../../../scripts/dev/seed/api.ts';
import type { WorkReceipt } from '../../../scripts/dev/seed/state.ts';

const actor = 'https://rezics.com/id/11111111-1111-4111-a111-111111111111';
const target: WorkReceipt = { work: 'https://rezics.com/id/22222222-2222-4222-a222-222222222222',
  mainVersion: 'https://rezics.com/id/33333333-3333-4333-a333-333333333333',
  workRevision: 'work-head', mainRevision: 'main-head', replayed: false };

test('Gutenberg seed: English adoption requests a known title language and replays legacy untyped adoptions', async () => {
  const requests: unknown[] = [];
  const keys: string[] = [];
  let legacy = false;
  const post: SeedApi['post'] = async <T>(_path: string, body: unknown, _token: string, key: string) => {
    requests.push(body); keys.push(key);
    if (legacy && (body as { titleLanguage?: string }).titleLanguage === 'en') {
      throw new SeedApiError('adoption', 409, 'idempotency conflict');
    }
    return { adoption: target, replayed: legacy } as T;
  };
  const proposal = { proposal: 'proposal', observation: 'observation', conversion: 'conversion',
    candidateTitle: 'Pride and Prejudice' };
  await adoptClassic({ post }, '/adoption', proposal, 'pride', actor, 'operator-token');
  expect(requests[0]).toMatchObject({ titleLanguage: 'en', confirmedTitle: 'Pride and Prejudice' });
  legacy = true;
  const replay = await adoptClassic({ post }, '/adoption', proposal, 'pride', actor, 'operator-token');
  expect(replay.adoption.work).toBe(target.work);
  expect(requests[2]).not.toHaveProperty('titleLanguage');
  expect(new Set(keys).size).toBe(1);
});

test('Gutenberg seed: the operator states Book for the current revision once, without changing identity', async () => {
  let current = { revision: target.workRevision, types: [] as string[] };
  const writes: unknown[] = [];
  const put: SeedApi['put'] = async <T>(path: string, body: unknown, token: string) => {
    expect(path).toBe(`/v1/works/${target.work.slice(-36)}/type`);
    expect(token).toBe('operator-token');
    writes.push(body);
    current = { revision: 'typed-head', types: ['https://schema.org/Book'] };
    return {} as T;
  };
  const input = { read: async () => current, api: { put }, book: 'pride', work: target.work,
    actor, token: 'operator-token' };
  await ensureClassicBookType(input);
  await ensureClassicBookType(input);
  expect(writes).toEqual([{ profile: 'work-type-v1', expectedHead: target.workRevision,
    types: ['https://schema.org/Book'], actingSubject: actor }]);
});

test('Gutenberg seed: a lost chapter response replays original intents without duplicate chapters or assessments', async () => {
  const ledger = new Map<string, { body: unknown; result: unknown }>();
  const chapterBodies: Record<string, unknown>[] = [];
  const drafts: Record<string, unknown>[] = [];
  const assessments: Record<string, unknown>[] = [];
  const eligibilities: Record<string, unknown>[] = [];
  let loseResponse = true;
  const post: SeedApi['post'] = async <T>(path: string, body: unknown, token: string, key: string): Promise<T> => {
    expect(token).toBe('editor-token');
    const prior = ledger.get(key);
    if (prior) { expect(body).toEqual(prior.body); return prior.result as T; }
    const value = body as Record<string, unknown>;
    let result: unknown;
    if (path === '/v1/compositions') result = { structure: 'composition', revision: 'empty-head' };
    else if (path.endsWith('/chapters')) {
      const index = chapterBodies.length;
      expect(value.expectedCompositionHead).toBe(index === 0 ? 'empty-head' : `chapter-head-${index - 1}`);
      chapterBodies.push(value);
      result = { post: classicChapterIdentity(target.work, actor, 'pride', index).work,
        compositionRevision: `chapter-head-${index}` };
    } else if (path === '/v1/rights/use-assessments') {
      assessments.push(value); result = { assessmentId: `assessment-${assessments.length}` };
    } else if (path === '/v1/content-drafts') {
      drafts.push(value); result = { revisionId: `draft-${drafts.length}`, byteDigest: 'digest',
        sourcePosition: { dataEpoch: 'epoch' } };
    } else if (path === '/v1/content-publications') {
      expect(value.expectedDigest).toBe('digest');
      expect(value.expectedContentEpoch).toBe('epoch');
      result = { decision: `publication-${drafts.length}`, status: 'active' };
    } else if (path === '/v1/content-search-eligibility') { eligibilities.push(value); result = {}; }
    else throw new Error(`Unexpected path ${path}`);
    ledger.set(key, { body, result });
    if (loseResponse && chapterBodies.length === 2 && path.endsWith('/chapters')) {
      loseResponse = false; throw new Error('lost chapter response');
    }
    return result as T;
  };
  const source = { provider: 'project-gutenberg' as const, identifier: 'ebook/1342',
    url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt', byteDigest: 'a'.repeat(64),
    retrievedAt: '2026-09-28T00:00:00.000Z' };
  const run = () => publishClassicChapters({ api: { post }, target, book: 'pride', actor, token: 'editor-token',
    chapters: [1, 2, 3].map(n => ({ title: `Chapter ${n}`, body: `Text ${n}`, kind: 'chapter' as const })),
    source, fixtureDigest: 'b'.repeat(64), grant: async () => {} });
  await expect(run()).rejects.toThrow('lost chapter response');
  await run();
  await run();
  expect(chapterBodies.map(body => body.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
  expect(assessments).toHaveLength(3);
  expect(drafts).toHaveLength(3);
  expect(eligibilities).toHaveLength(3);
  for (const [index, draft] of drafts.entries()) {
    expect(draft).toMatchObject({ profile: 'content-public-domain-text-v1', actingSubject: actor,
      assessmentId: `assessment-${index + 1}`, source });
    expect(assessments[index]).toMatchObject({ basis: 'public_domain', useKind: 'redistribution',
      useScope: 'rezics:public-text', material: { scopeKind: 'work', workId: draft.resourceId },
      evidence: { source, fixtureDigest: 'b'.repeat(64) } });
    expect(eligibilities[index]).toMatchObject({ profile: 'content-search-eligibility-v2',
      rightsBasis: 'public-domain', assessmentId: draft.assessmentId,
      resourceId: draft.resourceId, variantId: draft.variantId });
  }
});

test('Gutenberg seed: an inactive publication cannot become search eligible', async () => {
  const calls: string[] = [];
  const post: SeedApi['post'] = async <T>(path: string): Promise<T> => {
    calls.push(path);
    return ({ '/v1/compositions': { structure: 'composition', revision: 'head' },
      [`/v1/works/${target.work.slice(-36)}/chapters`]: {
        post: classicChapterIdentity(target.work, actor, 'pride', 0).work, compositionRevision: 'head-2' },
      '/v1/rights/use-assessments': { assessmentId: 'assessment' },
      '/v1/content-drafts': { revisionId: 'draft', byteDigest: 'digest', sourcePosition: { dataEpoch: 'epoch' } },
      '/v1/content-publications': { status: 'rejected' },
    }[path]) as T;
  };
  await expect(publishClassicChapters({ api: { post }, target, book: 'pride', actor, token: 'token',
    chapters: [{ title: 'Chapter 1', body: 'Text', kind: 'chapter' }], fixtureDigest: 'b'.repeat(64),
    source: { provider: 'project-gutenberg', identifier: 'ebook/1342', url: 'https://www.gutenberg.org/ebooks/1342',
      byteDigest: 'a'.repeat(64), retrievedAt: '2026-09-28T00:00:00.000Z' }, grant: async () => {} }))
    .rejects.toThrow('not published');
  expect(calls).not.toContain('/v1/content-search-eligibility');
});
