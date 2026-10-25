import type { Pool } from 'pg';
import { Type } from 'typebox';
export declare const BATCH_ENVELOPES = 64;
export declare const EVENT_TYPES: {
    readonly "com.rezics.subject.merged.v1": Type.TObject<{
        id: Type.TString;
        survivor: Type.TString;
    }>;
    readonly "com.rezics.semantic.links.moving.v1": Type.TObject<{
        id: Type.TString;
        survivor: Type.TString;
        cursor: Type.TArray<Type.TUnion<[Type.TString, Type.TInteger]>>;
    }>;
    readonly 'com.rezics.statement.proposed.v1': Type.TObject<{
        candidate: Type.TString;
        revision: Type.TInteger;
    }>;
    readonly 'com.rezics.statement.accepted.v1': Type.TObject<{
        candidate: Type.TString;
        context: Type.TString;
        revision: Type.TInteger;
        head: Type.TInteger;
    }>;
    readonly 'com.rezics.statement.rejected.v1': Type.TObject<{
        candidate: Type.TString;
        context: Type.TString;
        revision: Type.TInteger;
        head: Type.TInteger;
    }>;
    readonly 'com.rezics.subject.adopted.v1': Type.TObject<{
        context: Type.TString;
        property: Type.TString;
        mode: Type.TUnion<[Type.TLiteral<"inherit">, Type.TLiteral<"replace">, Type.TLiteral<"suppress">]>;
        revision: Type.TInteger;
        head: Type.TInteger;
    }>;
    readonly 'com.rezics.semantic.links.changed.v1': Type.TObject<{
        subject: Type.TString;
        revision: Type.TInteger;
        changes: Type.TArray<Type.TObject<{
            property: Type.TString;
            statement: Type.TString;
            target: Type.TString;
            present: Type.TBoolean;
        }>>;
    }>;
    readonly 'com.rezics.semantic.links.projected.v1': Type.TObject<{
        subjects: Type.TArray<Type.TString>;
    }>;
    readonly 'com.rezics.access.account.suspended.v1': Type.TObject<{
        accountId: Type.TString;
        state: Type.TLiteral<"suspended">;
        minimumAuthnEpoch: Type.TString;
        receiptId: Type.TString;
    }>;
    readonly 'com.rezics.access.grant.create.v1': Type.TUnion<[Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        actions: Type.TArray<Type.TString>;
        valid: Type.TString;
        subject: Type.TUnion<[Type.TObject<{
            kind: Type.TLiteral<"active_accounts">;
        }>, Type.TObject<{
            kind: Type.TLiteral<"account">;
            id: Type.TString;
        }>, Type.TObject<{
            kind: Type.TLiteral<"organization">;
            id: Type.TString;
            role: Type.TUnion<[Type.TLiteral<"owner">, Type.TLiteral<"member">]>;
        }>]>;
    }>, Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        actions: Type.TArray<Type.TString>;
        valid: Type.TString;
        subjectId: Type.TString;
        subjectRole: Type.TUnion<[Type.TLiteral<"">, Type.TLiteral<"owner">, Type.TLiteral<"member">]>;
    }>]>;
    readonly 'com.rezics.access.grant.change.v1': Type.TUnion<[Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        actions: Type.TArray<Type.TString>;
        valid: Type.TString;
        subject: Type.TUnion<[Type.TObject<{
            kind: Type.TLiteral<"active_accounts">;
        }>, Type.TObject<{
            kind: Type.TLiteral<"account">;
            id: Type.TString;
        }>, Type.TObject<{
            kind: Type.TLiteral<"organization">;
            id: Type.TString;
            role: Type.TUnion<[Type.TLiteral<"owner">, Type.TLiteral<"member">]>;
        }>]>;
    }>, Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        actions: Type.TArray<Type.TString>;
        valid: Type.TString;
        subjectId: Type.TString;
        subjectRole: Type.TUnion<[Type.TLiteral<"">, Type.TLiteral<"owner">, Type.TLiteral<"member">]>;
    }>]>;
    readonly 'com.rezics.access.grant.revoke.v1': Type.TUnion<[Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        actions: Type.TArray<Type.TString>;
        valid: Type.TString;
        subject: Type.TUnion<[Type.TObject<{
            kind: Type.TLiteral<"active_accounts">;
        }>, Type.TObject<{
            kind: Type.TLiteral<"account">;
            id: Type.TString;
        }>, Type.TObject<{
            kind: Type.TLiteral<"organization">;
            id: Type.TString;
            role: Type.TUnion<[Type.TLiteral<"owner">, Type.TLiteral<"member">]>;
        }>]>;
    }>, Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        actions: Type.TArray<Type.TString>;
        valid: Type.TString;
        subjectId: Type.TString;
        subjectRole: Type.TUnion<[Type.TLiteral<"">, Type.TLiteral<"owner">, Type.TLiteral<"member">]>;
    }>]>;
    readonly 'com.rezics.access.role-grant.create.v1': Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        subject: Type.TUnion<[Type.TObject<{
            kind: Type.TLiteral<"active_accounts">;
        }>, Type.TObject<{
            kind: Type.TLiteral<"account">;
            id: Type.TString;
        }>, Type.TObject<{
            kind: Type.TLiteral<"organization">;
            id: Type.TString;
            role: Type.TUnion<[Type.TLiteral<"owner">, Type.TLiteral<"member">]>;
        }>]>;
        role: Type.TString;
        valid: Type.TString;
    }>;
    readonly 'com.rezics.access.role-grant.change.v1': Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        subject: Type.TUnion<[Type.TObject<{
            kind: Type.TLiteral<"active_accounts">;
        }>, Type.TObject<{
            kind: Type.TLiteral<"account">;
            id: Type.TString;
        }>, Type.TObject<{
            kind: Type.TLiteral<"organization">;
            id: Type.TString;
            role: Type.TUnion<[Type.TLiteral<"owner">, Type.TLiteral<"member">]>;
        }>]>;
        role: Type.TString;
        valid: Type.TString;
    }>;
    readonly 'com.rezics.access.role-grant.revoke.v1': Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        subject: Type.TUnion<[Type.TObject<{
            kind: Type.TLiteral<"active_accounts">;
        }>, Type.TObject<{
            kind: Type.TLiteral<"account">;
            id: Type.TString;
        }>, Type.TObject<{
            kind: Type.TLiteral<"organization">;
            id: Type.TString;
            role: Type.TUnion<[Type.TLiteral<"owner">, Type.TLiteral<"member">]>;
        }>]>;
        role: Type.TString;
        valid: Type.TString;
    }>;
    readonly 'com.rezics.access.assignment.create.v1': Type.TObject<{
        requestedBy: Type.TString;
    }>;
    readonly 'com.rezics.access.assignment.revoke.v1': Type.TObject<{
        requestedBy: Type.TString;
    }>;
    readonly 'com.rezics.access.governance.bootstrapped.v1': Type.TObject<{
        accountId: Type.TString;
        resource: Type.TObject<{
            route: Type.TLiteral<0>;
            id: Type.TLiteral<"00000000-0000-8000-8000-000000000000">;
        }>;
        role: Type.TLiteral<string>;
    }>;
    readonly 'com.rezics.commerce.payout_statement.updated.v1': Type.TObject<{
        statementId: Type.TString;
    }>;
    readonly 'com.rezics.commerce.payout_statement.paid.v1': Type.TObject<{
        statementId: Type.TString;
    }>;
    readonly 'com.rezics.commerce.offer.created.v1': Type.TObject<{
        offerId: Type.TString;
    }>;
    readonly 'com.rezics.commerce.offer.revised.v1': Type.TObject<{
        offerId: Type.TString;
    }>;
    readonly 'com.rezics.commerce.offer.delisted.v1': Type.TObject<{
        offerId: Type.TString;
    }>;
    readonly 'com.rezics.commerce.order.created.v1': Type.TObject<{
        orderId: Type.TString;
    }>;
    readonly 'com.rezics.commerce.order.updated.v1': Type.TObject<{
        orderId: Type.TString;
        revision: Type.TInteger;
    }>;
    readonly 'com.rezics.commerce.transactions.recorded.v1': Type.TObject<{
        orderId: Type.TString;
        creatorAccountId: Type.TString;
        transactionIds: Type.TArray<Type.TString>;
    }>;
    readonly 'com.rezics.commerce.entitlement.granted.v1': Type.TObject<{
        entitlementId: Type.TString;
        orderId: Type.TString;
    }>;
    readonly 'com.rezics.commerce.entitlement.revoked.v1': Type.TObject<{
        entitlementId: Type.TString;
        orderId: Type.TString;
        reason: Type.TUnion<[Type.TLiteral<"refund">, Type.TLiteral<"dispute">]>;
    }>;
    readonly 'com.rezics.commerce.entitlement.restored.v1': Type.TObject<{
        entitlementId: Type.TString;
        orderId: Type.TString;
    }>;
    readonly 'com.rezics.content.board-thread.projected.v1': Type.TObject<{
        boardId: Type.TString;
        threadId: Type.TString;
        sourceEpoch: Type.TInteger;
        sourcePosition: Type.TString;
    }>;
    readonly 'com.rezics.content.media.reserved.v1': Type.TObject<{
        mediaId: Type.TString;
        containerId: Type.TString;
        actorId: Type.TString;
    }>;
    readonly 'com.rezics.content.media.uploaded.v1': Type.TObject<{
        mediaId: Type.TString;
        containerId: Type.TString;
        actorId: Type.TString;
    }>;
    readonly 'com.rezics.content.media.available.v1': Type.TObject<{
        mediaId: Type.TString;
        containerId: Type.TString;
    }>;
    readonly 'com.rezics.content.media.rejected.v1': Type.TObject<{
        mediaId: Type.TString;
        containerId: Type.TString;
        decisionId: Type.TString;
    }>;
    readonly 'com.rezics.content.media.erased.v1': Type.TObject<{
        mediaId: Type.TString;
        containerId: Type.TString;
    }>;
    readonly 'com.rezics.content.media.collection-pending.v1': Type.TObject<{
        mediaId: Type.TString;
        containerId: Type.TString;
    }>;
    readonly 'com.rezics.content.media.collected.v1': Type.TObject<{
        mediaId: Type.TString;
        containerId: Type.TString;
    }>;
    readonly 'com.rezics.content.media.import-requested.v1': Type.TObject<{
        mediaId: Type.TString;
    }>;
    readonly 'com.rezics.content.media.taken-down.v1': Type.TObject<{
        mediaId: Type.TString;
        securityRevision: Type.TString;
    }>;
    readonly 'com.rezics.content.moderation.takedown.v1': Type.TObject<{
        targetKind: Type.TUnion<[Type.TLiteral<"board">, Type.TLiteral<"thread">, Type.TLiteral<"post">]>;
        targetId: Type.TString;
        securityRevision: Type.TString;
    }>;
    readonly 'com.rezics.content.post.erased.v1': Type.TObject<{
        postId: Type.TString;
        securityRevision: Type.TString;
    }>;
    readonly 'com.rezics.content.moderation.erasure.v1': Type.TObject<{
        threadId: Type.TString;
        postIds: Type.TArray<Type.TString>;
        mediaIds: Type.TArray<Type.TString>;
    }>;
    readonly 'com.rezics.content.author-erasure.requested.v1': Type.TObject<{
        operationId: Type.TString;
        threadId: Type.TString;
        authorId: Type.TString;
    }>;
    readonly 'com.rezics.content.report.created.v1': Type.TObject<{
        reportId: Type.TString;
        targetKind: Type.TUnion<[Type.TLiteral<"board">, Type.TLiteral<"thread">, Type.TLiteral<"post">]>;
        targetId: Type.TString;
        revisionId: Type.TOptional<Type.TString>;
    }>;
    readonly 'com.rezics.content.source_fence.taken_down.v1': Type.TObject<{
        route: Type.TInteger;
        source: Type.TString;
        external_id: Type.TString;
        field_group: Type.TUnion<[Type.TLiteral<"facts">, Type.TLiteral<"summary">, Type.TLiteral<"cover">]>;
        securityRevision: Type.TString;
    }>;
    readonly 'com.rezics.content.thread.created.v1': Type.TObject<{
        threadId: Type.TString;
        itemId: Type.TString;
        revisionId: Type.TString;
        actorId: Type.TString;
    }>;
    readonly 'com.rezics.content.post.created.v1': Type.TObject<{
        threadId: Type.TString;
        itemId: Type.TString;
        revisionId: Type.TString;
        actorId: Type.TString;
    }>;
    readonly 'com.rezics.content.revision.created.v1': Type.TObject<{
        threadId: Type.TString;
        itemId: Type.TString;
        revisionId: Type.TString;
        actorId: Type.TString;
    }>;
    readonly 'com.rezics.content.reaction.changed.v1': Type.TObject<{
        actorId: Type.TString;
        targetKind: Type.TUnion<[Type.TLiteral<"thread">, Type.TLiteral<"post">]>;
        targetId: Type.TString;
        previousKind: Type.TUnion<[Type.TUnion<Type.TLiteral<"downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote">[]>, Type.TNull]>;
        kind: Type.TUnion<[Type.TUnion<Type.TLiteral<"downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote">[]>, Type.TNull]>;
    }>;
    readonly 'com.rezics.library.subject.listed.v1': Type.TObject<{
        subjectId: Type.TString;
    }>;
    readonly 'com.rezics.library.follow.updated.v1': Type.TObject<{
        targetId: Type.TString;
    }>;
    readonly 'com.rezics.library.progress_session.updated.v1': Type.TObject<{
        sessionId: Type.TString;
    }>;
    readonly 'com.rezics.library.copy.updated.v1': Type.TObject<{
        copyId: Type.TString;
    }>;
    readonly 'com.rezics.library.copy.deleted.v1': Type.TObject<{
        copyId: Type.TString;
    }>;
    readonly 'com.rezics.definitions.published.v1': Type.TObject<{
        digest: Type.TString;
    }>;
    readonly 'com.rezics.definitions.activated.v1': Type.TObject<{
        digest: Type.TString;
        head: Type.TInteger;
    }>;
    readonly 'com.rezics.presentation.profile.published.v1': Type.TObject<{
        digest: Type.TString;
    }>;
    readonly 'com.rezics.presentation.profile.activated.v1': Type.TObject<{
        digest: Type.TString;
        head: Type.TInteger;
    }>;
    readonly 'com.rezics.subject.created.v1': Type.TObject<{
        id: Type.TString;
    }>;
    readonly 'com.rezics.subject.visibility_changed.v1': Type.TObject<{
        id: Type.TString;
        visibility: Type.TUnion<[Type.TLiteral<"visible">, Type.TLiteral<"hidden">, Type.TLiteral<"taken_down">]>;
        security_revision: Type.TInteger;
    }>;
    readonly 'com.rezics.semantic.context.created.v1': Type.TObject<{
        id: Type.TString;
    }>;
};
export type CloudEvent = {
    specversion: '1.0';
    id: string;
    source: string;
    type: keyof typeof EVENT_TYPES;
    subject?: string;
    time: string;
    datacontenttype: 'application/json';
    sequence: string;
    data: unknown;
};
export type Envelope = {
    partition: number;
    epoch: number;
    position: bigint;
    events: CloudEvent[];
};
export type StopReason = 'gap' | 'epoch' | 'unknown_type' | 'invalid_data';
export type BatchResult = {
    status: 'busy';
} | {
    status: 'read';
    envelopes: number;
    position: bigint;
} | {
    status: 'stopped';
    reason: StopReason;
    envelopes: number;
    position: bigint;
};
/**
 * Reads and applies one short transactional batch. `apply` runs inside the open transaction, whose
 * session becomes idle in a transaction after five seconds, so effects should only record or enqueue work.
 */
export declare function readBatch(pool: Pool, options: {
    consumer: string;
    partition: number;
    apply: (envelopes: readonly Envelope[]) => Promise<void>;
    envelopes?: number;
}): Promise<BatchResult>;
/** Reads a batch, releases the connection before applying it, then compare-and-sets its checkpoint. */
export declare function projectBatch(pool: Pool, options: {
    consumer: string;
    partition: number;
    apply: (envelopes: readonly Envelope[]) => Promise<void>;
    envelopes?: number;
}): Promise<BatchResult>;
