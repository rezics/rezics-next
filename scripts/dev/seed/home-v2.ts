import { SeedApi, SeedApiError } from './api.ts';
import { derivedId } from '../../../services/main/src/modules/structure/graph.ts';
import { readBookOutline } from './book-outline.ts';
import { seedKey, works } from './plan.ts';
import type { grantHomeSeedAuthority } from './operator.ts';

interface Session { id: string; token: string; actingSubject: string }
interface Work { work: string; mainVersion: string }
interface Realm { id: string; receipt: { realm: string } }
const short = (id: string) => id.slice(-36);

async function exactDigest(api: SeedApi, revision: string, session: Session): Promise<string> {
  const response = await fetch(`${api.endpoints.main}/v1/content-revisions/${revision}?actingSubject=${
    encodeURIComponent(session.actingSubject)}`, { headers: { authorization: `Bearer ${session.token}` } });
  if (!response.ok) throw new SeedApiError('Home chapter exact read', response.status,
    (await response.text()).slice(0, 500));
  const exact = await response.json() as { reference: { byteDigest: string } };
  return exact.reference.byteDigest;
}

interface Contents { compositionRevision: string | null; items: { occurrence: string; role: string;
  label: { value: string } | null; target: string | null; selectedRevision: string | null }[] }
interface Chapter { title: string; body: string }
const LANGUAGE = 'zh-Hans';

/**
 * The serial as its author reads it, in reading order: the top level and the chapters of each volume. A new
 * composition may not be projected yet, and reads empty.
 */
async function authorContents(api: SeedApi, serial: string, author: Session): Promise<Contents> {
  const outline = await readBookOutline(api, serial, LANGUAGE, author);
  return { compositionRevision: outline.head, items: outline.items };
}

/** Fixture authority for exact seed targets; the seed CLI grants it through the local operator. */
export type SeedGrant = (grants: Parameters<typeof grantHomeSeedAuthority>[1]) => Promise<void>;

/** A chapter's own Content: drafted, published and made public, as Studio's editor does it. */
export async function publishChapter(api: SeedApi, author: Session, key: string, work: string, variantId: string,
  body: string, grant: SeedGrant) {
  await grant([
    { action: 'work.read', scope: `work:read:${work}` },
    { action: 'content.draft', scope: `content:draft:${work}` },
    { action: 'content.publish', scope: `content:publish:${work}` },
    { action: 'content.search-eligibility', scope: `content:search-eligibility:${work}` }]);
  const saved = await api.post<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(
    '/v1/content-drafts', { profile: 'content-text-v1', resourceId: work, variantId,
      language: { kind: 'tag', tag: LANGUAGE, originalTag: LANGUAGE }, direction: 'ltr',
      expectedHead: null, body, actingSubject: author.actingSubject },
    author.token, seedKey('home-chapter-draft', key));
  const published = await api.post<{ decision: string; status: string }>('/v1/content-publications', {
    profile: 'content-publication-v1', preparationId: seedKey('home-chapter', key),
    revisionId: saved.revisionId, expectedDigest: await exactDigest(api, saved.revisionId, author),
    expectedContentEpoch: saved.sourcePosition.dataEpoch, resourceId: work, variantId,
    expectedPublicationHead: null, actingSubject: author.actingSubject },
  author.token, seedKey('home-chapter-publication', key));
  if (published.status !== 'active' || !published.decision) throw new Error(`Home chapter ${key} is not published`);
  await api.post('/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
    resourceId: work, variantId, publicationDecision: published.decision,
    expectedEligibilityHead: null, actingSubject: author.actingSubject,
    rightsBasis: 'original-contribution', disclosure: 'public' },
  author.token, seedKey('home-chapter-eligibility', key));
}

/**
 * The occurrences of `planned` in `contents`, in the plan's order: a chapter this seed made has the identity
 * Studio's command derives from its key; one an earlier seed placed is known by its title.
 */
export function plannedOccurrences(contents: Contents, planned: readonly { title: string; work: string }[]) {
  return planned.map(chapter => contents.items.find(item => item.role === 'chapter'
    && (item.target === chapter.work || item.label?.value === chapter.title)) ?? null);
}

/** One change moving `order` to the head of the Book's first level, in that order. */
export function reorderOperations(structure: string, order: readonly string[]) {
  return order.map((occurrence, index) => ({ op: 'move' as const, occurrence, parent: structure,
    position: index === 0 ? 'first' as const : { after: order[index - 1]! } }));
}

/**
 * The serial's chapters, in reading order and each readable. A chapter is a part of the Book made by
 * Studio's chapter command, never a Work of its own in the plan. Stacks seeded before that command kept
 * chapter Works placed in the wrong order (2, 1, 3): those are recognised by title, left in place and
 * moved into the plan's order, so the shared stack reads 1, 2, 3 without a reset. Returns the chapter
 * occurrences in order.
 */
