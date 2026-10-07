import type { Static } from 'typebox';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { inOrder } from '../feed/settled.ts';
import { CLASSIFIED_AS, STATEMENT_DECISION_PROFILE } from '../statement/schema.ts';
import { readRealmDirectory } from '../realm-directory/read.ts';
import { readRealmWorks } from '../realm-reads/read-works.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { WorkReadInvalid, WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { listOfficialZones } from '../zone/publication.ts';
import { SUGGESTION_COST, type suggestedFollow, type SuggestionReason } from './contract.ts';

type Suggestion = Static<typeof suggestedFollow>;

/**
 * The chosen Concepts each Work carries in the Global Context, directly or
 * through a narrower Concept one step below: a Work shelved as Xianxia matches
 * a reader who chose Fantasy. One graph query of at most 128 rows.
 */
export async function readConceptMatches(session: WorkReadSession, works: readonly string[],
  chosen: readonly string[]): Promise<Map<string, string[]>> {
  const matches = new Map<string, string[]>(works.map(work => [work, []]));
  if (!works.length || !chosen.length) return matches;
  // ?chosen is bound inside the graph group, where its FILTER is evaluated;
  // bound outside, the FILTER would see it unbound and match any broader Concept.
  const rows = await session.query(`SELECT DISTINCT ?work ?chosen WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} {
      VALUES ?chosen { ${chosen.map(iri).join(' ')} }
      ?work rv:mainVersion ?main .
      ?expression rv:assertedConcept ?concept ; rv:expressionState rv:Active .
      ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:expression ?expression ; rv:head ?revision .
      ?statement a rdf:Statement ; rdf:subject ?main ; rdf:predicate <${CLASSIFIED_AS}> ; rdf:object ?concept ;
        rv:statementState rv:Active ; rv:relationDefinition ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
        rv:interpretationDefinition ?revision ; rv:meaningKey ?key .
      FILTER NOT EXISTS { ?statement rv:applicability ?applicability }
      FILTER NOT EXISTS { ?statement rv:interpretationDefinition ?other FILTER(?other != ?revision) }
      ?slot a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ; rv:decisionTarget ?key ;
        rv:acceptanceContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:decisionHead ?decision .
      FILTER(?concept = ?chosen || EXISTS { ?concept skos:broader ?chosen } || EXISTS { ?chosen skos:narrower ?concept })
    } GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:StatementDecision, rv:RevisionAnchor ;
      rv:component ?slot ; rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
      rv:outcome rv:Accepted ; rv:support ?statement . }
  } LIMIT ${SUGGESTION_COST.conceptRows + 1}`, SUGGESTION_COST.conceptRows);
  for (const row of rows) {
    const work = row.work?.value, concept = row.chosen?.value;
    if (!work || !concept || !matches.has(work) || !chosen.includes(concept)) {
      throw new WorkReadUnavailable('Concept matches exceed their bound');
    }
    if (!matches.get(work)!.includes(concept)) matches.get(work)!.push(concept);
  }
  return matches;
}

/** Any BCP 47 content languages the reader reads, first choice first; the schema checks each tag's form. */
export function parseLanguages(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  if (new Set(values.map(value => value.toLowerCase())).size !== values.length) {
    throw new WorkReadInvalid('Repeated onboarding languages');
  }
  return [...values];
}

type Candidate<T> = { value: T; matches: readonly string[]; languageMatches: number; official: boolean;
  score: number; index: number };

/**
 * Give each chosen Concept a place before filling spare places with other
 * matches, and only then with popular candidates; a Zone is not a match
 * merely because it is official. Ranks at most twelve scanned Realms.
 */
