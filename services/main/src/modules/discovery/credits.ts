import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { publicAgent } from '../profiles/read.ts';
import { allocateAgentHandle } from '../agent/handle.ts';
import { sourceReportedCredits } from '../source/author-name-read.ts';
import { DISCOVERY_COST, type ProjectedWork } from './contract.ts';
import { optionalPreview } from '../query/optional-preview.ts';

/** One bounded source query. External references retain their explicit absent
 * name; Agent names and handles are hydrated at read time from current owners. */
export async function primaryDiscoveryCredits(session: WorkReadSession, work: string): Promise<ProjectedWork['primaryCredits']> {
  const rows = await session.query(`SELECT ?id ?key ?ordinal ?agent WHERE {
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
  } ORDER BY ?ordinal STR(?id) LIMIT ${DISCOVERY_COST.primaryCredits}`, DISCOVERY_COST.primaryCredits);
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
  const reported = (await sourceReportedCredits(session, [work])).get(work) ?? [];
  const confirmedKeys = new Set(confirmed.flatMap(credit => credit.key !== null ? [credit.key] : []));
  return [...confirmed, ...reported.filter(credit => !confirmedKeys.has(credit.key))]
    .sort((a, b) => (a.ordinal ?? -1) - (b.ordinal ?? -1) || a.id.localeCompare(b.id))
    .slice(0, DISCOVERY_COST.primaryCredits);
}

/** At most 60 projected Agent mentions per page and one graph name read. */
export async function namedDiscoveryCredits(session: WorkReadSession,
  credits: readonly ProjectedWork['primaryCredits'][number][], maxWorks: number = DISCOVERY_COST.pageSize,
  preview = false) {
  const agents = [...new Set(credits.flatMap(credit => credit.agent ? [credit.agent] : []))];
  if (agents.length > maxWorks * DISCOVERY_COST.primaryCredits) {
    throw new WorkReadUnavailable('Discovery Agent credit batch is out of bounds');
  }
  if (!agents.length) return new Map<string, { displayName: string; handle: string }>();
  const rows = await session.query(`SELECT ?agent ?displayName ?handle WHERE {
    VALUES ?agent { ${agents.map(iri).join(' ')} }
    ${publicAgent('?agent')}
  } LIMIT ${agents.length + 1}`, agents.length + 1);
  if (!preview && (new Set(rows.map(row => row.agent?.value)).size !== rows.length
    || rows.some(row => !row.agent || !row.displayName || !agents.includes(row.agent.value)
      || !row.displayName.value || row.displayName.value.length > 200))) {
    throw new WorkReadUnavailable('Discovery Agent names are ambiguous');
  }
  const named = new Map<string, { displayName: string; handle: string }>();
  const seen = new Set<string>(), damaged = new Set<string>();
  for (const row of rows) {
    if (preview && (!row.agent || !row.displayName || !agents.includes(row.agent.value)
      || !row.displayName.value || row.displayName.value.length > 200 || seen.has(row.agent.value))) {
      if (row.agent) damaged.add(row.agent.value);
      continue;
    }
    const agent = row.agent!.value;
    seen.add(agent);
    const readHandle = async () => await session.deps.agentHandles?.current(agent)
      ?? row.handle?.value ?? allocateAgentHandle(agent);
    const handle = preview ? await optionalPreview(session, readHandle) : await readHandle();
    if (handle === null) continue;
    named.set(agent, { displayName: row.displayName!.value, handle });
  }
  for (const agent of damaged) named.delete(agent);
  return named;
}
