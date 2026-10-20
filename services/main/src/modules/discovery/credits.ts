import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { publicAgent } from '../profiles/read.ts';
import { visibleNames } from '../disclosure/name-policy.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import { agentAddress } from '../agent/handle.ts';
import { readDeletedPersonAttributions, type CreditAttribution } from '../profiles/attribution.ts';
import { sourceReportedCredits } from '../source/author-name-read.ts';
import { DISCOVERY_COST, type ProjectedWork } from './contract.ts';
import { isNativeCreditRole, type NativeCreditRole } from '../work/credit-roles.ts';
import { optionalPreview } from '../query/optional-preview.ts';
import { invalidWorkReadSource } from '../work/read-source-fault.ts';

export const DISCOVERY_CREDIT_BATCH_COST = { works: 64, queries: 1, rows: 192 } as const;
/** Each Work retains its own ordered three-credit seek. Literal Work keys keep
 * the graph joins local; source-reported attributions share one owner batch. */
export async function primaryDiscoveryCreditBatch(session: WorkReadSession, works: readonly string[],
  preview = false, unavailable = new Set<string>()) {
  const unique = [...new Set(works)];
  if (unique.length > DISCOVERY_CREDIT_BATCH_COST.works) throw new WorkReadUnavailable('Discovery credit batch is out of bounds');
  const result = new Map<string, ProjectedWork['primaryCredits']>();
  if (!unique.length) return result;
  const seeks = unique.map(work => `{ SELECT ?work ?id ?key ?ordinal ?agent ?role ?provider ?namespace WHERE { BIND(${iri(work)} AS ?work)
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:AuthorCredit ; rv:work ${iri(work)} ;
        rv:creditRevision ?revision ; schema:roleName ?role ; rv:externalProvider ?provider ;
        rv:externalNamespace ?namespace ; rv:externalKey ?key ; schema:position ?ordinal ; rv:editControl rv:HumanConfirmed . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:AuthorCreditRevision ; rv:component ?id ;
        rv:work ${iri(work)} ; schema:roleName ?role ; rv:externalProvider ?provider ;
        rv:externalNamespace ?namespace ; rv:externalKey ?key ; schema:position ?ordinal .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
    UNION
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:NativeAgentCredit ; rv:work ${iri(work)} ;
        rv:creditRevision ?revision ; rv:agent ?agent ; schema:roleName ?role . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision ; rv:component ?id ;
        rv:work ${iri(work)} ; rv:agent ?agent ; schema:roleName ?role .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?id rv:retiredBy ?retirement } }
  } ORDER BY ?ordinal STR(?id) LIMIT ${DISCOVERY_COST.primaryCredits} }`).join(' UNION ');
  const all = await session.query(`SELECT ?work ?id ?key ?ordinal ?agent ?role ?provider ?namespace WHERE { ${seeks} }`,
    unique.length * DISCOVERY_COST.primaryCredits);
  if (all.some(row => !row.work || !unique.includes(row.work.value))) {
    throw invalidWorkReadSource('Discovery credit Work is incomplete');
  }
  const readReports = () => sourceReportedCredits(session, unique, DISCOVERY_COST.primaryCredits, preview);
  const reports = preview ? await optionalPreview(session, readReports) : await readReports();
  // A failed optional Source lookup does not withdraw a confirmed attribution.
  if (!reports) for (const work of unique) unavailable.add(work);
  for (const work of unique) {
    const rows = all.filter(row => row.work?.value === work);
    if (rows.some(row => !row.id || !row.role || !isNativeCreditRole(row.role.value)
      || (!row.agent && (!row.provider || !row.namespace)) || (!row.agent && (!row.key || !/^\d+$/.test(row.ordinal?.value ?? '')
      || !Number.isSafeInteger(Number(row.ordinal?.value)))) || (row.agent && (row.key || row.ordinal)))
      || new Set(rows.map(row => row.id!.value)).size !== rows.length) {
      if (preview) { unavailable.add(work); continue; }
      throw invalidWorkReadSource('Discovery credits are ambiguous');
    }
    const confirmed: ProjectedWork['primaryCredits'] = rows.map(row => row.agent
      ? { id: row.id!.value, role: row.role!.value as NativeCreditRole, participantKind: 'agent',
      provider: null, key: null, ordinal: null, agent: row.agent.value, displayName: null, handle: null }
      : ({ id: row.id!.value, role: row.role!.value as NativeCreditRole, participantKind: 'external-reference',
      provider: row.provider!.value, namespace: row.namespace!.value, key: row.key!.value, ordinal: Number(row.ordinal!.value),
      agent: null, displayName: null, handle: null }));
    const reported = reports?.get(work) ?? [];
    const confirmedKeys = new Set(confirmed.map(credit => creditIdentity(credit)));
    result.set(work, [...confirmed, ...reported.filter(credit =>
      credit.participantKind === 'external-reference' && !confirmedKeys.has(creditIdentity(credit)))]
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
  if (!agents.length) return new Map<string, CreditAttribution>();
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
    throw invalidWorkReadSource('Discovery Agent names are ambiguous');
  }
  const named = new Map<string, CreditAttribution>();
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
    named.set(agent, { identityStatus: 'active', displayName: row.displayName!.value, handle: name.handle,
      address: agentAddress(agent, name.handle) });
  }
  for (const agent of damaged) named.delete(agent);
  const missing = agents.filter(agent => !named.has(agent));
  const readDeleted = () => readDeletedPersonAttributions(session, missing, preview ? 'preview' : 'required');
  const deleted = preview ? await optionalPreview(session, readDeleted) : await readDeleted();
  for (const [agent, attribution] of deleted ?? []) named.set(agent, attribution);
  // Handles and deleted-credit enrichment can outlive the opening name read.
  // Recheck the same owner before any retained live name leaves this adapter.
  const liveAgents = [...named].filter(([, attribution]) => attribution.identityStatus === 'active').map(([agent]) => agent);
  if (liveAgents.length) {
    const readVisible = () => visibleNames(session.deps.personPreferences, liveAgents, session.viewer ?? ANONYMOUS_VIEWER);
    const current = preview ? await optionalPreview(session, readVisible) : await readVisible();
    for (const agent of liveAgents) if (!current?.has(agent)) named.delete(agent);
  }
  return named;
}

/** Source reports and confirmations coalesce only for the same qualified participant and role. */
export function creditIdentity(credit: { provider: string | null; namespace?: string; key: string | null; role: string }) {
  return JSON.stringify([credit.provider, credit.namespace ?? 'author', credit.key, credit.role]);
}