export function selectConceptSuggestions<T>(candidates: readonly Candidate<T>[], concepts: readonly string[],
  limit: number): { value: T; concept: string | null }[] {
  const order = (a: Candidate<T>, b: Candidate<T>) => b.languageMatches - a.languageMatches
    || Number(b.official) - Number(a.official) || b.score - a.score || a.index - b.index;
  const choiceOrder = (a: Candidate<T>, b: Candidate<T>) => Number(b.official) - Number(a.official) || order(a, b);
  const chosen = new Map<Candidate<T>, string | null>();
  for (const concept of concepts) {
    const candidate = candidates.filter(item => item.matches.includes(concept) && !chosen.has(item)).sort(choiceOrder)[0];
    if (candidate && chosen.size < limit) chosen.set(candidate, concept);
  }
  for (const candidate of candidates.filter(item => concepts.some(concept => item.matches.includes(concept))
    && !chosen.has(item)).sort(order)) {
    if (chosen.size >= limit) break;
    chosen.set(candidate, concepts.find(concept => candidate.matches.includes(concept))!);
  }
  for (const candidate of candidates.filter(item => !concepts.some(concept => item.matches.includes(concept)))
    .sort(order)) {
    if (chosen.size >= limit) break;
    chosen.set(candidate, null);
  }
  return [...chosen].sort((a, b) => a[1] === null && b[1] !== null ? 1
    : a[1] !== null && b[1] === null ? -1 : order(a[0], b[0]))
    .map(([candidate, concept]) => ({ value: candidate.value, concept }));
}

const reduced = (key: string[]) => Number.parseInt(digest(key).slice(0, 2), 16) % 4 !== 0;

/**
 * `GET /v1/onboarding/suggested-follows`: Realms and official Zones for the
 * chosen Concepts and languages, each with its reason. A signed-in reader's
 * mutes, hides and existing follows are honoured and rechecked after the read.
 */
