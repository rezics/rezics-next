import { routeOf } from '../../route/contract.ts';
import { ACCOUNT_ROLE_BITS } from './contracts.ts';
import type { AccountReference, HistoryScope } from './locator.ts';
import { validateScope } from './locator.ts';

/** Permanent numeric namespace. Append explicit IDs; never assign IDs by registration order. */
export const COMMAND_HISTORY_KINDS = Object.freeze({
  'access.account.preferences': 1,
  'library.entry.retention.purge': 2,
  'access.agent-verification.pending': 3,
  'access.agent-verification.released': 4,
  'access.agent-verification.revoked': 5,
  'access.agent-verification.deleted': 6,
  'access.agent-identity.recover': 7,
  'content.board.watch': 8,
  'content.watch.remove': 9,
  'commerce.offer.create': 1000,
  'commerce.offer.delist': 1001,
  'commerce.offer.revise': 1002,
  'commerce.order.create': 1003,
  'content.authored_field.erase': 2000,
  'context.create': 3000,
  'context:delete': 3001,
  'context:restore': 3002,
  'definitions.extension.publish': 3003,
  'definitions.extension.activate': 3004,
  'zone.create': 3010,
  'zone.configure': 3011,
  'zone.publish': 3012,
  'zone.delete': 3013,
  'zone.restore': 3014,
  'subject.create': 3020,
  'subject.batch_create': 3021,
  'subject.propose': 3022,
  'subject.decide': 3023,
  'subject.adopt': 3024,
  'subject.batch_propose': 3025,
  'subject.batch_retract': 3026,
  'subject.terms': 3027,
});
export type CommandHistoryKind = string;
export type CommandHistoryScopes = Readonly<{ response: HistoryScope; events: readonly HistoryScope[] }>;

export const preferenceSubjectScope = (accountRoute: number, accountId: string): CommandHistoryScopes => ({
  response: {
    artifactType: 'command-receipt/v1',
    accounts: [{ accountRoute, accountId, roles: ACCOUNT_ROLE_BITS.subject }],
  },
  events: [
    { artifactType: 'outbox-event/v1', accounts: [{ accountRoute, accountId, roles: ACCOUNT_ROLE_BITS.subject }] },
  ],
});

export function unionHistoryScope(
  type: HistoryScope['artifactType'],
  ...groups: readonly (readonly AccountReference[])[]
): HistoryScope {
  const accounts = new Map<string, AccountReference>();
  for (const group of groups)
    for (const ref of group) {
      const previous = accounts.get(ref.accountId);
      if (previous && previous.accountRoute !== ref.accountRoute) throw new TypeError('History account route mismatch');
      accounts.set(ref.accountId, { ...ref, roles: ref.roles | (previous?.roles ?? 0) });
      if (accounts.size > 64) throw new TypeError('Too many distinct history account references');
    }
  return validateScope(type, { artifactType: type, accounts: [...accounts.values()] });
}

/** The owner's exact reference to one original record source resource. */
export type RecordHistorySourceReference =
  | Readonly<{
      kind: 'contribution';
      subjectId: string;
      candidateId: string;
      revision: number;
      documentId: string | null;
    }>
  | Readonly<{ kind: 'context'; contextId: string }>
  | Readonly<{ kind: 'zone'; zoneId: string }>;

export function recordHistorySourceKey(input: RecordHistorySourceReference): string {
  const uuid = (id: string) => routeOf(id) !== null;
  if (input.kind === 'contribution') {
    if (
      Object.keys(input).length !== 5 ||
      !uuid(input.subjectId) ||
      !uuid(input.candidateId) ||
      routeOf(input.subjectId) !== routeOf(input.candidateId) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      (input.documentId !== null && (!uuid(input.documentId) || routeOf(input.documentId) !== routeOf(input.subjectId)))
    )
      throw new TypeError('Invalid original record source');
    return JSON.stringify(['contribution', input.subjectId, input.candidateId, input.revision, input.documentId]);
  }
  if (input.kind === 'context' && Object.keys(input).length === 2 && uuid(input.contextId))
    return JSON.stringify(['context', input.contextId]);
  if (input.kind === 'zone' && Object.keys(input).length === 2 && uuid(input.zoneId))
    return JSON.stringify(['zone', input.zoneId]);
  throw new TypeError('Invalid original record source');
}
