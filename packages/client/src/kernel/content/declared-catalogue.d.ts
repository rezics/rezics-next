/** Content's event catalogue as a declared value. Locator events belong on the same surface as
 * thread, media and moderation events; the composition root evaluates this once at start. */
export declare function contentDeclaredEvents(): Readonly<{
    "com.rezics.content.review-discovery.opened.v1": import("typebox").TObject<{
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
    "com.rezics.content.review-discovery.progress.v1": import("typebox").TObject<{
        route: import("typebox").TInteger;
        id: import("typebox").TString;
        version: import("typebox").TString;
        complete: import("typebox").TBoolean;
    }>;
    "com.rezics.content.review-discovery.changed.v1": import("typebox").TObject<{
        partition: import("typebox").TInteger;
        through: import("typebox").TString;
        ids: import("typebox").TArray<import("typebox").TString>;
        origin: import("typebox").TObject<{
            partition: import("typebox").TInteger;
            epoch: import("typebox").TInteger;
            position: import("typebox").TString;
            eventIndex: import("typebox").TInteger;
            id: import("typebox").TString;
            type: import("typebox").TString;
        }>;
    }>;
    "com.rezics.content.realm-discovery.changed.v1": import("typebox").TObject<{
        realmId: import("typebox").TString;
        realmEpoch: import("typebox").TString;
        spaceId: import("typebox").TString;
        boardId: import("typebox").TString;
        threadId: import("typebox").TString;
        sourceRoute: import("typebox").TInteger;
        creationDay: import("typebox").TString;
        sourceVersion: import("typebox").TString;
        contributing: import("typebox").TBoolean;
        change: import("typebox").TUnion<[import("typebox").TLiteral<1>, import("typebox").TLiteral<-1>]>;
    }>;
    "com.rezics.content.realm-discovery.prepared.v1": import("typebox").TObject<{
        route: import("typebox").TInteger;
        intent: import("typebox").TString;
        generation: import("typebox").TString;
    }>;
    "com.rezics.content.realm-discovery.outcome.v1": import("typebox").TObject<{
        route: import("typebox").TInteger;
        intent: import("typebox").TString;
        generation: import("typebox").TString;
    }>;
    'com.rezics.content.board-thread.projected.v1': import("typebox").TObject<{
        boardId: import("typebox").TString;
        threadId: import("typebox").TString;
        sourceEpoch: import("typebox").TInteger;
        sourcePosition: import("typebox").TString;
    }>;
    'com.rezics.content.board-thread.pin.changed.v1': import("typebox").TObject<{
        boardId: import("typebox").TString;
        threadId: import("typebox").TString;
        actorId: import("typebox").TString;
        pinned: import("typebox").TBoolean;
        pinPosition: import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>;
    }>;
    'com.rezics.content.media.reserved.v1': import("typebox").TObject<{
        mediaId: import("typebox").TString;
        containerId: import("typebox").TString;
        actorId: import("typebox").TString;
    }>;
    'com.rezics.content.media.uploaded.v1': import("typebox").TObject<{
        mediaId: import("typebox").TString;
        containerId: import("typebox").TString;
        actorId: import("typebox").TString;
    }>;
    'com.rezics.content.media.available.v1': import("typebox").TObject<{
        mediaId: import("typebox").TString;
        containerId: import("typebox").TString;
    }>;
    'com.rezics.content.media.rejected.v1': import("typebox").TObject<{
        mediaId: import("typebox").TString;
        containerId: import("typebox").TString;
        decisionId: import("typebox").TString;
    }>;
    'com.rezics.content.media.erased.v1': import("typebox").TObject<{
        mediaId: import("typebox").TString;
        containerId: import("typebox").TString;
    }>;
    'com.rezics.content.media.collection-pending.v1': import("typebox").TObject<{
        mediaId: import("typebox").TString;
        containerId: import("typebox").TString;
    }>;
    'com.rezics.content.media.collected.v1': import("typebox").TObject<{
        mediaId: import("typebox").TString;
        containerId: import("typebox").TString;
    }>;
    'com.rezics.content.media.import-requested.v1': import("typebox").TObject<{
        mediaId: import("typebox").TString;
    }>;
    'com.rezics.content.media.taken-down.v1': import("typebox").TObject<{
        mediaId: import("typebox").TString;
        securityRevision: import("typebox").TString;
    }>;
    'com.rezics.content.moderation.appeal-created.v1': import("typebox").TObject<{
        appealId: import("typebox").TString;
    }>;
    'com.rezics.content.moderation.appeal-resolved.v1': import("typebox").TObject<{
        appealId: import("typebox").TString;
    }>;
    'com.rezics.content.moderation.takedown.v1': import("typebox").TObject<{
        targetKind: import("typebox").TUnion<[import("typebox").TLiteral<"board">, import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">]>;
        targetId: import("typebox").TString;
        securityRevision: import("typebox").TString;
    }>;
    'com.rezics.content.moderation.restored.v1': import("typebox").TObject<{
        targetKind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">]>;
        targetId: import("typebox").TString;
        securityRevision: import("typebox").TString;
    }>;
    'com.rezics.content.post.erased.v1': import("typebox").TObject<{
        postId: import("typebox").TString;
        securityRevision: import("typebox").TString;
        accountErasure: import("typebox").TOptional<import("typebox").TLiteral<true>>;
    }>;
    'com.rezics.content.moderation.erasure.v1': import("typebox").TObject<{
        threadId: import("typebox").TString;
        postIds: import("typebox").TArray<import("typebox").TString>;
        mediaIds: import("typebox").TArray<import("typebox").TString>;
    }>;
    'com.rezics.content.author-erasure.requested.v1': import("typebox").TObject<{
        operationId: import("typebox").TString;
        threadId: import("typebox").TString;
        authorId: import("typebox").TString;
    }>;
    'com.rezics.content.report-locator.installed.v1': import("typebox").TObject<{
        partition: import("typebox").TInteger;
        epoch: import("typebox").TInteger;
        position: import("typebox").TString;
        expected: import("typebox").TString;
        applied: import("typebox").TString;
        complete: import("typebox").TBoolean;
    }>;
    'com.rezics.content.report-locator.coverage.v1': import("typebox").TObject<{
        partition: import("typebox").TInteger;
    }>;
    'com.rezics.content.catalogue-report.projected.v1': import("typebox").TObject<{
        reportId: import("typebox").TString;
    }>;
    'com.rezics.content.report.resolved.v1': import("typebox").TObject<{
        reportId: import("typebox").TString;
    }>;
    'com.rezics.content.report.created.v1': import("typebox").TObject<{
        reportId: import("typebox").TString;
        targetKind: import("typebox").TUnion<[import("typebox").TLiteral<"board">, import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">, import("typebox").TLiteral<"subject">, import("typebox").TLiteral<"space">, import("typebox").TLiteral<"realm">]>;
        targetId: import("typebox").TString;
        revisionId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    'com.rezics.content.report-target.projected.v1': import("typebox").TObject<{
        reportId: import("typebox").TString;
        targetKind: import("typebox").TUnion<[import("typebox").TLiteral<"board">, import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">, import("typebox").TLiteral<"subject">, import("typebox").TLiteral<"space">, import("typebox").TLiteral<"realm">]>;
        targetId: import("typebox").TString;
    }>;
    'com.rezics.content.source_fence.taken_down.v1': import("typebox").TObject<{
        route: import("typebox").TInteger;
        source: import("typebox").TString;
        external_id: import("typebox").TString;
        field_group: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
        securityRevision: import("typebox").TString;
        takenDownAt: import("typebox").TOptional<import("typebox").TString>;
        takedownId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    'com.rezics.content.conversation-activity.projected.v1': import("typebox").TObject<{
        postIds: import("typebox").TArray<import("typebox").TString>;
        sourceEpoch: import("typebox").TInteger;
        sourcePosition: import("typebox").TString;
    }>;
    'com.rezics.content.board.watch.changed.v1': import("typebox").TObject<{
        accountId: import("typebox").TString;
        boardId: import("typebox").TString;
        watching: import("typebox").TBoolean;
        revision: import("typebox").TInteger;
    }>;
    'com.rezics.content.watch.removed.v1': import("typebox").TObject<{
        accountId: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
        watchId: import("typebox").TString;
    }>;
    'com.rezics.content.own-drafts.repaired.v1': import("typebox").TObject<{}>;
    'com.rezics.content.board.slow-mode.changed.v1': import("typebox").TObject<{
        boardId: import("typebox").TString;
        intervalSeconds: import("typebox").TInteger;
    }>;
    'com.rezics.content.feed.indexed.v1': import("typebox").TObject<{}>;
    'com.rezics.content.feed.delivered.v1': import("typebox").TObject<{}>;
    'com.rezics.content.feed.erased.v1': import("typebox").TObject<{}>;
    'com.rezics.content.feed.expired.v1': import("typebox").TObject<{}>;
    'com.rezics.content.edition.creator-indexed.v1': import("typebox").TObject<{
        editionId: import("typebox").TString;
        creatorAccountId: import("typebox").TString;
    }>;
    'com.rezics.content.edition.created.v1': import("typebox").TObject<{
        editionId: import("typebox").TString;
        editionRevision: import("typebox").TString;
    }>;
    'com.rezics.content.edition.published.v1': import("typebox").TObject<{
        editionId: import("typebox").TString;
        editionRevision: import("typebox").TString;
    }>;
    'com.rezics.content.edition.unpublished.v1': import("typebox").TObject<{
        editionId: import("typebox").TString;
        editionRevision: import("typebox").TString;
    }>;
    'com.rezics.content.thread.created.v1': import("typebox").TObject<{
        placeId: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>;
        subjectIds: import("typebox").TArray<import("typebox").TString>;
        activityAt: import("typebox").TString;
        threadId: import("typebox").TString;
        itemId: import("typebox").TString;
        revisionId: import("typebox").TString;
        actorId: import("typebox").TString;
    }>;
    'com.rezics.content.post.created.v1': import("typebox").TObject<{
        placeId: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>;
        subjectIds: import("typebox").TArray<import("typebox").TString>;
        activityAt: import("typebox").TString;
        threadId: import("typebox").TString;
        itemId: import("typebox").TString;
        revisionId: import("typebox").TString;
        actorId: import("typebox").TString;
    }>;
    'com.rezics.content.post.published.v1': import("typebox").TObject<{
        placeId: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>;
        subjectIds: import("typebox").TArray<import("typebox").TString>;
        activityAt: import("typebox").TString;
        threadId: import("typebox").TString;
        itemId: import("typebox").TString;
        revisionId: import("typebox").TString;
        actorId: import("typebox").TString;
    }>;
    'com.rezics.content.revision.created.v1': import("typebox").TObject<{
        placeId: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>;
        subjectIds: import("typebox").TArray<import("typebox").TString>;
        activityAt: import("typebox").TString;
        threadId: import("typebox").TString;
        itemId: import("typebox").TString;
        revisionId: import("typebox").TString;
        actorId: import("typebox").TString;
        previousSubjectIds: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    }>;
    'com.rezics.content.board.created.v1': import("typebox").TObject<{
        boardId: import("typebox").TString;
        realmId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        conceptId: import("typebox").TString;
        actorId: import("typebox").TString;
    }>;
    'com.rezics.content.authored-field.created.v1': import("typebox").TObject<{
        id: import("typebox").TString;
        subject: import("typebox").TString;
        candidate: import("typebox").TString;
        authorId: import("typebox").TString;
    }>;
    'com.rezics.content.authored-field.erased.v1': import("typebox").TObject<{
        id: import("typebox").TString;
        subject: import("typebox").TString;
        authorId: import("typebox").TString;
    }>;
    'com.rezics.content.post.restored.v1': import("typebox").TObject<{
        postId: import("typebox").TString;
        securityRevision: import("typebox").TString;
    }>;
    'com.rezics.content.reaction.changed.v1': import("typebox").TObject<{
        actorId: import("typebox").TString;
        targetKind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">, import("typebox").TLiteral<"subject">]>;
        targetId: import("typebox").TString;
        previousKind: import("typebox").TUnion<[import("typebox").TEnum<["upvote", "downvote", "like", "love", "laugh", "insightful", "sad"]>, import("typebox").TNull]>;
        kind: import("typebox").TUnion<[import("typebox").TEnum<["upvote", "downvote", "like", "love", "laugh", "insightful", "sad"]>, import("typebox").TNull]>;
    }>;
    'com.rezics.content.author-item.projected.v1': import("typebox").TObject<{
        authorAccountId: import("typebox").TString;
        itemKind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">]>;
        itemId: import("typebox").TString;
        sourceEpoch: import("typebox").TInteger;
        sourcePosition: import("typebox").TString;
    }>;
    'com.rezics.content.subject-thread.projected.v1': import("typebox").TObject<{
        subjectId: import("typebox").TString;
        threadId: import("typebox").TString;
        sourceEpoch: import("typebox").TInteger;
        sourcePosition: import("typebox").TString;
    }>;
    'com.rezics.content.report-reporter.projected.v1': import("typebox").TObject<{
        reportId: import("typebox").TString;
    }>;
    'com.rezics.content.report-reporter.erased.v1': import("typebox").TObject<{
        reportId: import("typebox").TString;
    }>;
    'com.rezics.content.report.evidence-erased.v1': import("typebox").TObject<{
        reportId: import("typebox").TString;
    }>;
}>;