export async function readSuggestedFollows(session: WorkReadSession,
  input: { concepts?: string[]; languages?: string[] }, reader?: { principal: VerifiedPrincipal; agent: string }) {
  const concepts = [...input.concepts ?? []];
  const selectedLanguages = parseLanguages(input.languages);
  if (reader && !session.deps.homePersonal) throw new WorkReadUnavailable('Home preferences are unavailable');
  const personal = reader ? await session.deps.homePersonal!.read(reader.principal, reader.agent) : null;
  if (personal) session.readingLanguages = personal.preferences.contentLanguages;
  // Read the preference before names; directory and official Zone heads are independent.
  const [directory, official] = await inOrder(
    readRealmDirectory(new WorkReadSession(session.deps, session.request,
      { language: session.options.language, languages: session.displayLanguages.join(','),
        limit: SUGGESTION_COST.realms }, session.position), { sort: 'activity' }),
    listOfficialZones(session.deps.environment, { limit: SUGGESTION_COST.officialRealms }));
  const effectiveLanguages = selectedLanguages.length ? selectedLanguages : personal?.preferences.contentLanguages ?? [];
  const muted = new Set(personal?.exclusions.filter(item => item.kind === 'realm'
    && item.strength === 'mute').map(item => item.target) ?? []);
  const tagRules = personal?.exclusions.filter(item => item.kind === 'tag') ?? [];
  if (official.next) throw new WorkReadUnavailable('Official Zone candidate bound exceeded');
  const zoneByRealm = new Map(official.items.map(item => [item.realm, item.zone]));
  const candidateRealms: Pick<typeof directory.items[number], 'id' | 'name' | 'icon' | 'membership'>[] =
    directory.items.filter(realm => !zoneByRealm.has(realm.id)).slice(0, SUGGESTION_COST.nonOfficialRealms);
  const officialSummaries = await session.summaries(official.items.map(item => item.realm));
  for (const [position, zone] of official.items.entries()) {
    if (candidateRealms.some(realm => realm.id === zone.realm)) continue;
    const indexed = directory.items.find(realm => realm.id === zone.realm);
    if (indexed) { candidateRealms.push(indexed); continue; }
    const summary = officialSummaries[position];
    if (summary?.status !== 'available' || summary.type !== 'realm' || summary.disclosure !== 'public') continue;
    candidateRealms.push({ id: zone.realm, name: summary.name, icon: summary.avatar,
      membership: { count: { kind: 'unknown', value: null } } });
  }
  const followed = reader && session.deps.follows ? await session.deps.follows.matches(reader.principal,
    reader.agent, candidateRealms.map(item => [item.id])) : null;
  // Each candidate Realm's scan is independent; they run together and any
  // failure surfaces in candidate order, as a serial scan would report it.
  const scanned = await inOrder(...candidateRealms.map(async (realm, index) => {
    if (muted.has(realm.id) || followed?.matches[index]) return null;
    if (personal?.exclusions.some(rule => rule.kind === 'realm' && rule.target === realm.id
      && rule.strength === 'fewer' && reduced([realm.id, rule.kind, rule.target]))) return null;
    const works = await readRealmWorks(new WorkReadSession(session.deps, session.request,
      { language: session.options.language, languages: session.displayLanguages.join(','),
        limit: SUGGESTION_COST.workScan }, session.position), realm.id);
    if (!works.items.length) return null;
    const candidates = works.items.filter(work => !personal?.exclusions.some(rule => rule.kind === 'work'
      && rule.target === work.id && (rule.strength === 'hide' || rule.strength === 'not-interested'
        || rule.strength === 'fewer' && reduced([work.id, rule.kind, rule.target]))));
    const [conceptMatches, tagged] = await inOrder(
      readConceptMatches(session, candidates.map(work => work.id), concepts),
      inOrder(...candidates.map(async work => {
        if (!tagRules.length) return true;
        const tagSession = new WorkReadSession(session.deps, session.request,
          { language: session.options.language, languages: session.displayLanguages.join(','),
            scope: 'realm', realm: realm.id, limit: 3 }, session.position);
        const tags = await readWorkClassifications(tagSession, work.id, tagRules.map(rule => rule.target));
        return !tagRules.some(rule => tags.items.some(item => item.sense === rule.target)
          && (rule.strength === 'mute' || rule.strength === 'fewer' && reduced([work.id, rule.kind, rule.target])));
      })));
    const samples = candidates.filter((_work, position) => tagged[position]);
    if (!samples.length) return null;
    const matches = concepts.filter(concept => samples.some(work => conceptMatches.get(work.id)?.includes(concept)));
    const relevant = (work: typeof samples[number]) => matches.some(concept => conceptMatches.get(work.id)?.includes(concept));
    const matchingWorks = samples.filter(relevant);
    const rankingWorks = matchingWorks.length ? matchingWorks : samples;
    const preferred = (work: typeof samples[number]) => effectiveLanguages.some(language =>
      language.toLowerCase() === work.language.toLowerCase());
    const languageMatches = rankingWorks.filter(preferred).length;
    const sampleWorks = [...samples].sort((a, b) => Number(relevant(b)) - Number(relevant(a))
      || Number(preferred(b)) - Number(preferred(a)))
      .slice(0, SUGGESTION_COST.samples).map(work => ({ id: work.id, title: work.title, cover: work.cover }));
    const zone = zoneByRealm.get(realm.id);
    const popularLanguage = !matches.length && languageMatches ? effectiveLanguages.find(language =>
      samples.some(work => language.toLowerCase() === work.language.toLowerCase())) : undefined;
    const suggestion = { id: zone ?? realm.id, kind: zone ? 'zone' as const : 'realm' as const, realm: realm.id,
      name: realm.name, icon: realm.icon, membership: realm.membership,
      reason: { kind: 'popular' as const, ...(popularLanguage ? { language: popularLanguage } : {}) } as SuggestionReason,
      sampleWorks } satisfies Suggestion;
    const activityRank = directory.items.findIndex(item => item.id === realm.id);
    return { value: suggestion, matches, languageMatches, official: !!zone,
      score: Math.min(rankingWorks.length, SUGGESTION_COST.workScan) * 10
        + (activityRank < 0 ? 0 : directory.items.length - activityRank), index };
  }));
  const selected = selectConceptSuggestions(scanned.filter(candidate => candidate !== null), concepts,
    SUGGESTION_COST.suggestions);
  const matched = [...new Set(selected.flatMap(item => item.concept ? [item.concept] : []))];
  const names = new Map((await session.summaries(matched)).map(summary => [summary.reference, summary]));
  const items: Suggestion[] = selected.map(({ value, concept }) => {
    if (!concept) return value;
    const summary = names.get(concept);
    return { ...value, reason: { kind: 'matching-concept', concept: { id: concept,
      name: summary?.status === 'available' && summary.type === 'concept' ? summary.name : null } } };
  });
  if (reader && personal && (await session.deps.homePersonal!.read(reader.principal, reader.agent)).revision !== personal.revision) {
    throw new WorkReadMoved('Home suggestions changed');
  }
  if (reader && followed && (await session.deps.follows!.matches(reader.principal, reader.agent, [])).revision !== followed.revision) {
    throw new WorkReadMoved('Follows changed');
  }
  return { profile: 'home-suggested-follows-v2' as const, items, sourcePosition: session.position };
}
