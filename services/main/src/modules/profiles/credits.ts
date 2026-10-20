import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';
import { adoptAuthorCredit, creditProfile, validExternalReference, AuthorCreditConflict, AuthorCreditUnavailable,
  type AuthorCreditValue } from '../work/author-credit.ts';
import { fenceWorkBasis, readWorkBasis } from '../work/read-header.ts';
import { pageResult, WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { isNativeCreditRole, type NativeCreditRole } from '../work/read-contract.ts';
import { field, nextPage, pageBasis, publicAgent } from './read.ts';
import { readCreditAttribution } from './attribution.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface NativeCreditInput { work: string; credit: string; agent?: string;
  participant?: { kind: 'external-reference'; provider: string; namespace: string; key: string }; ordinal?: number;
  role: NativeCreditRole; expectedWorkHead: string; actingSubject: string }

async function creditedAgentVisible(env: MainWorkDependencies['environment'], agent: string) {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    ASK { ${publicAgent(iri(agent))} }`);
  return result.boolean === true;
}

export function nativeCreditDigest(input: NativeCreditInput, modelRevision?: string) {
  if (![input.work, input.credit, input.expectedWorkHead, input.actingSubject].every(id => nativeId.test(id))
    || !isNativeCreditRole(input.role)
    || (input.agent ? !nativeId.test(input.agent) || input.participant !== undefined || input.ordinal !== undefined
      : !input.participant || !validExternalReference(input.participant)
        || !Number.isInteger(input.ordinal ?? 0) || (input.ordinal ?? 0) < 0 || (input.ordinal ?? 0) > 127)) throw new WorkReadInvalid('Invalid native Agent credit');
  const selected = creditProfile({ agent: input.agent, role: input.role, modelRevision });
  return hash(JSON.stringify({ profile: selected.endsWith('-v2') ? selected : 'native-agent-credit-v1', work: input.work, credit: input.credit,
    ...(input.agent ? { agent: input.agent } : { participant: input.participant, ordinal: input.ordinal ?? 0 }), role: input.role, expectedWorkHead: input.expectedWorkHead, actingSubject: input.actingSubject }));
}

/** Work-edit authority makes an attribution assertion, not an Agent ownership
 * claim. Participants retain their native identity or provider qualification.
 * At most 16 graph/health calls including terminal reconciliation; each command
 * has a ten-second deadline. No relation is materialized. Duplicate detection
 * may inspect the Work/Agent degree in Jena; it is not a measured seek bound. */
export async function createNativeCredit(deps: MainWorkDependencies, request: Request,
  input: NativeCreditInput, key: string) {
  const digest = nativeCreditDigest(input);
  const agent = input.agent;
  const visible = async () => !agent || !!deps.profiles
    && !!await deps.profiles.agentFence(agent) && await creditedAgentVisible(deps.environment, agent);
  if (!await visible()) throw new WorkReadMissing('Agent unavailable');
  const participant = input.participant;
  const value: AuthorCreditValue = { work: input.work, credit: input.credit, revision: input.credit,
    expectedHead: input.expectedWorkHead, actingSubject: input.actingSubject,
    sourceKey: participant?.key ?? '', sourceRoleKey: null, nativeOrdinal: input.ordinal ?? 0,
    role: input.role, ...(agent ? { agent } : { provider: participant!.provider, namespace: participant!.namespace }) };
  try {
    const { receipt, replayed } = await adoptAuthorCredit(deps.environment, deps.account, deps.access,
      request, value, input.credit, key, { digest, visible });
    return { profile: 'native-agent-credit-v1' as const, credit: input.credit, revision: receipt.revision,
      work: input.work, agent: agent ?? null, ...(participant ? { participant, ordinal: input.ordinal ?? 0 } : {}),
      role: input.role, replayed, sourcePosition: { dataEpoch: receipt.dataEpoch, sequence: receipt.sequence } };
  } catch (error) {
    if (error instanceof AuthorCreditConflict) throw new WorkReadMoved(error.message);
    if (error instanceof AuthorCreditUnavailable && !await visible()) throw new WorkReadMissing('Agent unavailable');
    throw error;
  }
}

export async function readNativeCredits(session: WorkReadSession, work: string) {
  const workBasis = await readWorkBasis(session, work);
  const { limit, binding, after } = pageBasis(session, 'native-credits', [work, session.principal]);
  const rows = await session.query(`SELECT ?id ?agent ?role WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?id a rv:NativeAgentCredit ; rv:work ${iri(work)} ;
      rv:agent ?agent ; schema:roleName ?role ; rv:creditRevision ?revision . }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision ; rv:component ?id ;
      rv:work ${iri(work)} ; rv:agent ?agent ; schema:roleName ?role .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?id rv:retiredBy ?retirement } }
    FILTER(STR(?id) > ${lit(after)})
  } ORDER BY STR(?id) LIMIT ${limit + 1}`, limit + 1);
  const items = [];
  for (const row of rows.slice(0, limit)) {
    const role = field(row, 'role');
    if (!isNativeCreditRole(role)) throw new WorkReadUnavailable('Invalid credit role');
    try {
      const agent = field(row, 'agent');
      const attribution = await readCreditAttribution(session, agent);
      items.push({ id: field(row, 'id'), role: role as NativeCreditInput['role'],
        agent, ...attribution });
    } catch (error) { if (!(error instanceof WorkReadMissing)) throw error; }
  }
  await fenceWorkBasis(session, workBasis);
  for (const item of items) {
    const current = await readCreditAttribution(session, item.agent);
    const { id: _id, role: _role, agent: _agent, ...before } = item;
    if (JSON.stringify(current) !== JSON.stringify(before)) throw new WorkReadMoved('Agent attribution changed');
  }
  return pageResult(session, items, nextPage(session, binding, rows.map(row => field(row, 'id')), limit));
}