export async function prepareHomeV2Chapters(api: SeedApi, author: Session, created: Map<string, Work>,
  grant: SeedGrant) {
  const serial = created.get('serial');
  const chapters: readonly Chapter[] = works.find(work => work.id === 'serial')?.chapters ?? [];
  if (!serial || !chapters.length) throw new Error('Home seed needs the serial and its chapters');
  await grant([{ action: 'work.edit', scope: `work:edit:${serial.work}` },
    { action: 'work.read', scope: `work:read:${serial.work}` }]);
  const composition = await api.post<{ structure: string; revision: string }>('/v1/compositions', {
    profile: 'book-composition', work: serial.work, mainVersion: serial.mainVersion,
    actingSubject: author.actingSubject }, author.token, seedKey('composition', 'serial'));
  const planned = chapters.map((chapter, index) => {
    const key = seedKey('home-chapter-create', `serial:${index}`);
    const seed = `${serial.work}\0${author.actingSubject}\0${key}\0chapter`;
    return { ...chapter, key, index, work: derivedId(`${seed}\0work`),
      variantId: `urn:rezics:variant:${derivedId(`${seed}\0variant`).slice(-36)}` };
  });
  let contents = await authorContents(api, serial.work, author);
  for (const [index, chapter] of plannedOccurrences(contents, planned).entries()) {
    const plan = planned[index]!;
    if (chapter?.selectedRevision) continue;
    if (chapter && chapter.target !== plan.work) {
      throw new Error(`Home chapter ${plan.title} has no public text and was not made by this seed`);
    }
    if (!chapter) {
      const made = await api.post<{ work: string; compositionRevision: string }>(`/v1/works/${short(serial.work)}/chapters`, {
        profile: 'book-chapter-create-v1', title: plan.title, language: LANGUAGE, direction: 'ltr',
        parent: composition.structure, position: 'last',
        expectedCompositionHead: contents.compositionRevision ?? composition.revision,
        actingSubject: author.actingSubject }, author.token, plan.key);
      if (made.work !== plan.work) throw new Error(`Home chapter ${plan.title} has another identity`);
      contents = { ...contents, compositionRevision: made.compositionRevision };
    }
    await publishChapter(api, author, `serial:${plan.index}`, plan.work, plan.variantId,
      `${plan.title}\n${plan.body}`, grant);
  }
  // Main projects a new publication shortly after the command; read until every chapter has its text.
  let placed = plannedOccurrences(contents, planned);
  for (let attempt = 0; attempt < 30; attempt++) {
    contents = await authorContents(api, serial.work, author);
    placed = plannedOccurrences(contents, planned);
    if (placed.every(item => item?.selectedRevision)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (placed.some(item => !item?.selectedRevision)) throw new Error('Home serial has an unreadable chapter');
  const order = placed.map(item => item!.occurrence);
  const current = contents.items.filter(item => item.role === 'chapter').map(item => item.occurrence);
  if (order.some((occurrence, index) => current[index] !== occurrence)) {
    await api.post(`/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'book-composition', expectedHead: contents.compositionRevision, actingSubject: author.actingSubject,
      operations: reorderOperations(composition.structure, order) },
    author.token, seedKey('composition-order', `serial:${contents.compositionRevision?.slice(-12)}`));
  }
  return { structure: composition.structure, occurrences: order };
}

/** Reader commands replay without replacing progress saved after the seed. */
export async function seedHomeV2(api: SeedApi, sessions: Session[], created: Map<string, Work>, realms: Realm[]) {
  const reader = sessions[1], serial = created.get('serial');
  if (!reader || !serial) throw new Error('Home seed needs the serial and a demo reader');
  const feedResponse = await fetch(`${api.endpoints.main}/v1/feed?sort=new&limit=1`);
  if (!feedResponse.ok) throw new SeedApiError('Home projection position', feedResponse.status,
    (await feedResponse.text()).slice(0, 500));
  const feed = await feedResponse.json() as { sourcePosition: { dataEpoch: string } };
  for (const scope of ['following', ...realms.map(realm => `realm:${realm.receipt.realm}`)]) {
    await api.put(`/v1/me/feed-watermarks/${encodeURIComponent(scope)}`, {
      actingSubject: reader.actingSubject, scope, dataEpoch: feed.sourcePosition.dataEpoch,
      sequence: '0' }, reader.token, seedKey('home-watermark', `${reader.id}:${scope}`));
  }
  await api.put(`/v1/works/${short(serial.work)}/reader-status`, {
    actingSubject: reader.actingSubject, expectedVersion: 0, status: 'reading',
    startedOn: null, finishedOn: null }, reader.token, seedKey('home-status', reader.id));
  const resume = await api.get<{ items: { work: string; nextUnread: { occurrence: string } }[] }>(
    `/v1/me/continue?actingSubject=${encodeURIComponent(reader.actingSubject)}`, reader.token);
  if (!resume.items.some(item => item.work === serial.work && item.nextUnread.occurrence)) {
    throw new Error('Home Continue strip has no serial chapter');
  }
  const navigation = await api.get<{ items: { newSince?: { state: string } }[] }>(
    `/v1/me/follows?actingSubject=${encodeURIComponent(reader.actingSubject)}&kind=realm&include=newSince`, reader.token);
  if (!navigation.items.some(item => item.newSince?.state === 'new')) {
    throw new Error('Home Realm navigation has no new activity');
  }
  return { chapters: 3, watermarks: realms.length + 1 };
}
