import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { derivedId } from '../../../services/main/src/modules/structure/graph.ts';
import { type FixtureLock } from '../../fixtures/pull.ts';
import { SeedApiError, type SeedApi } from './api.ts';
import { arrangeBook, readBookOutline } from './book-outline.ts';
import { classicGroups, classicTextPlan, type ClassicChapter } from './classics-text.ts';
import { grantClassicAssessmentAuthority } from './classics-text-authority.ts';
import { grantHomeSeedAuthority } from './operator.ts';
import { seedKey } from './plan.ts';
import { refreshSeedTokens, type SeedState, type WorkReceipt } from './state.ts';

const short = (id: string) => id.slice(-36);
export interface ClassicSource { provider: 'project-gutenberg'; identifier: string; url: string;
  byteDigest: string; retrievedAt: string }

/** Old source adoptions were untyped. State Book through its revisioned command, preserving the Work identity. */
export async function ensureClassicBookType(input: {
  read: () => Promise<{ revision: string; types: string[] }>;
  api: Pick<SeedApi, 'put'>; book: string; work: string; actor: string; token: string;
}) {
  const current = await input.read();
  if (current.types.includes('https://schema.org/Book')) return;
  await input.api.put(`/v1/works/${short(input.work)}/type`, { profile: 'work-type-v1',
    expectedHead: current.revision, types: ['https://schema.org/Book'], actingSubject: input.actor },
  input.token, seedKey('classic-type', `${input.book}:${short(current.revision)}`));
}

/** Deterministic identity is the same one the Studio chapter command derives. */
export function classicChapterIdentity(work: string, actor: string, book: string, index: number) {
  const key = seedKey('classic-chapter', `${book}:${index}`);
  const seed = `${work}\0${actor}\0${key}\0chapter`;
  return { key, work: derivedId(`${seed}\0work`),
    variantId: `urn:rezics:variant:${short(derivedId(`${seed}\0variant`))}` };
}

/** Each returned chapter receipt supplies the original head for the next intent, including on a partial replay. */
export async function publishClassicChapters(input: {
  api: Pick<SeedApi, 'post'>; target: WorkReceipt; book: string; actor: string; token: string;
  chapters: readonly ClassicChapter[]; source: ClassicSource; fixtureDigest: string;
  grant: (work: string) => Promise<void>;
  /** Chapters an earlier seed already published: their creation replays, the rest of their steps don't. */
  published?: ReadonlySet<string>;
}): Promise<void> {
  const { api, target, book, actor, token, chapters, source } = input;
  const composition = await api.post<{ structure: string; revision: string }>('/v1/compositions', {
    profile: 'book-composition', work: target.work, mainVersion: target.mainVersion, actingSubject: actor },
  // The pre-type seed's composition intent was durably cancelled on existing stacks.
  token, seedKey('classic-composition-v2', book)).catch((error: unknown) => {
    if (error instanceof SeedApiError && error.status === 404) {
      throw new Error(`Classic ${book}: Main rejected the book composition; the imported Work needs the schema:Book type before chapters can be seeded`, { cause: error });
    }
    throw error;
  });
  let head = composition.revision;
  for (const [index, chapter] of chapters.entries()) {
    const identity = classicChapterIdentity(target.work, actor, book, index);
    const made = await api.post<{ post: string; compositionRevision: string }>(
      `/v1/works/${short(target.work)}/chapters`, { profile: 'book-chapter-create-v1',
        title: chapter.title, language: 'en', direction: 'ltr', parent: composition.structure,
        position: 'last', expectedCompositionHead: head, actingSubject: actor }, token, identity.key);
    if (made.post !== identity.work) throw new Error(`Classic ${book}:${index} has another chapter identity`);
    head = made.compositionRevision;
    if (input.published?.has(made.post)) continue;
    await input.grant(made.post);
    const assessmentKey = seedKey('classic-rights', `${book}:${index}`);
    const assessment = await api.post<{ assessmentId: string }>('/v1/rights/use-assessments', {
      profile: 'rights-use-assessment-v1', actingSubject: actor,
      material: { scopeKind: 'work', workId: made.post, provider: null, namespace: null,
        sourceRecordId: null, contentVariantId: null, mediaAsset: null, component: 'body' },
      expressionKind: 'expression', family: 'data_rights', useKind: 'redistribution', useScope: 'rezics:public-text',
      basis: 'public_domain', outcome: 'supported', licenseInstrument: null, exceptionKind: null, rationale: null,
      extent: { jurisdiction: 'US', section: chapter.title },
      evidence: { source, fixtureDigest: input.fixtureDigest,
        license: 'https://www.gutenberg.org/policy/license.html', transformation: 'license-and-trademark-wrapper-removed' },
      obligations: [], expectedAssessment: null, idempotencyKey: assessmentKey }, token, assessmentKey);
    const saved = await api.post<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      '/v1/content-drafts', { profile: 'content-public-domain-text-v1', resourceId: made.post,
        variantId: identity.variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        expectedHead: null, body: chapter.body, actingSubject: actor, assessmentId: assessment.assessmentId, source },
    token, seedKey('classic-draft-v2', `${book}:${index}`));
    const publication = await api.post<{ decision: string; status: string }>('/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: seedKey('classic-preparation-v2', `${book}:${index}`),
      revisionId: saved.revisionId, expectedDigest: saved.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
      resourceId: made.post, variantId: identity.variantId, expectedPublicationHead: null, actingSubject: actor },
    token, seedKey('classic-publication-v2', `${book}:${index}`));
    if (publication.status !== 'active' || !publication.decision) throw new Error(`Classic ${book}:${index} is not published`);
    await api.post('/v1/content-search-eligibility', { profile: 'content-search-eligibility-v2',
      resourceId: made.post, variantId: identity.variantId, publicationDecision: publication.decision,
      expectedEligibilityHead: null, actingSubject: actor, rightsBasis: 'public-domain',
      assessmentId: assessment.assessmentId, disclosure: 'public' }, token, seedKey('classic-eligibility-v2', `${book}:${index}`));
  }
}

