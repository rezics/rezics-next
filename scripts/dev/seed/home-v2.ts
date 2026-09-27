import { createHash } from 'node:crypto';
import { SeedApi, SeedApiError } from './api.ts';
import { seedKey, works } from './plan.ts';

interface Session { id: string; token: string; actingSubject: string }
interface Work { work: string; mainVersion: string }
interface Realm { id: string; receipt: { realm: string } }
const short = (id: string) => id.slice(-36);
function stableId(value: string) {
  const hex = createHash('sha256').update(`dev-seed:home-v2:${value}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function exactDigest(api: SeedApi, revision: string, session: Session): Promise<string> {
  const response = await fetch(`${api.endpoints.main}/v1/content-revisions/${revision}?actingSubject=${
    encodeURIComponent(session.actingSubject)}`, { headers: { authorization: `Bearer ${session.token}` } });
  if (!response.ok) throw new SeedApiError('Home chapter exact read', response.status,
    (await response.text()).slice(0, 500));
  const exact = await response.json() as { reference: { byteDigest: string } };
  return exact.reference.byteDigest;
}

/** This one optional seed step uses public author/reader commands only. It may
 * replay after an interrupted run without replacing the reader's later state. */
export async function seedHomeV2(api: SeedApi, sessions: Session[], created: Map<string, Work>, realms: Realm[]) {
  const author = sessions[0], reader = sessions[1];
  const serial = created.get('serial');
  if (!author || !reader || !serial) throw new Error('Home seed needs the serial and two demo readers');
  const feedResponse = await fetch(`${api.endpoints.main}/v1/feed?sort=new&limit=1`);
  if (!feedResponse.ok) throw new SeedApiError('Home projection position', feedResponse.status,
    (await feedResponse.text()).slice(0, 500));
  const feed = await feedResponse.json() as { sourcePosition: { dataEpoch: string } };
  for (const scope of ['following', ...realms.map(realm => `realm:${realm.receipt.realm}`)]) {
    await api.put(`/v1/me/feed-watermarks/${encodeURIComponent(scope)}`, {
      actingSubject: reader.actingSubject, scope, dataEpoch: feed.sourcePosition.dataEpoch,
      sequence: '0' }, reader.token, seedKey('home-watermark', `${reader.id}:${scope}`));
  }
  const targets: { work: string; label: string }[] = [];
  for (const id of ['serial-ch2', 'serial-ch3']) {
    const child = created.get(id);
    const text = works.find(work => work.id === id);
    if (!child || !text) throw new Error(`Home chapter ${id} is unavailable`);
    const variantId = `urn:rezics:variant:${stableId(id)}`;
    const saved = await api.post<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: child.work, variantId,
        language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-Hans' }, direction: 'ltr',
        expectedHead: null, body: text.excerpt ?? text.title, actingSubject: author.actingSubject },
    author.token, seedKey('home-chapter-draft', id));
    const published = await api.post<{ decision: string; status: string }>('/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: seedKey('home-chapter', id),
      revisionId: saved.revisionId, expectedDigest: await exactDigest(api, saved.revisionId, author),
      expectedContentEpoch: saved.sourcePosition.dataEpoch, resourceId: child.work, variantId,
      expectedPublicationHead: null, actingSubject: author.actingSubject },
    author.token, seedKey('home-chapter-publication', id));
    if (published.status !== 'active' || !published.decision) throw new Error(`Home chapter ${id} is not published`);
    await api.post('/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
      resourceId: child.work, variantId, publicationDecision: published.decision,
      expectedEligibilityHead: null, actingSubject: author.actingSubject,
      rightsBasis: 'original-contribution', disclosure: 'public' },
    author.token, seedKey('home-chapter-eligibility', id));
    targets.push({ work: child.work, label: text.title });
  }
  const composition = await api.post<{ structure: string; revision: string }>('/v1/compositions', {
    profile: 'book-composition', work: serial.work, mainVersion: serial.mainVersion,
    actingSubject: author.actingSubject }, author.token, seedKey('home-composition', 'serial'));
  await api.post(
    `/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'book-composition', expectedHead: composition.revision,
      actingSubject: author.actingSubject, operations: targets.map(target => ({
        op: 'insert', parent: composition.structure, position: 'last', role: 'chapter',
        target: target.work, label: { value: target.label, language: 'zh-Hans' } })) },
    author.token, seedKey('home-composition-chapters', 'serial'));
  // A replayed composition receipt need not repeat occurrence IDs. Read the
  // public chapter page after either a fresh write or a replay.
  const contentsResponse = await fetch(`${api.endpoints.main}/v1/works/${short(serial.work)}/contents?limit=3`);
  if (!contentsResponse.ok) throw new SeedApiError('Home chapters', contentsResponse.status,
    (await contentsResponse.text()).slice(0, 500));
  const contents = await contentsResponse.json() as { items: { role: string; occurrence: string }[] };
  const first = contents.items.find(item => item.role === 'chapter')?.occurrence;
  if (!first) throw new Error('Home composition has no readable chapter');
  await api.put(`/v1/works/${short(serial.work)}/reader-status`, {
    actingSubject: reader.actingSubject, expectedVersion: 0, status: 'reading',
    startedOn: null, finishedOn: null }, reader.token, seedKey('home-status', reader.id));
  await api.put(`/v1/compositions/${short(composition.structure)}/occurrences/${short(first)}/progress`, {
    actingSubject: reader.actingSubject, expectedVersion: 0, completed: false, position: 'paragraph-1' },
  reader.token, seedKey('home-progress', reader.id));
  return { chapters: targets.length, watermarks: realms.length + 1 };
}
