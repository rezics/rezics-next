import type { Actor } from '../request/access.ts';
import { type RevisionDisclosureCommandContext, type RevisionDisclosureDependencies, type RevisionDisclosureIssueInput, type RevisionDisclosureRevokeInput, type RevisionDisclosureRow } from './revision-disclosure-model.ts';
/** Issue or reuse exact Book-scoped consent for one private opening revision. */
export declare function issueRevisionDisclosure(deps: RevisionDisclosureDependencies, actor: Actor, input: RevisionDisclosureIssueInput, context: RevisionDisclosureCommandContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    disclosureId: string;
    state: import("./revision-disclosure-model.ts").RevisionDisclosureState;
    catalogueId: string;
    reused: boolean;
    durableInitiator?: string;
}>>>;
/** Explicit revoke. Current source `post:revise` and container admission still apply. */
export declare function revokeRevisionDisclosure(deps: RevisionDisclosureDependencies, actor: Actor, input: RevisionDisclosureRevokeInput, context: RevisionDisclosureCommandContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    disclosureId: string;
    state: import("./revision-disclosure-model.ts").RevisionDisclosureState;
    catalogueId: string;
    reused: boolean;
    durableInitiator?: string;
}>>>;
export declare function revisionDisclosureObservationFromRow(row: RevisionDisclosureRow): Readonly<{
    disclosureId: string;
    state: import("./revision-disclosure-model.ts").RevisionDisclosureState;
    catalogue: import("./revision-disclosure-model.ts").RevisionDisclosureCatalogue;
    target: import("./revision-disclosure-model.ts").RevisionDisclosureTarget;
    licence: string;
    incarnation: import("./revision-disclosure-model.ts").RevisionDisclosureIncarnation;
    issuerAccountId: string;
    issuedAt: string;
    audienceKind: import("./revision-disclosure-model.ts").RevisionDisclosureAudience;
    policyVersion: import("./revision-disclosure-model.ts").RevisionDisclosurePolicyVersion;
    revokedAt: string | null;
}>;
