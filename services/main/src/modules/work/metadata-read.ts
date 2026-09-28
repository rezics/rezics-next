import type { Static } from 'typebox';
import { direction } from '../media/summary.ts';
import { GRAPHS, iri, lit } from './activate.ts';
import { fenceWorkBasis, readWorkBasis } from './read-header.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from './read-session.ts';
import { recordedLanguageTag } from '../release/languages.ts';
import { checkedEditionV2, checkedMetadataState, metadataComponent, METADATA_DETAILS_V2, METADATA_PROFILE,
  RELEVANCE_POLICY, type MetadataEditionStateV2, type MetadataHeaderState, type MetadataState,
  type recordedRelevance } from './metadata-schema.ts';

export function parsedMetadataState(raw: string): MetadataState | MetadataEditionStateV2 {
  try {
    const value = JSON.parse(raw) as { kind?: string; contentLanguages?: unknown };
    if (value?.kind === 'edition' && Array.isArray(value.contentLanguages)) return checkedEditionV2(value);
    return checkedMetadataState(value);
  } catch { throw new WorkReadUnavailable('Recorded metadata is invalid'); }
}
/** Exact head lookup, one ≤64 KiB state. Missing data behind a pointer is damage, not absence. */
export async function readMetadataHeader(session: WorkReadSession, work: string, revision: string | null) {
  if (!revision) return { revision: null, originalTitle: null, completionStatus: null, localized: [] };
  const empty: MetadataHeaderState = { kind: 'header', originalTitle: null, localized: [] };
  const component = metadataComponent(work, empty);
  const rows = await session.query(`SELECT ?state WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(component)} a rv:WorkMetadataComponent ;
      rv:metadataKind "header" ; rv:work ${iri(work)} ; rv:metadataHead ${iri(revision)} }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:WorkMetadataRevision ;
      rv:component ${iri(component)} ; rv:modelRevision ${iri(METADATA_PROFILE)} ;
      rv:shapeRevision ${iri(METADATA_PROFILE)} ; rv:metadataState ?state }
  } LIMIT 2`, 2);
  if (rows.length !== 1 || !rows[0]?.state) throw new WorkReadUnavailable('Metadata head is incomplete');
  const state = parsedMetadataState(rows[0].state.value);
  if (state.kind !== 'header') throw new WorkReadUnavailable('Metadata head has the wrong kind');
  return { revision, originalTitle: state.originalTitle,
    completionStatus: state.completionStatus ?? null, localized: state.localized };
}
export const recordedDisplayText = (value: { value: string; language: string }) =>
  ({ ...value, direction: direction(value.language) });
export function selectedMetadata(header: { revision?: string | null; originalTitle?: MetadataHeaderState['originalTitle'];
  completionStatus?: MetadataHeaderState['completionStatus']; localized: MetadataHeaderState['localized'] }, requested?: string) {
  const language = requested?.toLowerCase();
  const locale = header.localized.find(row => row.language === language)
    ?? header.localized.find(row => row.language === 'en') ?? header.localized[0];
  const name = (value: string | null | undefined) => value == null || !locale ? null
    : { value, language: locale.language, direction: direction(locale.language),
      basis: language === locale.language ? 'requested' as const : 'fallback' as const };
  return { title: name(locale?.title), description: name(locale?.description),
    tagline: name(locale?.tagline),
    mainVersionLabel: name(locale?.mainVersionLabel) };
}
export async function readWorkMetadata(session: WorkReadSession, work: string) {
  const basis = await readWorkBasis(session, work);
  const header = basis.metadata;
  await fenceWorkBasis(session, basis);
  return { work, ...header, sourcePosition: session.position };
}
/** Candidates precede hydration. Logical O(P), ≤2 queries beyond Work admission;
 * native Jena may scan/sort D edition identities, conservatively O(D log D). */
