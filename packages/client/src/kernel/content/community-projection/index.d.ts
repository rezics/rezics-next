/** Selected native facts only. The adapter supplies its partition anchor as a value. */
export type ConversationActivityReplyCount = Readonly<{
    kind: 'exact';
    value: number;
} | {
    kind: 'lower-bound';
    value: number;
}>;
export type ConversationActivityWitness<Anchor> = Readonly<{
    threadId: string;
    boardId: string;
    threadSecurityRevision: string;
    boardSecurityRevision: string;
    realmId: string | null;
    boardGeneration: string;
    generation: string;
    /** eventSeq 1000 marks a repair cut after every event at this partition position. */
    sourceHead: Readonly<{
        epoch: number;
        position: bigint;
        eventSeq: number;
    }>;
    source: Anchor;
}>;
export type ConversationActivityCurrent<Anchor> = Readonly<{
    threadId: string;
    status: 'current';
    cohort: 'public';
    replyCount: ConversationActivityReplyCount;
    lastContributionAt: string | null;
    witness: ConversationActivityWitness<Anchor>;
}>;
export type ConversationActivityWithheld = Readonly<{
    threadId: string;
    status: 'withheld';
    reason: 'missing' | 'coverage' | 'unsupported-cohort' | 'stale';
}>;
export type ConversationActivitySelection<Anchor> = ConversationActivityCurrent<Anchor> | ConversationActivityWithheld;
export type CommunityActivityWitness = Readonly<{
    state: 'current';
    threadId: string;
    cohort: Readonly<{
        kind: 'public';
    }> | Readonly<{
        kind: 'viewer';
        accountId: string;
    }>;
    count: ConversationActivityReplyCount;
    lastActivityAt: string | null;
    source: Readonly<{
        epoch: number;
        position: string;
    }>;
}> | Readonly<{
    state: 'unavailable';
    threadId: string;
}>;
export type CommunityActivityRead<Anchor> = Readonly<{
    items: readonly CommunityActivityWitness[];
    anchors: readonly Anchor[];
}>;
export type CommunityActivityActor = Readonly<{
    kind: 'anonymous';
}> | Readonly<{
    kind: 'account';
    accountId: string;
}>;
export type CommunityComments = Readonly<{
    state: 'current';
    cohort: 'public' | 'viewer';
    count: ConversationActivityReplyCount;
    lastActivityAt: string | null;
    source: Readonly<{
        epoch: number;
        position: string;
    }>;
}> | Readonly<{
    state: 'unavailable';
}>;
/** The shared public count/time rule. Page adapters retain their own disclosure and source semantics. */
export declare function projectPublicConversationActivity(selection: ConversationActivitySelection<unknown> | undefined): Readonly<{
    state: 'current';
    cohort: 'public';
    count: ConversationActivityReplyCount;
    lastActivityAt: string | null;
}> | Readonly<{
    state: 'withheld';
}>;
/** Keep the exact selected source head separate from the adapter's partition read anchor. */
export declare function projectCommunityActivitySelection<Anchor>(selected: readonly ConversationActivitySelection<Anchor>[]): CommunityActivityRead<Anchor>;
/** Matching a selected cohort does not authorize a read; disclosure stays in each native adapter. */
export declare function projectCommunityComments(threadId: string, witness: CommunityActivityWitness | undefined, actor: CommunityActivityActor): CommunityComments;
/** One result per requested identity; missing or repeated evidence never becomes an exact zero. */
export declare function projectCommunityCommentsBatch(threadIds: readonly string[], witnesses: readonly CommunityActivityWitness[], actor: CommunityActivityActor): ReadonlyMap<string, CommunityComments>;
