import type { AccountReference, HistoryScope } from './locator.ts';
/** Permanent numeric namespace. Append explicit IDs; never assign IDs by registration order. */
export declare const COMMAND_HISTORY_KINDS: Readonly<{
    'access.account.preferences': 1;
    'library.entry.retention.purge': 2;
    'access.agent-verification.pending': 3;
    'access.agent-verification.released': 4;
    'access.agent-verification.revoked': 5;
    'access.agent-verification.deleted': 6;
    'access.agent-identity.recover': 7;
    'content.board.watch': 8;
    'content.watch.remove': 9;
    'commerce.offer.create': 1000;
    'commerce.offer.delist': 1001;
    'commerce.offer.revise': 1002;
    'commerce.order.create': 1003;
    'content.authored_field.erase': 2000;
    'context.create': 3000;
    'context:delete': 3001;
    'context:restore': 3002;
    'definitions.extension.publish': 3003;
    'definitions.extension.activate': 3004;
    'zone.create': 3010;
    'zone.configure': 3011;
    'zone.publish': 3012;
    'zone.delete': 3013;
    'zone.restore': 3014;
    'subject.create': 3020;
    'subject.batch_create': 3021;
    'subject.propose': 3022;
    'subject.decide': 3023;
    'subject.adopt': 3024;
    'subject.batch_propose': 3025;
    'subject.batch_retract': 3026;
}>;
export type CommandHistoryKind = string;
export type CommandHistoryScopes = Readonly<{
    response: HistoryScope;
    events: readonly HistoryScope[];
}>;
export declare const preferenceSubjectScope: (accountRoute: number, accountId: string) => CommandHistoryScopes;
export declare function unionHistoryScope(type: HistoryScope['artifactType'], ...groups: readonly (readonly AccountReference[])[]): HistoryScope;
/** The owner's exact reference to one original record source resource. */
export type RecordHistorySourceReference = Readonly<{
    kind: 'contribution';
    subjectId: string;
    candidateId: string;
    revision: number;
    documentId: string | null;
}> | Readonly<{
    kind: 'context';
    contextId: string;
}> | Readonly<{
    kind: 'zone';
    zoneId: string;
}>;
export declare function recordHistorySourceKey(input: RecordHistorySourceReference): string;
