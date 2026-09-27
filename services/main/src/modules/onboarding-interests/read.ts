import { readRealmDirectory } from '../realm-directory/read.ts';
import { readRealmWorks } from '../realm-reads/read-works.ts';
import { listOfficialZones } from '../zone/publication.ts';
import { WorkReadInvalid, WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { publicWork } from '../work/read-session.ts';
import type { AvatarDescriptor } from '../media/summary.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { HomeInterestKind } from './contract.ts';
import { ONBOARDING_COST } from './contract.ts';
import { interestKinds, interestSources, matchingActivityKinds, matchingWorkKinds } from './kinds.ts';

const languages = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
const workTypes = [...new Set(interestKinds.flatMap(kind => interestSources[kind].workTypes))];
const terms = [...new Set(interestKinds.flatMap(kind => interestSources[kind].classificationTerms))];
const workTypeSet = new Set<string>(workTypes);
const termSet = new Set<string>(terms);
const typeValues = workTypes.map(type => `<${type}>`).join(' ');
const termValues = terms.map(lit).join(', ');

async function readMediaAvailable(session: WorkReadSession): Promise<boolean> {
  const media = interestSources.media;
  const rows = await session.query(`SELECT ?work WHERE {
    { GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
      VALUES ?type { ${media.workTypes.map(type => `<${type}>`).join(' ')} } }
    UNION {
      GRAPH ${iri(GRAPHS.current)} {
        ?application a rv:ClassificationApplication ; rv:targetMainVersion ?main ;
          rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:applicationState rv:Active ; rv:sense ?sense ; rv:decisionHead ?decision .
        ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:expression ?expression .
        ?expression rv:assertedConcept ?concept . ?concept skos:prefLabel ?label .
        ?main rv:work ?work .
      } GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:outcome rv:Accepted . }
      FILTER(LCASE(STR(?label)) IN (${media.classificationTerms.map(lit).join(', ')}))
    }
    ${publicWork('?work', '?main')}
  } LIMIT 1`, 1);
  return rows.length > 0;
}

export async function readWorkKindMatches(session: WorkReadSession, works: readonly string[]) {
  const matches = new Map<string, HomeInterestKind[]>();
  if (!works.length) return matches;
  const rows = await session.query(`SELECT DISTINCT ?work ?type ?term WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    { GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
      VALUES ?type { ${typeValues} } }
    UNION {
      GRAPH ${iri(GRAPHS.current)} {
        ?work rv:mainVersion ?main .
        ?application a rv:ClassificationApplication ; rv:targetMainVersion ?main ;
          rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:applicationState rv:Active ; rv:sense ?sense ; rv:decisionHead ?decision .
        ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:expression ?expression .
        ?expression rv:assertedConcept ?concept . ?concept skos:prefLabel ?label .
      } GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:outcome rv:Accepted . }
      BIND(LCASE(STR(?label)) AS ?term)
      FILTER(?term IN (${termValues}))
    }
  } LIMIT ${ONBOARDING_COST.interestRows + 1}`, ONBOARDING_COST.interestRows + 1);
  if (rows.length > ONBOARDING_COST.interestRows || rows.some(row => !row.work
    || !works.includes(row.work.value) || row.type && !workTypeSet.has(row.type.value)
    || row.term && !termSet.has(row.term.value))) {
    throw new WorkReadUnavailable('Interest Work relation exceeds its bound');
  }
  for (const work of works) {
    const hits = rows.filter(row => row.work?.value === work);
    matches.set(work, matchingWorkKinds(hits.flatMap(row => row.type ? [row.type.value] : []),
      hits.flatMap(row => row.term ? [row.term.value] : [])));
  }
  return matches;
}

async function realmHasDiscussion(session: WorkReadSession, realm: string): Promise<boolean> {
  const rows = await session.query(`SELECT ?placement WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?slot a rv:RealmReplySlot ; rv:realm ${iri(realm)} ; rv:rootTarget ?work ;
        rv:replyPlacementHead ?placement .
    } GRAPH ${iri(GRAPHS.revisions)} {
      ?placement a rv:RealmReplyPlacement ; rv:placementOutcome rv:Accepted .
    }
    ${publicWork('?work', '?main')}
  } LIMIT 1`, 1);
  return rows.length > 0;
}
export function parseChoices(value: string | undefined, allowed: readonly string[], maximum: number) {
  if (!value) return [];
  const choices = value.split(',').map(item => item.trim()).filter(Boolean);
  if (choices.length > maximum || new Set(choices).size !== choices.length
    || choices.some(item => !allowed.includes(item))) throw new WorkReadInvalid('Invalid onboarding choices');
  return choices;
}

/** Match and official identity outrank the activity page's existing order. */
export function rankSuggestedFollows<T>(candidates: readonly { value: T; matchingOfficial: boolean;
  score: number; index: number }[], limit: number): T[] {
  return [...candidates].sort((a, b) => Number(b.matchingOfficial) - Number(a.matchingOfficial)
    || b.score - a.score || a.index - b.index).slice(0, limit).map(item => item.value);
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
  const mediaAvailable = await readMediaAvailable(session);
  return { profile: 'home-interests-v1' as const,
    kinds: interestKinds.map(id => ({ id, available: id !== 'media' || mediaAvailable })), languages,
    topics: [...topics.values()], topicsStatus: topics.size ? 'curated' as const : 'empty' as const,
    sourcePosition: session.position };
}

export async function readSuggestedFollows(session: WorkReadSession,
  input: { interests?: string; languages?: string }, reader?: { principal: VerifiedPrincipal; agent: string }) {
  const selectedKinds = parseChoices(input.interests, interestKinds, 6) as HomeInterestKind[];
  const selectedLanguages = parseChoices(input.languages, languages, 8);
  const personal = reader && session.deps.homePersonal
    ? await session.deps.homePersonal.read(reader.principal, reader.agent) : null;
  if (reader && !personal) throw new WorkReadUnavailable('Home preferences are unavailable');
  const effectiveLanguages = selectedLanguages.length ? selectedLanguages : personal?.preferences.contentLanguages ?? [];
  const directory = await readRealmDirectory(new WorkReadSession(session.deps, session.request,
    { language: session.options.language, limit: ONBOARDING_COST.realms }, session.position),
  { sort: 'activity' });
  const muted = new Set(personal?.exclusions.filter(item => item.kind === 'realm'
    && item.strength === 'mute').map(item => item.target) ?? []);
  const tagRules = personal?.exclusions.filter(item => item.kind === 'tag') ?? [];
  const official = await listOfficialZones(session.deps.environment, { limit: ONBOARDING_COST.officialRealms });
  if (official.next) throw new WorkReadUnavailable('Official Zone candidate bound exceeded');
  const zoneByRealm = new Map(official.items.map(item => [item.realm, item.zone]));
  const candidateRealms: Pick<typeof directory.items[number], 'id' | 'name' | 'icon' | 'membership'>[] =
    directory.items.filter(realm => !zoneByRealm.has(realm.id)).slice(0, ONBOARDING_COST.nonOfficialRealms);
  const officialSummaries = await session.summaries(official.items.map(item => item.realm));
  for (const zone of official.items) {
    if (candidateRealms.some(realm => realm.id === zone.realm)) continue;
    const indexed = directory.items.find(realm => realm.id === zone.realm);
    if (indexed) { candidateRealms.push(indexed); continue; }
    const summary = officialSummaries[official.items.indexOf(zone)];
    if (summary?.status !== 'available' || summary.type !== 'realm'
      || summary.disclosure !== 'public') continue;
    candidateRealms.push({ id: zone.realm, name: summary.name, icon: summary.avatar,
      membership: { count: { kind: 'unknown', value: null } } });
  }
  const followed = reader && session.deps.follows ? await session.deps.follows.matches(reader.principal,
    reader.agent, candidateRealms.map(item => [item.id])) : null;
  const items: { id: string; kind: 'realm' | 'zone'; realm: string; name: typeof directory.items[number]['name'];
    icon: typeof directory.items[number]['icon']; membership: typeof directory.items[number]['membership'];
    reason: { kind: 'popular' | 'matching-kind' | 'official'; interest: HomeInterestKind | null };
    sampleWorks: { id: string; title: typeof directory.items[number]['name'];
      cover: typeof directory.items[number]['icon'] }[] }[] = [];
  const ranked: { value: typeof items[number]; score: number; index: number;
    matchingOfficial: boolean }[] = [];
  for (const [index, realm] of candidateRealms.entries()) {
    if (muted.has(realm.id) || followed?.matches[index]) continue;
    if (personal?.exclusions.some(rule => rule.kind === 'realm' && rule.target === realm.id
      && rule.strength === 'fewer'
      && Number.parseInt(digest([realm.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0)) continue;
    const works = await readRealmWorks(new WorkReadSession(session.deps, session.request,
      { language: session.options.language, limit: ONBOARDING_COST.workScan }, session.position), realm.id);
    if (!works.items.length) continue;
    const candidates = works.items.filter(work => (!effectiveLanguages.length
      || effectiveLanguages.some(language => language.toLowerCase() === work.language.toLowerCase()))
      && !personal?.exclusions.some(rule => rule.kind === 'work' && rule.target === work.id
        && (rule.strength === 'hide' || rule.strength === 'not-interested' || rule.strength === 'fewer'
          && Number.parseInt(digest([work.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0)));
    const kindMatches = await readWorkKindMatches(session, candidates.map(work => work.id));
    const hasDiscussion = selectedKinds.includes('discussions')
      && await realmHasDiscussion(session, realm.id);
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
    if (!samples.length) continue;
    const matched = selectedKinds.find(kind => samples.some(work => kindMatches.get(work.id)?.includes(kind))
      || kind === 'discussions' && hasDiscussion
        && matchingActivityKinds('discussion').includes(kind));
    const sampleWorks = samples.slice(0, ONBOARDING_COST.samples).map(work => ({ id: work.id,
      title: work.title, cover: work.cover }));
    const zone = zoneByRealm.get(realm.id);
    const suggestion = { id: zone ?? realm.id, kind: zone ? 'zone' as const : 'realm' as const, realm: realm.id,
      name: realm.name, icon: realm.icon, membership: realm.membership,
      reason: { kind: matched ? 'matching-kind' : zone ? 'official' : 'popular', interest: matched ?? null },
      sampleWorks } as typeof items[number];
    const activityRank = directory.items.findIndex(item => item.id === realm.id);
    ranked.push({ value: suggestion, matchingOfficial: !!zone && !!matched,
      score: (matched ? 1_000 : 0) + Math.min(samples.length, ONBOARDING_COST.workScan) * 10
        + (activityRank < 0 ? 0 : directory.items.length - activityRank), index });
  }
  items.push(...rankSuggestedFollows(ranked, ONBOARDING_COST.suggestions));
  if (reader && personal && (await session.deps.homePersonal!.read(reader.principal, reader.agent)).revision !== personal.revision) {
    throw new WorkReadMoved('Home suggestions changed');
  }
  if (reader && followed && (await session.deps.follows!.matches(reader.principal, reader.agent, [])).revision !== followed.revision) {
    throw new WorkReadMoved('Follows changed');
  }
  return { profile: 'home-suggested-follows-v1' as const, items, sourcePosition: session.position };
}
