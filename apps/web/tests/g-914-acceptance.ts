// What the G-841 seed adds for the last catalogue queries (G-914): the two Zones of query 12, and the reviews of
// query 5 on the SAO story, an edition, a translation and two related Works, in the SAO Zone's Realm. The calls are
// those of `tests/qa/integration/g-840-catalogue.test.ts` (G-913); the answers recorded after the graph settles are
// what Main says for each, so the browser is compared with the API and not with a copy of its rules.
import { randomUUID } from 'node:crypto';
import { catalogueCollection, catalogueRequest, catalogueZone } from '../../../tests/fixtures/catalogue/acceptance.ts';
import { ZONE_PRESETS } from '../../../services/main/src/modules/zone/presentation-format.ts';
import type { CatalogueManifest, CataloguePort } from '../../../tests/fixtures/catalogue/load.ts';

const short = (iri: string) => iri.slice(-36);

/**
 * A write that Main may take a moment to finish (202, 503) and that must end in a success. A review is refused as
 * unavailable until the graph has projected the rating observation it stands on, which takes seconds, not milliseconds.
 */
async function written<T>(port: CataloguePort, method: string, path: string, body: object): Promise<T> {
  const key = randomUUID();
  for (let attempt = 0; ; attempt++) {
    const response = await port.request(method, path, body, key);
    if (response.status < 300 && response.status !== 202) return response.body as T;
    if (attempt >= 60 || (response.status !== 202 && response.status !== 503)) {
      throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`);
    }
    await new Promise(done => setTimeout(done, Math.min(1000, 200 * (attempt + 1))));
  }
}
const ADAPTATION_EVIDENCE = 'https://example.com/g914/sao-adaptation';
const SAO_QUESTION = 'How good is this story or adaptation?';

export type GrainLabel = 'story' | 'edition' | 'translation' | 'manga' | 'anime';
export interface Zones { sao: { zone: string; realm: string }; crossover: { zone: string; realm: string } }
interface Planned { label: GrainLabel; target: string; grain: string; score: number; question: string;
  generic: boolean; context: string; review: string; text: string; mainVersion?: string }

/** Main's answer for one reviewed target in the SAO Realm: its question, aggregate scope and reviews. */
export interface GrainAnswer {
  label: GrainLabel; target: string; context: string; question: string; score: number; text: string;
  scale: { min: number; max: number };
  aggregationScope: { question: string; grain: string; population: string; countedTarget: string };
  count: number; mean: number | null; displayThreshold?: number | null; meanDisplay?: string | null;
  distribution?: { value: number; count: number }[]; reviews: { id: string; text: string; rating: number }[];
}
export interface AcceptanceAnswers {
  zones: Zones;
  /** Query 5, by what was reviewed. */
  grains: Record<GrainLabel, GrainAnswer>;
  /** Query 12: the contributor both Zones name, as Main credits them. */
  contributor: { agent: string; displayName: string; handle: string };
  /** The Works each Zone mounts, by Zone, that carry the contributor. */
  contributorWorks: { sao: string; crossover: string };
}

export interface AcceptanceSeed { planned: Planned[]; zones: Zones; manga: string; anime: string }

/** A Zone is a site once its configuration names its default Realm; this one has the plain preset and no modules. */
async function openZone(port: CataloguePort, zone: string, realm: string, name: string) {
  const head = await catalogueRequest<{ revision: string }>(port, 'GET',
    `/v1/zones/${short(zone)}/configuration?actingSubject=${encodeURIComponent(port.actingSubject)}`);
  await written(port, 'PUT', `/v1/zones/${short(zone)}/configuration`, { expectedHead: head.revision,
    actingSubject: port.actingSubject, name, language: 'en', defaultRealm: realm,
    presentation: { profile: 'zone-presentation-v1', preset: 'clean', tokens: ZONE_PRESETS.clean, navigation: [], banners: [], modules: [] } });
}

/** Writes the Zones, the related Works and the reviews; nothing is read back before the graph has settled. */
export async function seedAcceptance(port: CataloguePort, manifest: CatalogueManifest,
  input: { digitalRelease: string; digitalRealization: string;
    /** Gives a Work a public text, which is what makes a Zone's site show it: its routes answer anonymous readers. */
    publish: (work: { work: string; mainVersion: string; title: string }) => Promise<void> }): Promise<AcceptanceSeed> {
  const work = (id: string) => manifest.works[id]!;
  const saoFranchise = manifest.collections['sao.franchise']!.collection;
  const sao = await catalogueZone(port, 'SAO catalogue', { franchise: saoFranchise });
  const crossover = await catalogueCollection(port, 'Synthetic crossover catalogue', [work('sao.aggo').work, work('index.original').work]);
  const other = await catalogueZone(port, 'Crossover catalogue', { franchise: crossover });
  await openZone(port, sao.zone, sao.realm, 'SAO catalogue');
  await openZone(port, other.zone, other.realm, 'Crossover catalogue');

  // Independent manga and anime Works the SAO story is adapted into (the fixture specification's expand_independent_works).
  const adaptations: Record<'manga' | 'anime', string> = { manga: '', anime: '' };
  const source = work('sao.bunko');
  for (const [key, title, semanticType] of [['manga', 'Sword Art Online: Aincrad (manga)', 'https://schema.org/Book'],
    ['anime', 'Sword Art Online (anime)', 'https://schema.org/TVSeries']] as const) {
    const created = await port.createWork!({ id: `sao.${key}`, title, semanticType });
    await port.grant(`work:read:${created.work}`, 'work.read');
    await port.grant(`work:edit:${created.work}`, 'work.edit');
    await written(port, 'POST', `/v1/resources/${short(created.work)}/derivations`, {
      profile: 'work-derivation-v2', targetMainVersion: created.mainVersion, expectedTargetHead: created.mainRevision,
      sourceWork: source.work, sourceMainVersion: source.mainVersion, sourceMainRevision: source.mainRevision,
      kind: 'adaptation', evidence: ADAPTATION_EVIDENCE, actingSubject: port.actingSubject });
    manifest.works[`sao.${key}`] = { ...created, title };
    adaptations[key] = created.work;
  }

  await port.grant(`rating:context:${sao.realm}`, 'rating.context.create');
  const post = <T>(path: string, body: object) => written<T>(port, 'POST', path, body);
  const storyContext = (await post<{ context: string }>('/v1/rating-contexts', { profile: 'realm-standing-rating-context-v1',
    realm: sao.realm, question: SAO_QUESTION, actingSubject: port.actingSubject })).context;
  const targets: Omit<Planned, 'context' | 'review' | 'text' | 'generic'>[] = [
    { label: 'edition', target: input.digitalRelease, grain: 'release', score: 8, question: 'How good is this edition?' },
    { label: 'translation', target: input.digitalRealization, grain: 'realization', score: 10, question: 'How good is this translation?' },
    { label: 'story', target: source.work, grain: 'main-version', score: 9, question: SAO_QUESTION, mainVersion: source.mainVersion },
    { label: 'manga', target: adaptations.manga, grain: 'main-version', score: 7, question: SAO_QUESTION,
      mainVersion: manifest.works['sao.manga']!.mainVersion },
    { label: 'anime', target: adaptations.anime, grain: 'main-version', score: 6, question: SAO_QUESTION,
      mainVersion: manifest.works['sao.anime']!.mainVersion },
  ];
  const planned: Planned[] = [];
  for (const item of targets) {
    const generic = item.grain !== 'main-version';
    const context = generic ? (await post<{ context: string }>('/v1/rating-contexts', { profile: 'realm-target-rating-context-v2', language: 'en',
      realm: sao.realm, question: item.question, targetGrain: item.grain, actingSubject: port.actingSubject })).context : storyContext;
    await port.grant(`rating:observe:${context}`, 'rating.observation.set');
    const observation = generic ? { profile: 'realm-target-rating-observation-v1', target: item.target }
      : { profile: 'realm-standing-rating-observation-v1', work: item.target, mainVersion: item.mainVersion };
    await post('/v1/rating-observations', { ...observation, context, value: item.score, expectedRevisionHead: null,
      actingSubject: port.actingSubject });
    const text = `${item.label} review`;
    const review = (await post<{ review: string }>('/v1/reviews', { profile: 'reader-review-command-v1',
      actingSubject: port.actingSubject, context, target: item.target, expectedRevision: null, language: 'en', text,
      spoiler: false })).review;
    planned.push({ ...item, generic, context, review, text });
  }
  // A Zone's site is public, so the Works it mounts need a public text. Done last: it changes nothing the above pinned.
  for (const key of ['sao.bunko', 'sao.aggo']) await input.publish(work(key));
  return { planned, zones: { sao: { zone: sao.zone, realm: sao.realm }, crossover: { zone: other.zone, realm: other.realm } },
    manga: adaptations.manga, anime: adaptations.anime };
}

type Read = (path: string) => Promise<unknown>;

/** Main's answers for what `seedAcceptance` wrote, read through the same public routes the pages use. */
export async function answerAcceptance(seed: AcceptanceSeed, read: Read, actor: string, manifest: CatalogueManifest):
  Promise<AcceptanceAnswers> {
  const realm = encodeURIComponent(seed.zones.sao.realm);
  const grains = {} as Record<GrainLabel, GrainAnswer>;
  for (const item of seed.planned) {
    const base = `/v1/resources/${short(item.target)}`;
    const scope = `scope=realm&realm=${realm}&actingSubject=${actor}`;
    const contexts = await read(`${base}/rating-contexts?${scope}`) as { items: { context: string; question: string; scale: { min: number; max: number } }[] };
    const question = contexts.items.find(entry => entry.context === item.context);
    if (!question) throw new Error(`${item.label}: Main lists no rating question ${item.context} in the SAO Realm`);
    const ratings = await read(`${base}/ratings?${scope}&context=${encodeURIComponent(item.context)}`) as {
      aggregationScope: GrainAnswer['aggregationScope']; count: number; mean: number | null;
      displayThreshold?: number | null; meanDisplay?: string | null; distribution?: { value: number; count: number }[] };
    const reviews = await read(`${base}/reviews?context=${encodeURIComponent(item.context)}&actingSubject=${actor}`) as {
      items: { id: string; text: string; rating: number }[] };
    grains[item.label] = { label: item.label, target: item.target, context: item.context, question: question.question,
      score: item.score, text: item.text, scale: question.scale, aggregationScope: ratings.aggregationScope,
      count: ratings.count, mean: ratings.mean, displayThreshold: ratings.displayThreshold, meanDisplay: ratings.meanDisplay,
      distribution: ratings.distribution, reviews: reviews.items.map(entry => ({ id: entry.id, text: entry.text, rating: entry.rating })) };
  }
  const credits = await read(`/v1/works/${short(manifest.works['sao.bunko']!.work)}/agent-credits?actingSubject=${actor}`) as {
    items: { role: string; agent: string; displayName: string; handle: string }[] };
  const author = credits.items.find(item => item.role === 'author');
  if (!author) throw new Error('the SAO story has no credited author');
  return { zones: seed.zones, grains, contributor: { agent: author.agent, displayName: author.displayName, handle: author.handle },
    contributorWorks: { sao: manifest.works['sao.bunko']!.work, crossover: manifest.works['sao.aggo']!.work } };
}
