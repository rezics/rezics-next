import {
  FollowCountReadRefusedError,
  FollowCountTargetAbsentError,
  FollowCountUnavailableError,
  type FollowCountDeliveryPorts,
  type FollowCountPartitionPorts,
  type FollowCountReadPorts,
  type FollowCountReads,
  type FollowCountTarget,
  type CountDestination,
  type LibraryAccountActor,
  type LibraryActor,
  type CountKey,
} from '../contract/index.ts';
import { followCountScalar } from '../core/index.ts';

/** Provisional scalars stay private until health and target authority are current,
 * then the caller is re-admitted against the home captured before selection. */
export function createFollowCountReadApplication<Time, Admission>(
  ports: FollowCountReadPorts<Time, Admission>,
): FollowCountReads {
  async function read<T>(
    actor: LibraryActor,
    deadline: number,
    body: (
      owner: LibraryAccountActor,
      time: Time,
    ) => Promise<Readonly<{ value: T; current?: (time: Time) => Promise<void> }>>,
  ) {
    if (actor.kind !== 'account') throw new FollowCountReadRefusedError('authentication_required');
    if (!actor.scopes.includes('follow:list')) throw new FollowCountReadRefusedError('forbidden');
    return ports.within(deadline, async () => {
      const selectedAt = await ports.admit(actor, deadline);
      const time = await ports.time(deadline);
      await ports.health();
      const result = await body(actor, time);
      await ports.health();
      let absent: FollowCountTargetAbsentError | undefined;
      try {
        if (result.current) await result.current(await ports.time(deadline));
      } catch (error) {
        // A revoked caller may also lose target management. Preserve the caller
        // refusal before concealing a target whose final authority was denied.
        if (!(error instanceof FollowCountTargetAbsentError)) throw error;
        absent = error;
      }
      await ports.admit(actor, deadline, selectedAt);
      if (absent) throw absent;
      return result.value;
    });
  }
  async function management(owner: LibraryAccountActor, action: string, id: string, time: Time, deadline: number) {
    if (!(await ports.management(owner, action, id, time, deadline))) throw new FollowCountTargetAbsentError();
  }
  async function collectionAuthority(
    owner: LibraryAccountActor,
    requested: FollowCountTarget,
    destination: CountDestination,
    time: Time,
    deadline: number,
  ) {
    const collection = await ports.collection(destination, deadline);
    if (collection?.state !== 'active') throw new FollowCountTargetAbsentError();
    if (collection.visibility !== 'public') {
      if (!collection.curatorAccountId || ports.route(collection.curatorAccountId) === null)
        throw new FollowCountTargetAbsentError();
      const curator = await ports.accountState(collection.curatorAccountId, deadline);
      if (curator === null || curator === 'deleted') throw new FollowCountTargetAbsentError();
    }
    await management(owner, 'collection:update', requested.targetId, time, deadline);
  }
  async function spaceAuthority(owner: LibraryAccountActor, id: string, time: Time, deadline: number) {
    if (!(await ports.spaceExists(id, time, deadline))) throw new FollowCountTargetAbsentError();
    await management(owner, 'space:manage', id, time, deadline);
  }
  return {
    target(actor, requested, deadline) {
      return read(actor, deadline, async (owner, time) => {
        if (ports.route(requested.targetId) === null) throw new FollowCountTargetAbsentError();
        const destination = await ports.destination(requested);
        let accountId: string | null = null;
        if (requested.targetType === 'subject') {
          if (!(await ports.subjectReadable(owner, requested.targetId, time))) throw new FollowCountTargetAbsentError();
          accountId = await ports.accountForAgent(destination.targetId);
          if (!accountId) throw new FollowCountTargetAbsentError();
          if (accountId !== owner.accountId) await management(owner, 'account:manage', accountId, time, deadline);
        } else if (requested.targetType === 'collection') {
          await collectionAuthority(owner, requested, destination, time, deadline);
        } else {
          await spaceAuthority(owner, requested.targetId, time, deadline);
        }
        const followerCount = followCountScalar(await ports.total(destination, requested.targetType, deadline));
        return {
          value: { ...requested, followerCount },
          async current(at: Time) {
            if (requested.targetType === 'subject') {
              if (!(await ports.subjectReadable(owner, requested.targetId, at)))
                throw new FollowCountTargetAbsentError();
              if (accountId !== owner.accountId) await management(owner, 'account:manage', accountId!, at, deadline);
              const current = await ports.destination(requested);
              const binding = await ports.accountForAgent(current.targetId);
              if (
                current.targetId !== destination.targetId ||
                current.epoch !== destination.epoch ||
                binding !== accountId
              )
                throw new FollowCountUnavailableError('Count identity changed during read');
            } else if (requested.targetType === 'collection') {
              await collectionAuthority(owner, requested, destination, at, deadline);
            } else {
              await spaceAuthority(owner, requested.targetId, at, deadline);
            }
          },
        };
      });
    },
    outgoing(actor, deadline) {
      return read(actor, deadline, async (owner) => ({
        value: { followingCount: followCountScalar(await ports.outgoing(owner, deadline)) },
      }));
    },
  };
}

/** A saved packet is a locator only: refresh source after resolving identity,
 * retain its receiving locator before target checkout, ACK only after commit. */
export async function deliverFollowCountApplication(ports: FollowCountDeliveryPorts, key: CountKey): Promise<void> {
  const destination = await ports.destination(key);
  const replacement = await ports.reconcile(key);
  if (!replacement || !(await ports.stage(key, replacement, destination))) return;
  await ports.apply(replacement, destination);
  await ports.acknowledge(replacement);
}

/** One scheduler segment has at most 93 persisted steps. Native pages stay at
 * 100 keys and the caller persists only a continuation locator. */
export async function runFollowCountPartition(ports: FollowCountPartitionPorts, partition: number): Promise<boolean> {
  let more = false;
  try {
    const targets = await ports.targets(partition),
      discovery = await ports.discover(partition);
    const owner = await ports.owner(partition);
    more = !targets.complete || !discovery.complete || owner.examined > 0;
    const account = await ports.accountKey(partition);
    if (account)
      for (let page = 0; page < 16; page++) {
        const result = await ports.accountPage(account);
        if (result.complete || result.examined === 0) break;
        if (page === 15 && result.examined === 100) more = true;
      }
    const keys = await ports.pending(partition);
    for (const key of keys.slice(0, 70)) await ports.deliver(key);
    more ||= keys.length > 70;
  } finally {
    await ports.sample(partition);
  }
  return more;
}
