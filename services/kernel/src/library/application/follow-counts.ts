import {
  FollowCountReadRefusedError,
  FollowCountTargetAbsentError,
  FollowCountUnavailableError,
  type FollowCountDeliveryPorts,
  type FollowCountPartitionPorts,
  type FollowCountReadPorts,
  type FollowCountReads,
  type LibraryAccountActor,
  type LibraryActor,
  type CountKey,
} from '../contract/index.ts';
import { followCountScalar } from '../core/index.ts';

/** Read authority is established before health and data. Provisional results are
 * withheld until final health and (for Subjects) identity currentness are proven. */
export function createFollowCountReadApplication<Time>(ports: FollowCountReadPorts<Time>): FollowCountReads {
  async function read<T>(
    actor: LibraryActor,
    deadline: number,
    body: (owner: LibraryAccountActor, time: Time) => Promise<T>,
  ) {
    if (actor.kind !== 'account') throw new FollowCountReadRefusedError('authentication_required');
    if (!actor.scopes.includes('follow:list')) throw new FollowCountReadRefusedError('forbidden');
    const time = await ports.authenticate(actor, deadline);
    await ports.health();
    const result = await ports.within(deadline, () => body(actor, time));
    await ports.health();
    return result;
  }
  async function management(owner: LibraryAccountActor, action: string, id: string, time: Time, deadline: number) {
    if (!(await ports.management(owner, action, id, time, deadline))) throw new FollowCountTargetAbsentError();
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
          const collection = await ports.collection(destination, deadline);
          if (collection?.state !== 'active') throw new FollowCountTargetAbsentError();
          if (collection.visibility !== 'public') {
            if (!collection.curatorAccountId || ports.route(collection.curatorAccountId) === null)
              throw new FollowCountTargetAbsentError();
            const curator = await ports.accountState(collection.curatorAccountId, deadline);
            if (curator === null || curator === 'deleted') throw new FollowCountTargetAbsentError();
          }
          await management(owner, 'collection:update', requested.targetId, time, deadline);
        } else {
          if (!(await ports.spaceExists(requested.targetId, time, deadline))) throw new FollowCountTargetAbsentError();
          await management(owner, 'space:manage', requested.targetId, time, deadline);
        }
        const followerCount = followCountScalar(await ports.total(destination, requested.targetType, deadline));
        if (requested.targetType === 'subject') {
          const current = await ports.destination(requested);
          const binding = await ports.accountForAgent(current.targetId);
          if (current.targetId !== destination.targetId || current.epoch !== destination.epoch || binding !== accountId)
            throw new FollowCountUnavailableError('Count identity changed during read');
        }
        return { ...requested, followerCount };
      });
    },
    outgoing(actor, deadline) {
      return read(actor, deadline, async (owner) => ({
        followingCount: followCountScalar(await ports.outgoing(owner, deadline)),
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