export async function readWorkEditions(session: WorkReadSession, work: string, contentLanguage?: string) {
  const basis = await readWorkBasis(session, work), limit = session.options.limit ?? 20;
  const language = contentLanguage?.toLowerCase();
  let listed = language ?? null;
  if (contentLanguage) { try { listed = recordedLanguageTag(contentLanguage); } catch { listed = language ?? null; } }
  const binding = ['editions', work, language ?? null, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT ?edition ?revision WHERE {
    GRAPH ${iri(GRAPHS.current)} { { ?edition a rv:WorkMetadataComponent } UNION { ?edition a rv:EditionRecord } .
      ?edition rv:metadataKind "edition" ; rv:work ${iri(work)} ; rv:editionState rv:Active ; rv:metadataHead ?revision .
      ${language ? `FILTER(EXISTS { ?edition rv:editionLanguage ${lit(language)} } || EXISTS { ?edition rv:contentLanguages ?langs .
        FILTER(CONTAINS(CONCAT(" ", STR(?langs), " "), ${lit(` ${listed} `)})) })` : ''}
    } ${cursor ? `FILTER(STR(?edition) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?edition) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.edition || !row.revision)
    || new Set(rows.map(row => row.edition!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Edition identities are ambiguous');
  }
  const page = rows.slice(0, limit);
  const hydrated = page.length ? await session.query(`SELECT ?edition ?revision ?state WHERE {
    VALUES (?edition ?revision) { ${page.map(row => `(${iri(row.edition!.value)} ${iri(row.revision!.value)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:component ?edition ; rv:metadataState ?state ; rv:modelRevision ?model .
      FILTER(?model IN (${iri(METADATA_PROFILE)}, ${iri(METADATA_DETAILS_V2)})) }
  } LIMIT ${limit + 1}`, limit + 1) : [];
  if (hydrated.length !== page.length || new Set(hydrated.map(row => row.edition?.value)).size !== page.length) {
    throw new WorkReadUnavailable('Edition revisions are incomplete');
  }
  const byEdition = new Map(hydrated.map(row => [row.edition?.value, row]));
  const items = page.map(row => {
    const record = byEdition.get(row.edition!.value);
    if (!record?.state) throw new WorkReadUnavailable('Edition payload is missing');
    const state = parsedMetadataState(record.state.value);
    const matches = !language || state.kind === 'edition' && ('contentLanguages' in state
      ? state.contentLanguages.includes(listed ?? language)
      : state.contentLanguage === language);
    if (state.kind !== 'edition' || state.id !== row.edition!.value || state.status !== 'active' || !matches) {
      throw new WorkReadUnavailable('Edition projection differs');
    }
    return { ...state, revision: row.revision!.value };
  });
  await fenceWorkBasis(session, basis);
  return pageResult(session, items, rows.length > limit
    ? encodeReadCursor(binding, session.position, page.at(-1)!.edition!.value) : null);
}

/** A withdrawn edition exposes its tombstone/head for a fresh conditional edit,
 * without redisclosing the withdrawn bibliographic text. */
export async function readWorkEdition(session: WorkReadSession, work: string, edition: string) {
  const basis = await readWorkBasis(session, work);
  const rows = await session.query(`SELECT ?revision ?status ?state WHERE {
    GRAPH ${iri(GRAPHS.current)} { { ${iri(edition)} a rv:WorkMetadataComponent } UNION { ${iri(edition)} a rv:EditionRecord } .
      ${iri(edition)} rv:metadataKind "edition" ;
      rv:work ${iri(work)} ; rv:editionState ?status ; rv:metadataHead ?revision }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:component ${iri(edition)} ; rv:metadataState ?state ;
      rv:modelRevision ?model . FILTER(?model IN (${iri(METADATA_PROFILE)}, ${iri(METADATA_DETAILS_V2)})) } }
  } LIMIT 2`, 2);
  if (!rows.length) throw new WorkReadMissing('Edition is unavailable');
  const row = rows[0];
  if (rows.length !== 1 || !row?.revision || !row.state) throw new WorkReadUnavailable('Edition revision is incomplete');
  const state = parsedMetadataState(row.state.value);
  if (state.kind !== 'edition' || state.id !== edition
    || row.status?.value !== `https://rezics.com/vocab/${state.status === 'active' ? 'Active' : 'Withdrawn'}`) {
    throw new WorkReadUnavailable('Edition projection differs');
  }
  await fenceWorkBasis(session, basis);
  return { id: edition, revision: row.revision.value, status: state.status,
    record: state.status === 'active' ? state : null, sourcePosition: session.position };
}

export interface MetadataRelevanceRead {
  revision: string; status: 'recorded' | 'stale' | 'withdrawn';
  value: Static<typeof recordedRelevance> | null;
}

/** Hydrate only decisions already admitted by the classification reader, in one bounded batch.
 * Assessments belong to the requested scope, including an explicitly inherited decision. */
export async function readMetadataRelevance(session: WorkReadSession, work: string,
  scope: { kind: string; realm: string | null }, accepted: readonly { sense: string; decision: string }[]) {
  const result = new Map<string, MetadataRelevanceRead>();
  if (!accepted.length) return result;
  const context = scope.kind === 'realm' ? { kind: 'realm-classification' as const, id: scope.realm! }
    : { kind: 'global' as const };
  const components = accepted.map(item => ({ ...item, component: metadataComponent(work,
    { kind: 'relevance', sense: item.sense, decision: item.decision, context, level: null }) }));
  const byComponent = new Map(components.map(item => [item.component, item]));
  const rows = await session.query(`SELECT ?component ?revision ?state WHERE {
    VALUES ?component { ${components.map(item => iri(item.component)).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?component a rv:WorkMetadataComponent ;
      rv:work ${iri(work)} ; rv:metadataKind "relevance" ; rv:metadataHead ?revision }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:WorkMetadataRevision ; rv:component ?component ;
      rv:modelRevision ${iri(METADATA_PROFILE)} ; rv:shapeRevision ${iri(METADATA_PROFILE)} ; rv:metadataState ?state } }
  } LIMIT ${accepted.length + 1}`, accepted.length + 1);
  if (new Set(rows.map(row => row.component?.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Relevance heads are ambiguous');
  }
  for (const row of rows) {
    const item = byComponent.get(row.component?.value ?? '');
    if (!item || !row.state || !row.revision) throw new WorkReadUnavailable('Relevance head is incomplete');
    const state = parsedMetadataState(row.state.value);
    if (state.kind !== 'relevance' || state.sense !== item.sense
      || metadataComponent(work, state) !== item.component) throw new WorkReadUnavailable('Relevance basis differs');
    const status = state.level === null ? 'withdrawn' : state.decision !== item.decision ? 'stale' : 'recorded';
    result.set(item.sense, { revision: row.revision.value, status,
      value: status === 'recorded' ? { level: state.level!, policy: RELEVANCE_POLICY,
        basis: 'work-editor-assessment', revision: row.revision.value } : null });
  }
  return result;
}
