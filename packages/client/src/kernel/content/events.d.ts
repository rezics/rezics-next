import { Type, type Static } from 'typebox';
export declare const REACTION_KINDS: readonly ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'];
/** Closed content event catalogue. Envelope identity and ordering belong to the kernel. */
export declare const CONTENT_EVENTS: {
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
    readonly 'com.rezics.content.moderation.appeal-created.v1': Type.TObject<{
        appealId: Type.TString;
    }>;
    readonly 'com.rezics.content.moderation.appeal-resolved.v1': Type.TObject<{
        appealId: Type.TString;
    }>;
    readonly 'com.rezics.content.moderation.takedown.v1': Type.TObject<{
        targetKind: Type.TUnion<[Type.TLiteral<"board">, Type.TLiteral<"thread">, Type.TLiteral<"post">]>;
        targetId: Type.TString;
        securityRevision: Type.TString;
    }>;
    readonly 'com.rezics.content.moderation.restored.v1': Type.TObject<{
        targetKind: Type.TUnion<[Type.TLiteral<"thread">, Type.TLiteral<"post">]>;
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
    readonly 'com.rezics.content.report.resolved.v1': Type.TObject<{
        reportId: Type.TString;
    }>;
    readonly 'com.rezics.content.report.created.v1': Type.TObject<{
        reportId: Type.TString;
        targetKind: Type.TUnion<[Type.TLiteral<"board">, Type.TLiteral<"thread">, Type.TLiteral<"post">]>;
        targetId: Type.TString;
        revisionId: Type.TOptional<Type.TString>;
    }>;
    readonly 'com.rezics.content.report-target.projected.v1': Type.TObject<{
        reportId: Type.TString;
        targetKind: Type.TUnion<[Type.TLiteral<"board">, Type.TLiteral<"thread">, Type.TLiteral<"post">]>;
        targetId: Type.TString;
    }>;
    readonly 'com.rezics.content.source_fence.taken_down.v1': Type.TObject<{
        route: Type.TInteger;
        source: Type.TString;
        external_id: Type.TString;
        field_group: Type.TUnion<[Type.TLiteral<"facts">, Type.TLiteral<"summary">, Type.TLiteral<"cover">]>;
        securityRevision: Type.TString;
        takenDownAt: Type.TOptional<Type.TString>;
        takedownId: Type.TOptional<Type.TString>;
    }>;
    readonly 'com.rezics.content.thread.created.v1': Type.TObject<{
        placeId: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"discussion">, Type.TLiteral<"review">]>;
        subjectIds: Type.TArray<Type.TString>;
        activityAt: Type.TString;
        threadId: Type.TString;
        itemId: Type.TString;
        revisionId: Type.TString;
        actorId: Type.TString;
    }>;
    readonly 'com.rezics.content.post.created.v1': Type.TObject<{
        placeId: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"discussion">, Type.TLiteral<"review">]>;
        subjectIds: Type.TArray<Type.TString>;
        activityAt: Type.TString;
        threadId: Type.TString;
        itemId: Type.TString;
        revisionId: Type.TString;
        actorId: Type.TString;
    }>;
    readonly 'com.rezics.content.revision.created.v1': Type.TObject<{
        placeId: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"discussion">, Type.TLiteral<"review">]>;
        subjectIds: Type.TArray<Type.TString>;
        activityAt: Type.TString;
        threadId: Type.TString;
        itemId: Type.TString;
        revisionId: Type.TString;
        actorId: Type.TString;
        previousSubjectIds: Type.TOptional<Type.TArray<Type.TString>>;
    }>;
    readonly 'com.rezics.content.board.created.v1': Type.TObject<{
        boardId: Type.TString;
        realmId: Type.TUnion<[Type.TString, Type.TNull]>;
        conceptId: Type.TString;
        actorId: Type.TString;
    }>;
    readonly 'com.rezics.content.authored-field.created.v1': Type.TObject<{
        id: Type.TString;
        subject: Type.TString;
        candidate: Type.TString;
        authorId: Type.TString;
    }>;
    readonly 'com.rezics.content.authored-field.erased.v1': Type.TObject<{
        id: Type.TString;
        subject: Type.TString;
        authorId: Type.TString;
    }>;
    readonly 'com.rezics.content.reaction.changed.v1': Type.TObject<{
        actorId: Type.TString;
        targetKind: Type.TUnion<[Type.TLiteral<"thread">, Type.TLiteral<"post">, Type.TLiteral<"subject">]>;
        targetId: Type.TString;
        previousKind: Type.TUnion<[Type.TEnum<["upvote", "downvote", "like", "love", "laugh", "insightful", "sad"]>, Type.TNull]>;
        kind: Type.TUnion<[Type.TEnum<["upvote", "downvote", "like", "love", "laugh", "insightful", "sad"]>, Type.TNull]>;
    }>;
    readonly 'com.rezics.content.author-item.projected.v1': Type.TObject<{
        authorAccountId: Type.TString;
        itemKind: Type.TUnion<[Type.TLiteral<"thread">, Type.TLiteral<"post">]>;
        itemId: Type.TString;
        sourceEpoch: Type.TInteger;
        sourcePosition: Type.TString;
    }>;
    readonly 'com.rezics.content.subject-thread.projected.v1': Type.TObject<{
        subjectId: Type.TString;
        threadId: Type.TString;
        sourceEpoch: Type.TInteger;
        sourcePosition: Type.TString;
    }>;
};
export type ContentEventType = keyof typeof CONTENT_EVENTS;
export type ContentEventData<T extends ContentEventType> = Static<(typeof CONTENT_EVENTS)[T]>;
