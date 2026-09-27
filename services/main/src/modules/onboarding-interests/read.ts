import { readRealmDirectory } from '../realm-directory/read.ts';
import { readRealmWorks } from '../realm-reads/read-works.ts';
import { listOfficialZones } from '../zone/publication.ts';
import { WorkReadInvalid, WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { publicWork } from '../work/read-session.ts';
import type { AvatarDescriptor } from '../media/summary.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { HomeInterestKind } from './contract.ts';
import { ONBOARDING_COST } from './contract.ts';

const kinds: HomeInterestKind[] = ['books', 'software', 'ai', 'recipes', 'media', 'discussions'];
const languages = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
// Native Work types distinguish Book and Recipe. DigitalDocument cannot split
// software, AI or discussions; Hub SkillPackage/PromptTemplate are narrower
// artifacts, and Video/Audio card hints are not admitted Work creation types.
// Classification Senses have no controlled mapping to these six kind IDs.
const typeFor = (kind: HomeInterestKind) => kind === 'books' ? 'https://schema.org/Book'
  : kind === 'recipes' ? 'https://schema.org/Recipe' : null;
export function parseChoices(value: string | undefined, allowed: readonly string[], maximum: number) {
  if (!value) return [];
  const choices = value.split(',').map(item => item.trim()).filter(Boolean);
  if (choices.length > maximum || new Set(choices).size !== choices.length
    || choices.some(item => !allowed.includes(item))) throw new WorkReadInvalid('Invalid onboarding choices');
  return choices;
}

export async function readInterests(session: WorkReadSession) {
  // Only accepted global Senses with public sample Works are offered. The
  // bounded catalog can be empty without inventing a topic or a cover.
  const rows = await session.query(`SELECT DISTINCT ?sense ?label ?work ?main WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:expression ?expression .
      ?expression rv:assertedConcept ?concept .
      ?concept skos:prefLabel ?label .
      ?application a rv:ClassificationApplication ; rv:sense ?sense ;
        rv:targetMainVersion ?main ; rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
        rv:applicationState rv:Active ; rv:decisionHead ?decision .
      ?main rv:work ?work .
    } GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:outcome rv:Accepted . }
    ${publicWork('?work', '?main')}
  } ORDER BY STR(?sense) STR(?work) LIMIT 25`, 25);
  const workIds = [...new Set(rows.map(row => row.work!.value))];
  const summaries = new Map((await session.summaries(workIds)).map(summary => [summary.reference, summary]));
  const topics = new Map<string, { sense: string; name: { value: string; language: string;
    direction: 'ltr'; basis: 'fallback' }; sampleCovers: AvatarDescriptor[] }>();
  for (const row of rows) {
    const sense = row.sense?.value, label = row.label?.value, work = row.work?.value;
    const summary = work ? summaries.get(work) : null;
    if (!sense || !label || summary?.status !== 'available' || summary.disclosure !== 'public') continue;
    if (!topics.has(sense) && topics.size < 8) topics.set(sense, { sense,
      name: { value: label, language: row.label?.['xml:lang'] ?? 'en', direction: 'ltr', basis: 'fallback' },
      sampleCovers: [] });
    const topic = topics.get(sense);
    if (topic && topic.sampleCovers.length < 3) topic.sampleCovers.push(summary.avatar);
  }
  const fenced = new Map((await session.summaries(workIds)).map(summary => [summary.reference, summary]));
  if (workIds.some(work => JSON.stringify(summaries.get(work)) !== JSON.stringify(fenced.get(work)))) {
    throw new WorkReadUnavailable('Interest samples changed');
  }
  return { profile: 'home-interests-v1' as const,
    kinds: kinds.map(id => ({ id, available: typeFor(id) !== null })), languages,
    topics: [...topics.values()], topicsStatus: topics.size ? 'curated' as const : 'empty' as const,
    sourcePosition: session.position };
}

export async function readSuggestedFollows(session: WorkReadSession,
  input: { interests?: string; languages?: string }, reader?: { principal: VerifiedPrincipal; agent: string }) {
  const selectedKinds = parseChoices(input.interests, kinds, 6) as HomeInterestKind[];
  const selectedLanguages = parseChoices(input.languages, languages, 8);
  const personal = reader && session.deps.homePersonal
    ? await session.deps.homePersonal.read(reader.principal, reader.agent) : null;
  if (reader && !personal) throw new WorkReadUnavailable('Home preferences are unavailable');
  const effectiveLanguages = selectedLanguages.length ? selectedLanguages : personal?.preferences.contentLanguages ?? [];
  const directory = await readRealmDirectory(new WorkReadSession(session.deps, session.request,
    { language: session.options.language, limit: ONBOARDING_COST.realms }, session.position),
  { sort: 'members' });
  const muted = new Set(personal?.exclusions.filter(item => item.kind === 'realm'
    && item.strength === 'mute').map(item => item.target) ?? []);
  const tagRules = personal?.exclusions.filter(item => item.kind === 'tag') ?? [];
  const followed = reader && session.deps.follows ? await session.deps.follows.matches(reader.principal,
    reader.agent, directory.items.map(item => [item.id])) : null;
  const official = await listOfficialZones(session.deps.environment, { limit: 50 });
  const zoneByRealm = new Map(official.items.map(item => [item.realm, item.zone]));
  const items: { id: string; kind: 'realm' | 'zone'; realm: string; name: typeof directory.items[number]['name'];
    icon: typeof directory.items[number]['icon']; membership: typeof directory.items[number]['membership'];
    reason: { kind: 'popular' | 'matching-kind' | 'official'; interest: HomeInterestKind | null };
    sampleWorks: { id: string; title: typeof directory.items[number]['name'];
      cover: typeof directory.items[number]['icon'] }[] }[] = [];
  const fallback: typeof items = [];
  for (const [index, realm] of directory.items.entries()) {
    if (muted.has(realm.id) || followed?.matches[index]) continue;
    if (personal?.exclusions.some(rule => rule.kind === 'realm' && rule.target === realm.id
      && rule.strength === 'fewer'
      && Number.parseInt(digest([realm.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0)) continue;
    const works = await readRealmWorks(new WorkReadSession(session.deps, session.request,
      { language: session.options.language, limit: ONBOARDING_COST.samples }, session.position), realm.id);
    const candidates = works.items.filter(work => (!effectiveLanguages.length
      || effectiveLanguages.some(language => language.toLowerCase() === work.language.toLowerCase()))
      && !personal?.exclusions.some(rule => rule.kind === 'work' && rule.target === work.id
        && (rule.strength === 'hide' || rule.strength === 'not-interested' || rule.strength === 'fewer'
          && Number.parseInt(digest([work.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0)));
    const samples = [] as typeof candidates;
    for (const work of candidates) {
      if (tagRules.length) {
        const tagSession = new WorkReadSession(session.deps, session.request,
          { language: session.options.language, scope: 'realm', realm: realm.id, limit: 3 }, session.position);
        const tags = await readWorkClassifications(tagSession, work.id, tagRules.map(rule => rule.target));
        if (tagRules.some(rule => tags.items.some(item => item.sense === rule.target)
          && (rule.strength === 'mute' || rule.strength === 'fewer'
            && Number.parseInt(digest([work.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0))) continue;
      }
      samples.push(work);
    }
    const matched = selectedKinds.find(kind => samples.some(work => work.types.includes(typeFor(kind) ?? '')));
    const sampleWorks = samples.slice(0, ONBOARDING_COST.samples).map(work => ({ id: work.id,
      title: work.title, cover: work.cover }));
    const zone = zoneByRealm.get(realm.id);
    const suggestion = { id: zone ?? realm.id, kind: zone ? 'zone' as const : 'realm' as const, realm: realm.id,
      name: realm.name, icon: realm.icon, membership: realm.membership,
      reason: { kind: matched ? 'matching-kind' : zone ? 'official' : 'popular', interest: matched ?? null },
      sampleWorks } as typeof items[number];
    if (selectedKinds.length && !matched) fallback.push(suggestion);
    else items.push(suggestion);
    if (items.length >= ONBOARDING_COST.suggestions) break;
  }
  items.push(...fallback.slice(0, ONBOARDING_COST.suggestions - items.length));
  if (reader && personal && (await session.deps.homePersonal!.read(reader.principal, reader.agent)).revision !== personal.revision) {
    throw new WorkReadMoved('Home suggestions changed');
  }
  if (reader && followed && (await session.deps.follows!.matches(reader.principal, reader.agent, [])).revision !== followed.revision) {
    throw new WorkReadMoved('Follows changed');
  }
  return { profile: 'home-suggested-follows-v1' as const, items, sourcePosition: session.position };
}
