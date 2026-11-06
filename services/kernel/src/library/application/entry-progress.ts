/** Entry and progress caller admission. Authorization precedes identity disclosure. */

import type { AuthorizationCapability, IdentityDisclosureCapability } from '../contract/index.ts';
import type { EntryProgressAdmission } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';
import { admissionTerm, grantCapable, routeOf, sumAdmission } from '../core/index.ts';

export function createEntryProgressApplication(capabilities: {
  authorization: AuthorizationCapability;
  identityDisclosure: IdentityDisclosureCapability;
}) {
  return {
    async admit(input: {
      actor: LibraryActor;
      deadline: number;
      subjectId: string;
      at?: unknown;
      account?: Parameters<typeof grantCapable>[0];
    }): Promise<EntryProgressAdmission> {
      const refused = (name: string, work: Parameters<typeof admissionTerm>[1] = {}) => ({
        admitted: false,
        actor: input.actor,
        deadline: input.deadline,
        original: null,
        terminal: null,
        admission: sumAdmission([admissionTerm(name, work)]),
      });

      if (!Number.isFinite(input.deadline) || Date.now() >= input.deadline)
        return refused('deadline', { statements: 1 });
      if (input.actor.kind !== 'account' || routeOf(input.actor.accountId) === null)
        return refused('actor', { statements: 1 });
      if (input.account && !grantCapable(input.account, input.actor))
        return refused('grant', { statements: 1, nativeRows: 1 });

      const authorization = await capabilities.authorization.admitCollectionRead({
        actor: input.actor,
        at: input.at,
        deadline: input.deadline,
        route: routeOf(input.actor.accountId)!,
        collectionId: input.subjectId,
        curatorAccountId: input.actor.accountId,
        visibility: 'private',
        membershipKind: 'curated',
        privateOwner: true,
      });
      if (!authorization.authorized)
        return refused(authorization.reason === 'unbound' ? 'collection-read-unbound' : 'collection-read-denied', {
          nativeRows: 1,
          statements: 1,
        });

      const disclosure = await capabilities.identityDisclosure.readOriginalTerminal({
        actor: input.actor,
        subjectId: input.subjectId,
        deadline: input.deadline,
        at: input.at,
      });
      if (disclosure.original === null || disclosure.terminal === null)
        return refused('identity-disclosure-unavailable', { identityMetadataRows: 2, statements: 1 });

      return {
        admitted: true,
        actor: input.actor,
        deadline: input.deadline,
        original: disclosure.original,
        terminal: disclosure.terminal,
        admission: sumAdmission([
          admissionTerm('grant', { statements: 1, nativeRows: 1 }),
          admissionTerm('identity-disclosure', {
            identityMetadataRows: 2,
            nativePoints: 4,
            statements: 2,
            bytes: 8192,
          }),
          admissionTerm('entry-progress', { nativeRows: 2, statements: 2, nativePoints: 2 }),
        ]),
      };
    },
  };
}

export type EntryProgressApplication = ReturnType<typeof createEntryProgressApplication>;
