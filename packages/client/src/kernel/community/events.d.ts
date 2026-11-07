import { Type } from 'typebox';
/** Closed community event catalogue. Envelope identity and ordering belong to the kernel. */
export declare function COMMUNITY_EVENTS(): {
    readonly "com.rezics.community.space-discovery.invalidated.v1": Type.TObject<{
        target: Type.TUnion<[Type.TObject<{
            kind: Type.TLiteral<"context" | "media" | "space">;
            id: Type.TString;
        }>, Type.TObject<{
            kind: Type.TLiteral<"context" | "media" | "space">;
            id: Type.TString;
        }>, Type.TObject<{
            kind: Type.TLiteral<"context" | "media" | "space">;
            id: Type.TString;
        }>, Type.TObject<{
            kind: Type.TLiteral<"source-fence">;
            route: Type.TInteger;
            source: Type.TString;
            externalId: Type.TString;
            fieldGroup: Type.TUnion<[Type.TLiteral<"facts">, Type.TLiteral<"summary">, Type.TLiteral<"cover">]>;
        }>, Type.TObject<{
            kind: Type.TLiteral<"exposure">;
            group: Type.TString;
        }>]>;
        origin: Type.TObject<{
            partition: Type.TInteger;
            epoch: Type.TInteger;
            position: Type.TString;
            eventId: Type.TString;
            resourceId: Type.TUnion<[Type.TString, Type.TNull]>;
            type: Type.TString;
        }>;
        revisionId: Type.TUnion<[Type.TString, Type.TNull]>;
        nativeVersion: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    readonly 'com.rezics.community.realm-discovery.changed.v1': Type.TObject<{
        realmId: Type.TString;
        realmEpoch: Type.TString;
    }>;
    readonly 'com.rezics.community.space.removed.v1': Type.TObject<{
        kind: Type.TLiteral<"realm" | "space">;
        id: Type.TString;
        state: Type.TLiteral<"active" | "removed">;
        headRevisionId: Type.TString;
        version: Type.TString;
        at: Type.TString;
    }>;
    readonly 'com.rezics.community.space.restored.v1': Type.TObject<{
        kind: Type.TLiteral<"realm" | "space">;
        id: Type.TString;
        state: Type.TLiteral<"active" | "removed">;
        headRevisionId: Type.TString;
        version: Type.TString;
        at: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.removed.v1': Type.TObject<{
        kind: Type.TLiteral<"realm" | "space">;
        id: Type.TString;
        state: Type.TLiteral<"active" | "removed">;
        headRevisionId: Type.TString;
        version: Type.TString;
        at: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.restored.v1': Type.TObject<{
        kind: Type.TLiteral<"realm" | "space">;
        id: Type.TString;
        state: Type.TLiteral<"active" | "removed">;
        headRevisionId: Type.TString;
        version: Type.TString;
        at: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.membership.cancelled.v1': Type.TObject<{
        realmId: Type.TString;
        accountId: Type.TString;
        reservationId: Type.TString;
        transactionId: Type.TString;
        publicationTransactionId: Type.TUnion<[Type.TString, Type.TNull]>;
        transition: Type.TObject<{
            generationId: Type.TString;
            operationId: Type.TString;
            outcome: Type.TUnion<[Type.TLiteral<"published">, Type.TLiteral<"cancelled">]>;
        }>;
        at: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.membership.certified.v1': Type.TObject<{
        realmId: Type.TString;
        accountId: Type.TString;
        reservationId: Type.TString;
        transactionId: Type.TString;
        publicationTransactionId: Type.TUnion<[Type.TString, Type.TNull]>;
        transition: Type.TObject<{
            generationId: Type.TString;
            operationId: Type.TString;
            outcome: Type.TUnion<[Type.TLiteral<"published">, Type.TLiteral<"cancelled">]>;
        }>;
        state: Type.TUnion<[Type.TLiteral<"published">, Type.TLiteral<"cancelled">]>;
    }>;
    readonly 'com.rezics.community.party-locator.projected.v1': Type.TObject<{
        accountId: Type.TString;
    }>;
    readonly 'com.rezics.community.account-records.erased.v1': Type.TObject<{
        accountId: Type.TString;
    }>;
    readonly 'com.rezics.community.revision-locator.indexed.v1': Type.TObject<{
        accountId: Type.TString;
        found: Type.TInteger;
    }>;
    readonly 'com.rezics.community.revision-locators.removed.v1': Type.TObject<{
        accountId: Type.TString;
        found: Type.TInteger;
    }>;
    readonly 'com.rezics.community.revisions.erased.v1': Type.TObject<{
        accountId: Type.TString;
        found: Type.TInteger;
    }>;
    readonly 'com.rezics.community.space.created.v1': Type.TObject<{
        spaceId: Type.TString;
        revisionId: Type.TString;
    }>;
    readonly 'com.rezics.community.space.updated.v1': Type.TObject<{
        spaceId: Type.TString;
        revisionId: Type.TString;
    }>;
    readonly 'com.rezics.community.space.address-claim-pending.v1': Type.TObject<{
        spaceId: Type.TString;
        address: Type.TString;
    }>;
    readonly 'com.rezics.community.space.address-claim-accepted.v1': Type.TUnion<[Type.TObject<{
        spaceId: Type.TString;
        address: Type.TString;
    }>, Type.TObject<{
        spaceId: Type.TString;
        revisionId: Type.TString;
        address: Type.TString;
    }>]>;
    readonly 'com.rezics.community.space.address-changed.v1': Type.TObject<{
        spaceId: Type.TString;
        revisionId: Type.TString;
        address: Type.TString;
    }>;
    readonly 'com.rezics.community.space.address-activated.v1': Type.TObject<{
        spaceId: Type.TString;
        address: Type.TString;
    }>;
    readonly 'com.rezics.community.space.address-reservation-skipped.v1': Type.TObject<{
        spaceId: Type.TString;
        address: Type.TString;
    }>;
    readonly 'com.rezics.community.space.address-reserved.v1': Type.TObject<{
        spaceId: Type.TString;
        address: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.claim-requested.v1': Type.TObject<{
        realmId: Type.TString;
        requestId: Type.TString;
        state: Type.TLiteral<"pending">;
        orphanedAt: Type.TString;
        claimEligibleAt: Type.TString;
        requestedAt: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.created.v1': Type.TObject<{
        realmId: Type.TString;
        revisionId: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.updated.v1': Type.TObject<{
        realmId: Type.TString;
        revisionId: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.ban.v1': Type.TObject<{
        realmId: Type.TString;
        accountId: Type.TString;
        reason: Type.TString;
        actor: Type.TUnion<[Type.TString, Type.TNull]>;
        at: Type.TString;
        transactionId: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.unban.v1': Type.TObject<{
        realmId: Type.TString;
        accountId: Type.TString;
        at: Type.TString;
        transactionId: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.membership.v1': Type.TObject<{
        realmId: Type.TString;
        accountId: Type.TString;
        reservationId: Type.TString;
        role: Type.TUnion<[Type.TLiteral<"member">, Type.TNull]>;
        at: Type.TString;
        transactionId: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.membership.requested.v1': Type.TObject<{
        realmId: Type.TString;
        accountId: Type.TString;
        operationId: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"join">, Type.TLiteral<"leave">, Type.TLiteral<"removal">]>;
        at: Type.TString;
        transactionId: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.membership.terminalized.v1': Type.TObject<{
        realmId: Type.TString;
        accountId: Type.TString;
        reservationId: Type.TString;
        transactionId: Type.TString;
        at: Type.TString;
    }>;
    readonly 'com.rezics.community.member-locator.projected.v1': Type.TObject<{
        accountId: Type.TString;
        realmId: Type.TString;
    }>;
    readonly 'com.rezics.community.member-locator.settled.v1': Type.TObject<{
        accountId: Type.TString;
        realmId: Type.TString;
        transactionId: Type.TString;
    }>;
    readonly 'com.rezics.community.realm.memberships-erased.v1': Type.TObject<{
        accountId: Type.TString;
        realmId: Type.TString;
        at: Type.TString;
        transactionId: Type.TString;
    }>;
    readonly 'com.rezics.community.member-locators.erased.v1': Type.TObject<{
        accountId: Type.TString;
        realmIds: Type.TArray<Type.TString>;
    }>;
    readonly 'com.rezics.community.realm.board-scheme.v1': Type.TObject<{
        realmId: Type.TString;
        revisionId: Type.TString;
        schemeId: Type.TString;
    }>;
    readonly 'com.rezics.community.publication.adopted.v1': Type.TObject<{
        publicationId: Type.TString;
        realmId: Type.TString;
        subjectId: Type.TString;
        verdict: Type.TLiteral<"adopt" | "reject" | "withdraw">;
        predecessor: Type.TUnion<[Type.TString, Type.TNull]>;
        subjectRevisionId: Type.TNull;
        publishedAt: Type.TString;
    }>;
    readonly 'com.rezics.community.publication.withdrawn.v1': Type.TObject<{
        publicationId: Type.TString;
        realmId: Type.TString;
        subjectId: Type.TString;
        verdict: Type.TLiteral<"adopt" | "reject" | "withdraw">;
        predecessor: Type.TUnion<[Type.TString, Type.TNull]>;
        subjectRevisionId: Type.TNull;
        publishedAt: Type.TString;
    }>;
    readonly 'com.rezics.community.publication.rejected.v1': Type.TObject<{
        publicationId: Type.TString;
        realmId: Type.TString;
        subjectId: Type.TString;
        verdict: Type.TLiteral<"adopt" | "reject" | "withdraw">;
        predecessor: Type.TUnion<[Type.TString, Type.TNull]>;
        subjectRevisionId: Type.TNull;
        publishedAt: Type.TString;
    }>;
    readonly 'com.rezics.community.realm-discovery.applied.v1': Type.TObject<{
        realmId: Type.TString;
        generation: Type.TString;
    }>;
    readonly 'com.rezics.community.realm-discovery.expired.v1': Type.TObject<{
        realmId: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"realm">, Type.TLiteral<"bucket">, Type.TLiteral<"thread">, Type.TLiteral<"board">]>;
    }>;
};