async function seedTexts(state: SeedState): Promise<void> {
  const root = resolve(import.meta.dir, '../../..');
  const plans = classicTextPlan(root); // Verify every locked book before the first write.
  const lock = JSON.parse(readFileSync(`${root}/tests/fixtures/fixtures.lock.json`, 'utf8')) as FixtureLock;
  const author = state.penAgents.get('northstar'), writer = state.sessions.find(session => session.id === 'mei');
  if (!state.operatorInput || !state.operatorSession || !author || !writer) {
    throw new Error('Classics require the North Star Editions editor and seed operator');
  }
  const operator = { ...state.operatorInput, ownerAccountSubject: writer.accountId, actingSubject: author };
  await grantClassicAssessmentAuthority(operator);
  for (const { book, fixture, chapters, totalSections } of plans) {
    await refreshSeedTokens(state);
    const target = state.created.get(book.id);
    if (!target) throw new Error(`Classic ${book.id} has not been acquired`);
    await grantHomeSeedAuthority(operator, [
      { action: 'work.read', scope: `work:read:${target.work}` },
      { action: 'work.edit', scope: `work:edit:${target.work}` }]);
    await grantHomeSeedAuthority({ ...operator, ownerAccountSubject: operator.accountSubject },
      [{ action: 'work.edit', scope: `work:edit:${target.work}` }]);
    await ensureClassicBookType({ read: () => state.api.get(
      `/v1/works/${short(target.work)}?actingSubject=${encodeURIComponent(author)}`, writer.token),
    api: state.operatorSession.api, book: book.id, work: target.work,
    actor: author, token: state.operatorSession.token });
    const entry = lock.entries.find(item => item.source === 'gutenberg' && item.id === `pg${book.edition}`)!;
    // Chapters are read through the whole outline: once the book is in volumes they sit inside them.
    const contents = await readBookOutline(state.api, target.work, 'en');
    const complete = chapters.every((_, index) => contents.items.some(item => item.selectedRevision
      && item.target === classicChapterIdentity(target.work, author, book.id, index).work));
    if (!complete) {
      await publishClassicChapters({ api: state.api, target, book: book.id, actor: author, token: writer.token,
        chapters, fixtureDigest: entry.sha256,
        published: new Set(contents?.items.flatMap(item => item.selectedRevision && item.target ? [item.target] : []) ?? []),
        source: { provider: 'project-gutenberg', identifier: `ebook/${book.edition}`, url: entry.requestUrl,
          byteDigest: fixture.sourceSha256, retrievedAt: entry.fetchedAt },
        grant: work => grantHomeSeedAuthority(operator, [
          { action: 'work.read', scope: `work:read:${work}` },
          { action: 'content.draft', scope: `content:draft:${work}` },
          { action: 'content.publish', scope: `content:publish:${work}` },
          { action: 'content.search-eligibility', scope: `content:search-eligibility:${work}` }]) });
    }
    const groups = classicGroups(book.id, chapters);
    if (groups.length) {
      const composition = await state.api.post<{ structure: string }>('/v1/compositions', { profile: 'book-composition',
        work: target.work, mainVersion: target.mainVersion, actingSubject: author }, writer.token,
      seedKey('classic-composition-v2', book.id));
      await arrangeBook(state.api, { work: target.work, structure: composition.structure, language: 'en',
        reader: { token: writer.token, actingSubject: author }, key: `classic:${book.id}`,
        groups: groups.map(group => ({ ...group, chapters: group.chapters.map(index =>
          classicChapterIdentity(target.work, author, book.id, index).work) })) });
    }
    console.log(`Classic text ${book.id}: ${chapters.length}/${totalSections} sections${complete ? ' (replayed)' : ''}${
      groups.length ? `, in ${groups.map(group => group.title).join(', ')}` : ''}`);
  }
}

export async function seedClassicTexts(state: SeedState): Promise<void> {
  const started = performance.now();
  try { await seedTexts(state); }
  finally {
    console.log(`Classic texts step elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s; planned three chapters per book, plus Frankenstein's four letters and the openings of Pride and Prejudice's Volumes II and III`);
  }
}
