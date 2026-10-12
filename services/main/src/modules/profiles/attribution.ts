import type { CanonicalAddress } from '@rezics/model/address';
import type { DisplayName } from '../display-language/select.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type ReadPosition, type WorkReadSession } from '../work/read-session.ts';
import { readAgent, readAgentCards } from './read.ts';

/** The erasure owner supplies only Person tombstones bound to the retained
 * Account closure journal. Missing/private Agents and provision compensation
 * tombstones are not deletion proofs. No profile data belongs in this proof. */
export interface DeletedPersonAttributionProof {
  accountErasureId: string;
  erasureId: string;
  erasureEpoch: string;
}
export interface PersonAttributionTombstones {
  /** Qualify the graph tombstone at this exact position against its immutable
   * retained journal proof, under the owner's recovery fence. */
  read(agents: readonly string[], position: ReadPosition): Promise<ReadonlyMap<string, DeletedPersonAttributionProof>>;
}
declare module '../../routes/dependencies.ts' {
  interface MainWorkDependencies {
    personAttributionTombstones?: PersonAttributionTombstones;
  }
}

export type CreditAttribution = {
  identityStatus: 'active';
  displayName: string;
  handle: string | null;
  address: CanonicalAddress;
  displayNameInfo?: DisplayName;
} | {
  identityStatus: 'deleted';
  displayName: 'Deleted author';
  handle: null;
  address?: never;
  displayNameInfo?: never;
};

/** Credit-only identity: it never makes a deleted Person a readable profile,
 * directory entry or feed actor. Until the erasure owner is wired, absence of
 * that owner leaves unavailable identities missing. */
export async function readDeletedPersonAttributions(session: WorkReadSession, agents: readonly string[]) {
  const result = new Map<string, CreditAttribution>();
  const ids = [...new Set(agents)];
  if (ids.length > 192) throw new WorkReadUnavailable('Deleted Person attribution batch is out of bounds');
  const owner = session.deps.personAttributionTombstones;
  if (!ids.length || !owner) return result;
  const before = await owner.read(ids, session.position);
  for (const [agent, proof] of before) {
    if (!ids.includes(agent) || !proof.accountErasureId || !proof.erasureId
      || !/^[1-9]\d*$/.test(proof.erasureEpoch)) {
      throw new WorkReadUnavailable('Deleted Person attribution proof is invalid');
    }
    result.set(agent, { identityStatus: 'deleted', displayName: 'Deleted author', handle: null });
  }
  const after = await owner.read(ids, session.position);
  if (after.size !== before.size || [...before].some(([agent, proof]) => {
    const current = after.get(agent);
    return !current || current.accountErasureId !== proof.accountErasureId
      || current.erasureId !== proof.erasureId || current.erasureEpoch !== proof.erasureEpoch;
  })) throw new WorkReadMoved('Deleted Person attribution changed');
  const signature = (proofs: ReadonlyMap<string, DeletedPersonAttributionProof>) =>
    [...proofs].sort(([a], [b]) => a.localeCompare(b));
  session.observeDependency(`deleted-person-attribution:${JSON.stringify(ids)}`, signature(before),
    async () => signature(await owner.read(ids, session.position)));
  return result;
}

export async function readCreditAttribution(session: WorkReadSession, agent: string): Promise<CreditAttribution> {
  try {
    const profile = await readAgent(session, agent);
    return { identityStatus: 'active', displayName: profile.displayName,
      handle: profile.handle, address: profile.address,
      ...(profile.displayNameInfo ? { displayNameInfo: profile.displayNameInfo } : {}) };
  } catch (error) {
    if (!(error instanceof WorkReadMissing)) throw error;
  }
  const deleted = (await readDeletedPersonAttributions(session, [agent])).get(agent);
  if (!deleted) throw new WorkReadMissing('Agent attribution unavailable');
  return deleted;
}

export async function readCreditAttributionCards(session: WorkReadSession, agents: readonly string[],
  mode: 'required' | 'preview' = 'required',
  frame?: Parameters<typeof readAgentCards>[3]) {
  const live = await readAgentCards(session, agents, mode, frame);
  const result = new Map<string, CreditAttribution>([...live].map(([agent, card]) => [agent,
    { identityStatus: 'active', displayName: card.displayName, handle: card.handle,
      address: card.address, ...(card.displayNameInfo ? { displayNameInfo: card.displayNameInfo } : {}) }]));
  const missing = [...new Set(agents)].filter(agent => !live.has(agent));
  for (const [agent, attribution] of await readDeletedPersonAttributions(session, missing)) result.set(agent, attribution);
  return result;
}
