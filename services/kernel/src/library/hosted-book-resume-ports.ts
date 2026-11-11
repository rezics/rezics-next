import type { AccountActor } from '../request/access.ts';
import type { ProgressSession } from './progress-model.ts';
import type { createSessionCommands } from './sessions.ts';
import type { HostedBookResumeAddress } from './hosted-book-resume-identity.ts';

/** Reuse native private owner, scope, account, partition and final session-currentness checks. */
export type HostedBookResumeSessions = Pick<ReturnType<typeof createSessionCommands>, 'readPresentedSession'>;

export type HostedBookResumeCurrentness = 'current' | 'unavailable' | 'changed' | 'retired';

/**
 * Native producers retain an admission incarnation, including equal-value replacement and A/B/A.
 * verify performs their final current admission checks; value equality alone is insufficient.
 * Ports own and charge their bounded IO and release connections before returning these handles.
 */
export type HostedBookResumeLease = Readonly<{
  verify(): Promise<HostedBookResumeCurrentness>;
}>;

export type HostedBookResumeOwner = Readonly<{
  actor: AccountActor;
  session: ProgressSession;
  catalogueId: string;
  deadline: number;
}>;

/**
 * Projection of an independently supported chapter checkpoint, not a new storage schema or writer.
 * Bind the exact private account/session/catalogue; do not read a user's other sessions or aliases.
 * Empty is authoritative absence. Missing binding and failed reads are never empty checkpoints.
 */
export type HostedBookResumeCheckpointPort = Readonly<{
  read(input: HostedBookResumeOwner): Promise<
    | Readonly<{
        state: 'selected';
        accountId: string;
        sessionId: string;
        address: unknown;
        lease: HostedBookResumeLease;
      }>
    | Readonly<{ state: 'empty'; lease: HostedBookResumeLease }>
    | Readonly<{ state: 'not-installed' | 'unavailable' | 'changed' | 'retired' }>
  >;
}>;

/** Metadata projection of Content's admitted native resolution. Document bytes stay with Content. */
export type HostedBookResumeNativeResolution = Readonly<{
  catalogueId: string;
  revisionId: string;
  kind: 'structure' | 'publication';
  sourceRevisionId: string | null;
  occurrence: Readonly<{ occurrenceId: string }> & (
    | Readonly<{ availability: 'unavailable'; kind: 'part' | 'chapter' }>
    | Readonly<{ availability: 'available'; kind: 'part'; target: null }>
    | Readonly<{
        availability: 'available';
        kind: 'chapter';
        target: Readonly<{ threadId: string; postId: string; revisionId: string; sha256: string }>;
      }>
  );
  document: Readonly<{ encoding: 'base64'; sha256: string }> | null;
}>;

/**
 * Pending Content composition. Resolve exactly one catalogue/publication/occurrence using the actor's current
 * catalogue AND target authority. Address.publication.releaseRevisionId is revisionId with kind=publication;
 * structureRevisionId must equal sourceRevisionId. No default-head, navigation, refill or draft fallback.
 * An old publication remains selectable while currently admitted, including after a later release/withdrawal.
 * A source incarnation retiring invalidates the read even when the immutable coordinates remain identical.
 */
export type HostedBookResumeContentPort = Readonly<{
  resolve(input: HostedBookResumeOwner & Readonly<{ address: HostedBookResumeAddress }>): Promise<
    | Readonly<{
        state: 'resolved';
        value: HostedBookResumeNativeResolution;
        lease: HostedBookResumeLease;
      }>
    | Readonly<{ state: 'not-installed' | 'unavailable' | 'changed' | 'retired' }>
  >;
}>;
