import { createHash } from 'node:crypto';
import { SeedApi, SeedApiError } from './api.ts';
import { seedKey, works } from './plan.ts';
import { grantHomeSeedAuthority } from './operator.ts';

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

/** Prepare exact public chapter Content before the shared progress step inserts
 * the Book composition. The local operator only provisions fixture authority. */
export async function prepareHomeV2Chapters(api: SeedApi, author: Session, created: Map<string, Work>,
  operatorInput: Parameters<typeof grantHomeSeedAuthority>[0]) {
  const serial = created.get('serial'), second = created.get('serial-ch2');
  if (!serial || !second) throw new Error('Home seed needs the serial and second chapter');
  const targets = [{ id: 'serial', work: serial.work }, { id: 'serial-ch2', work: second.work }];
  await grantHomeSeedAuthority(operatorInput, [
    { action: 'work.edit', scope: `work:edit:${serial.work}` },
    ...targets.flatMap(target => [
      { action: 'work.read' as const, scope: `work:read:${target.work}` },
      { action: 'content.draft' as const, scope: `content:draft:${target.work}` },
      { action: 'content.publish' as const, scope: `content:publish:urn:rezics:variant:${stableId(target.id)}` },
      { action: 'content.search-eligibility' as const,
        scope: `content:search-eligibility:urn:rezics:variant:${stableId(target.id)}` },
    ]),
  ]);
  for (const { id, work } of targets) {
    const child = created.get(id);
    const text = works.find(work => work.id === id);
    if (!child || !text) throw new Error(`Home chapter ${id} is unavailable`);
    const variantId = `urn:rezics:variant:${stableId(id)}`;
    const saved = await api.post<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: work, variantId,
        language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-Hans' }, direction: 'ltr',
        expectedHead: null, body: text.excerpt ?? text.title, actingSubject: author.actingSubject },
    author.token, seedKey('home-chapter-draft', id));
    const published = await api.post<{ decision: string; status: string }>('/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: seedKey('home-chapter', id),
      revisionId: saved.revisionId, expectedDigest: await exactDigest(api, saved.revisionId, author),
      expectedContentEpoch: saved.sourcePosition.dataEpoch, resourceId: work, variantId,
      expectedPublicationHead: null, actingSubject: author.actingSubject },
    author.token, seedKey('home-chapter-publication', id));
    if (published.status !== 'active' || !published.decision) throw new Error(`Home chapter ${id} is not published`);
    await api.post('/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
      resourceId: work, variantId, publicationDecision: published.decision,
      expectedEligibilityHead: null, actingSubject: author.actingSubject,
      rightsBasis: 'original-contribution', disclosure: 'public' },
    author.token, seedKey('home-chapter-eligibility', id));
  }
  return { chapters: targets.length };
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
  return { chapters: 2, watermarks: realms.length + 1 };
}
