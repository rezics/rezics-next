/** Authorization adapter. The composition root supplies Access's native implementation. */

import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../../command/command.ts';
import type { Access, Actor } from '../../request/access.ts';
import type { AuthorizationCapability } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';
import type {
  CollectionAuthorizationPreparation,
  CollectionListFilter,
  SpecializeCollectionListInput,
} from '../contract/index.ts';
import { routeOf } from '../core/index.ts';

export type NativeCollectionReadAdmission = (input: {
  access: Access;
  pool: Pool;
  actor: Actor;
  deadline: number;
  route: number;
  collectionId: string;
  at: AuthoritativeTime;
}) => Promise<boolean>;

export type AuthorizationAdapterPorts = Readonly<{
  admitCollectionRead: NativeCollectionReadAdmission;
  fenceAccount(tx: unknown, accountId: string): Promise<void>;
  isLifecycleDenied(error: unknown): boolean;
  commandAuthorization(...args: readonly unknown[]): Promise<unknown>;
  deadlineClient<T extends object>(client: T, deadline: number): T;
  within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
  specializeCollectionList(input: SpecializeCollectionListInput): CollectionListFilter;
  collectionAuthorizationPreparation(): CollectionAuthorizationPreparation;
}>;

export function createAuthorizationAdapter(input: {
  access?: Access | undefined;
  pool?: Pool | undefined;
  ports: AuthorizationAdapterPorts;
}): AuthorizationCapability {
  const { access, pool, ports } = input;
  return {
    async admitCollectionRead(input) {
      if (!access || !pool) return { authorized: false, reason: 'unbound' };
      if (
        input.at === undefined ||
        !Number.isFinite(input.deadline) ||
        Date.now() >= input.deadline ||
        routeOf(input.collectionId) !== input.route
      )
        return { authorized: false, reason: 'denied' };
      if (input.visibility === 'private' || input.privateOwner) {
        if (
          input.actor.kind !== 'account' ||
          input.curatorAccountId !== input.actor.accountId ||
          routeOf(input.actor.accountId) !== input.route ||
          (input.membershipKind === 'dynamic' && input.actor.accountId !== input.curatorAccountId)
        )
          return { authorized: false, reason: 'denied' };
      }
      const authorized = await ports.admitCollectionRead({
        access,
        pool,
        actor: input.actor as Actor,
        deadline: input.deadline,
        route: input.route,
        collectionId: input.collectionId,
        at: input.at as AuthoritativeTime,
      });
      return authorized ? { authorized: true } : { authorized: false, reason: 'denied' };
    },
    fenceAccount(tx, accountId) {
      return ports.fenceAccount(tx, accountId);
    },
    isLifecycleDenied(error) {
      return ports.isLifecycleDenied(error);
    },
    commandAuthorization(...args) {
      return ports.commandAuthorization(...args);
    },
    deadlineClient(client, deadline) {
      return ports.deadlineClient(client, deadline);
    },
    within(deadline, work) {
      return ports.within(deadline, work);
    },
    specializeCollectionList(input) {
      return ports.specializeCollectionList(input);
    },
    collectionAuthorizationPreparation() {
      return ports.collectionAuthorizationPreparation();
    },
  };
}

export type { LibraryActor, Actor };
