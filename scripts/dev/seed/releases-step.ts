import { grantImportedWorkSeedAuthority } from './operator.ts';
import { seedKey, semanticTypes } from './plan.ts';
import type { ContributionReceipt, PublicationReceipt, SeedState, WorkReceipt } from './state.ts';

const id = (suffix: string) => `https://rezics.com/id/01944100-0000-7000-8000-${suffix}`;
const bytes = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** Native examples: a classic's print editions, its English translation, and a web serial's snapshots. */
export const releaseSeedPlan = {
  classic: { title: '紅樓夢', language: 'zh' },
  editions: [
    { id: id('0000000000a1'), title: '紅樓夢 程甲本', language: 'zh-Hant', contentLanguages: ['zh-Hant'],
      isTranslation: false, originalLanguages: [] as string[], titleLanguage: 'zh-Hant',
      publisher: '萃文書屋', publicationYear: 1791 },
    { id: id('0000000000a2'), title: '红楼梦', language: 'zh-Hans', contentLanguages: ['zh-Hans'],
      isTranslation: false, originalLanguages: [] as string[], titleLanguage: 'zh-Hans',
      publisher: '人民文学出版社', publicationYear: 1982 },
    { id: id('0000000000a3'), title: 'The Story of the Stone', language: 'en', contentLanguages: ['en'],
      isTranslation: true, originalLanguages: ['zh'], titleLanguage: 'en',
      publisher: 'Penguin', publicationYear: 1973 },
  ],
  serial: {
    title: '星港夜話', language: 'zh',
    release: id('0000000000b1'),
    originalUrl: 'https://example.com/star-harbor',
    snapshots: [
      { id: id('0000000000b2'), fetchedAt: '2024-03-01T00:00:00.000Z',
        text: '星港夜話 第一回至第十回', coverage: { scope: 'chapters 1-10', complete: false } },
      { id: id('0000000000b3'), fetchedAt: '2024-06-01T00:00:00.000Z',
        text: '星港夜話 第一回至第二十回', coverage: { scope: 'chapters 1-20', complete: false } },
    ],
  },
} as const;

const releaseBody = (edition: typeof releaseSeedPlan.editions[number], actor: string) => ({
  profile: 'release-v1' as const, expectedHead: null, actingSubject: actor, id: edition.id,
  kind: 'formal' as const, status: 'official' as const, contentLanguages: [...edition.contentLanguages],
  isTranslation: edition.isTranslation, originalLanguages: [...edition.originalLanguages],
  titleLanguage: edition.titleLanguage, tracklistLanguage: null,
  title: { value: edition.title, language: edition.language }, editionStatement: null,
  publisher: edition.publisher, publicationYear: edition.publicationYear, isbn13: null,
  originalUrl: null, fixedRelease: null, coverage: null, evidence: null,
});

export async function seedReleases(state: SeedState) {
  const author = state.sessions[0];
  if (!author) throw new Error('Release seed needs an account');
  const actor = author.actingSubject;
  // Reuse the imported classic and its source-backed Cao Xueqin credit. A
  // second bare record would lose that author or misattribute him to the seed user.
  const classic = state.created.get('red-chamber');
  if (!classic || !state.operatorInput) throw new Error('Release seed requires the imported Red Chamber and fixture operator');
  await grantImportedWorkSeedAuthority(state.operatorInput, classic.work, classic.mainVersion);
  for (const edition of releaseSeedPlan.editions) {
    await state.api.put(`/v1/works/${classic.work.slice(-36)}/releases/${edition.id.slice(-36)}`,
      releaseBody(edition, actor), author.token, seedKey('release', edition.id));
  }
  const serial = await state.api.post<WorkReceipt>('/v1/works', {
    profile: 'metadata-only-v1', title: releaseSeedPlan.serial.title, semanticTypes: semanticTypes('book'),
    language: releaseSeedPlan.serial.language, actingSubject: actor, authoring: 'own-work',
  }, author.token, seedKey('release-work', 'star-harbor'));
  await grantImportedWorkSeedAuthority(state.operatorInput, serial.work, serial.mainVersion);
  const web = releaseSeedPlan.serial;
  await state.api.put(`/v1/works/${serial.work.slice(-36)}/releases/${web.release.slice(-36)}`, {
    profile: 'release-v1', expectedHead: null, actingSubject: actor, id: web.release,
    kind: 'web', status: 'official', contentLanguages: ['zh'], isTranslation: false, originalLanguages: [],
    titleLanguage: 'zh', tracklistLanguage: null, title: { value: web.title, language: 'zh' },
    editionStatement: null, publisher: null, publicationYear: null, isbn13: null,
    originalUrl: web.originalUrl, fixedRelease: null, coverage: null, evidence: null,
  }, author.token, seedKey('release', web.release));
  for (const snapshot of web.snapshots) {
    await state.api.post(`/v1/works/${serial.work.slice(-36)}/web-publications/${web.release.slice(-36)}/snapshots`, {
      profile: 'web-snapshot-v1', actingSubject: actor, id: snapshot.id, acquisition: 'fixture',
      bytesBase64: bytes(snapshot.text), mediaType: 'text/plain', fetchedAt: snapshot.fetchedAt,
      coverage: snapshot.coverage,
    }, author.token, seedKey('snapshot', snapshot.id));
  }
  // The imported classic already has its public text and source eligibility.
  // Keep that selection while adding edition facts; only the new serial needs one.
  await publishReadable(state, serial, 'star-harbor', '星港夜話。連載的前兩回。');
  state.created.set('hongloumeng', classic);
  state.created.set('star-harbor', serial);
  console.log(`Releases: ${classic.work} 紅樓夢; ${serial.work} 星港夜話`);
}

/** A public Main selection makes the Work page readable. The release facts are separate. */
async function publishReadable(state: SeedState, work: WorkReceipt, key: string, body: string) {
  const author = state.sessions[0];
  if (!author) throw new Error('Release seed needs an account');
  const contribution = await state.api.post<ContributionReceipt>('/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: 'zh', body, actingSubject: author.actingSubject,
  }, author.token, seedKey('release-contribution', key));
  const published = await state.api.post<PublicationReceipt>('/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: contribution.contribution,
    expectedDraftHead: contribution.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: author.actingSubject,
  }, author.token, seedKey('release-publication', key));
  await state.api.post('/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: contribution.contribution, publicationDecision: published.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: author.actingSubject,
  }, author.token, seedKey('release-selection', key));
}
