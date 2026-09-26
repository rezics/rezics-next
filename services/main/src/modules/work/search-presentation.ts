import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { createPresentationMuteFilter,
  type ActivePresentationMute } from '../presentation/realm-mutes.ts';
import { PublicQueryUnavailable } from './search-budget.ts';
import { MAX_SEARCH_RESPONSE_BYTES, SearchSnapshotMoved } from './search-readiness.ts';

interface WorkSearchMatch {
  contribution: string;
  reason?: string;
}
interface WorkSearchRelation<T extends WorkSearchMatch> {
  results: T[];
  total: number;
  context: 'main-version-default' | { kind: 'realm-local'; id: string };
  sourcePosition: { dataEpoch: string; sequence: string };
}

async function authorsFor(env: WorkActivationEnvironment,
  position: { dataEpoch: string; sequence: string }, contributions: readonly string[]) {
  const unique = [...new Set(contributions)];
  if (unique.length > 512) throw new PublicQueryUnavailable('author hydration exceeds result budget');
  if (!unique.length) return new Map<string, string>();
  const values = unique.map(iri).join(' ');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?sequence ?contribution ?author WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      FILTER(?epoch = ${lit(position.dataEpoch)})
      VALUES ?contribution { ${values} }
      GRAPH ${iri(GRAPHS.current)} {
        ?contribution a rv:TextContribution ; rv:author ?author . }
    } LIMIT 513`, MAX_SEARCH_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  if (rows.some(row => row.epoch?.value === position.dataEpoch
    && row.sequence?.value !== position.sequence)) {
    throw new SearchSnapshotMoved('search author hydration crossed graph positions');
  }
  const authors = new Map<string, string>();
  for (const row of rows) {
    const contribution = row.contribution?.value, author = row.author?.value;
    if (!contribution || !author || !unique.includes(contribution)
      || authors.has(contribution) || row.epoch?.value !== position.dataEpoch
      || row.sequence?.value !== position.sequence) {
      throw new PublicQueryUnavailable('search author hydration is incomplete');
    }
    authors.set(contribution, author);
  }
  if (authors.size !== unique.length) {
    throw new PublicQueryUnavailable('search author hydration omitted a Contribution');
  }
  return authors;
}

/** Applies a principal's current Access selection to the complete public Work
 * relation before counts, ranking pages or continuation digests are emitted. */
export async function applyWorkSearchMutes<T extends WorkSearchMatch>(env: WorkActivationEnvironment,
  relation: WorkSearchRelation<T>, mutes: readonly ActivePresentationMute[],
  memberships: (authors: readonly string[], realms: readonly string[]) =>
    Promise<Map<string, string[]>>) {
  if (!mutes.length) return relation;
  const needsAuthor = mutes.some(mute => mute.match === 'author'
    || mute.match === 'author-membership');
  const authors = needsAuthor
    ? await authorsFor(env, relation.sourcePosition, relation.results.map(row => row.contribution))
    : new Map<string, string>();
  const membershipRealms = mutes.filter(mute => mute.match === 'author-membership')
    .map(mute => mute.target);
  const membershipsByAuthor = membershipRealms.length
    ? await memberships([...new Set(authors.values())], membershipRealms)
    : new Map<string, string[]>();
  const filter = createPresentationMuteFilter(mutes);
  const realm = relation.context === 'main-version-default' ? null : relation.context.id;
  const visible = relation.results.filter(row => {
    const author = authors.get(row.contribution) ?? null;
    if (needsAuthor && !author) throw new PublicQueryUnavailable('search author fact is missing');
    return !filter.hides({ author,
      publishingRealm: row.reason === 'realm-adoption' ? realm : null,
      publicationContext: realm,
      authorMembershipRealms: author ? membershipsByAuthor.get(author) ?? [] : [] });
  });
  return { ...relation, total: visible.length, results: visible };
}
