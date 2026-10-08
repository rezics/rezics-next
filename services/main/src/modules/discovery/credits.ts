import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { publicAgent } from '../profiles/read.ts';
import { visibleNames } from '../disclosure/name-policy.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import { agentAddress } from '../agent/handle.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import { sourceReportedCredits } from '../source/author-name-read.ts';
import { DISCOVERY_COST, type ProjectedWork } from './contract.ts';
import { optionalPreview } from '../query/optional-preview.ts';

export const DISCOVERY_CREDIT_BATCH_COST = { works: 64, queries: 1, rows: 192 } as const;
/** Each Work retains its own ordered three-credit seek. Literal Work keys keep
 * the graph joins local; source-reported attributions share one owner batch. */
export async function primaryDiscoveryCreditBatch(session: WorkReadSession, works: readonly string[]) {
  const unique = [...new Set(works)];
  if (unique.length > DISCOVERY_CREDIT_BATCH_COST.works) throw new WorkReadUnavailable('Discovery credit batch is out of bounds');
  const result = new Map<string, ProjectedWork['primaryCredits']>();
  if (!unique.length) return result;
  const seeks = unique.map(work => `{ SELECT ?work ?id ?key ?ordinal ?agent WHERE { BIND(${iri(work)} AS ?work)
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:AuthorCredit ; rv:work ${iri(work)} ;
        rv:creditRevision ?revision ; schema:roleName "author" ; rv:externalProvider "open-library" ;
        rv:externalNamespace "author" ; rv:externalKey ?key ; schema:position ?ordinal ; rv:editControl rv:HumanConfirmed . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:AuthorCreditRevision ; rv:component ?id ;
        rv:work ${iri(work)} ; rv:externalKey ?key ; schema:position ?ordinal .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
    UNION
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:NativeAgentCredit ; rv:work ${iri(work)} ;
        rv:creditRevision ?revision ; rv:agent ?agent ; schema:roleName "author" . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision ; rv:component ?id ;
        rv:work ${iri(work)} ; rv:agent ?agent ; schema:roleName "author" .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
  } ORDER BY ?ordinal STR(?id) LIMIT ${DISCOVERY_COST.primaryCredits} }`).join(' UNION ');
  const all = await session.query(`SELECT ?work ?id ?key ?ordinal ?agent WHERE { ${seeks} }`,
    unique.length * DISCOVERY_COST.primaryCredits);
  if (all.some(row => !row.work || !unique.includes(row.work.value))) {
    throw new WorkReadUnavailable('Discovery credit Work is incomplete');
  }
  const reports = await sourceReportedCredits(session, unique);
  for (const work of unique) {
    const rows = all.filter(row => row.work?.value === work);
    if (rows.some(row => !row.id || (!row.agent && (!row.key || !/^\d+$/.test(row.ordinal?.value ?? '')
      || !Number.isSafeInteger(Number(row.ordinal?.value)))) || (row.agent && (row.key || row.ordinal)))
      || new Set(rows.map(row => row.id!.value)).size !== rows.length) {
      throw new WorkReadUnavailable('Discovery credits are ambiguous');
    }
    const confirmed: ProjectedWork['primaryCredits'] = rows.map(row => row.agent
      ? { id: row.id!.value, role: 'author', participantKind: 'agent',
      provider: null, key: null, ordinal: null, agent: row.agent.value, displayName: null, handle: null }
      : ({ id: row.id!.value, role: 'author', participantKind: 'external-reference',
      provider: 'open-library', key: row.key!.value, ordinal: Number(row.ordinal!.value),
      agent: null, displayName: null, handle: null }));
    const reported = reports.get(work) ?? [];
    const confirmedKeys = new Set(confirmed.flatMap(credit => credit.key !== null ? [credit.key] : []));
    result.set(work, [...confirmed, ...reported.filter(credit =>
      credit.participantKind === 'external-reference' && !confirmedKeys.has(credit.key))]
      .sort((a, b) => (a.ordinal ?? -1) - (b.ordinal ?? -1) || a.id.localeCompare(b.id))
      .slice(0, DISCOVERY_COST.primaryCredits));
  }
  return result;
}

export async function primaryDiscoveryCredits(session: WorkReadSession, work: string): Promise<ProjectedWork['primaryCredits']> {
  return (await primaryDiscoveryCreditBatch(session, [work])).get(work)!;
}

/** At most 60 projected Agent mentions on the default page, one graph name
 * read, and one name-policy read per 64 owners. A withheld name is absent
 * from the map. */
export async function namedDiscoveryCredits(session: WorkReadSession,
  credits: readonly ProjectedWork['primaryCredits'][number][], maxWorks: number = DISCOVERY_COST.pageSize,
  preview = false) {
  const agents = [...new Set(credits.flatMap(credit => credit.agent ? [credit.agent] : []))];
  if (agents.length > maxWorks * DISCOVERY_COST.primaryCredits) {
    throw new WorkReadUnavailable('Discovery Agent credit batch is out of bounds');
  }
  if (!agents.length) return new Map<string, { displayName: string; handle: string | null; address?: CanonicalAddress }>();
  const [rows, visible] = await Promise.all([
    session.query(`SELECT ?agent ?displayName ?handle WHERE {
    VALUES ?agent { ${agents.map(iri).join(' ')} }
    ${publicAgent('?agent')}
  } LIMIT ${agents.length + 1}`, agents.length + 1),
    visibleNames(session.deps.personPreferences, agents, session.viewer ?? ANONYMOUS_VIEWER),
  ]);
  if (!preview && (new Set(rows.map(row => row.agent?.value)).size !== rows.length
    || rows.some(row => !row.agent || !row.displayName || !agents.includes(row.agent.value)
      || !row.displayName.value || row.displayName.value.length > 200))) {
    throw new WorkReadUnavailable('Discovery Agent names are ambiguous');
  }
  const named = new Map<string, { displayName: string; handle: string | null; address?: CanonicalAddress }>();
  const seen = new Set<string>(), damaged = new Set<string>();
  for (const row of rows) {
    if (preview && (!row.agent || !row.displayName || !agents.includes(row.agent.value)
      || !row.displayName.value || row.displayName.value.length > 200 || seen.has(row.agent.value))) {
      if (row.agent) damaged.add(row.agent.value);
      continue;
    }
    const agent = row.agent!.value;
    seen.add(agent);
    if (!visible.has(agent)) continue;
    // Null is a complete unnamed profile, not an unavailable preview.
    const readName = async () => ({ handle: await session.deps.agentHandles?.current(agent) ?? null });
    const name = preview ? await optionalPreview(session, readName) : await readName();
    if (name === null) continue;
    named.set(agent, { displayName: row.displayName!.value, handle: name.handle,
      address: agentAddress(agent, name.handle) });
  }
  for (const agent of damaged) named.delete(agent);
  return named;
}
