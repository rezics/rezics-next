import { Type } from 'typebox';
export declare const CATALOGUE_ARTIFACT: 'com.rezics.definitions.catalogue.artifact.v1';
export declare const CATALOGUE_BUILD_REQUESTED: 'com.rezics.definitions.catalogue.build-requested.v1';
export declare const CATALOGUE_ACTIVATION_REQUESTED: 'com.rezics.definitions.catalogue.activation-requested.v1';
export declare const CATALOGUE_PROGRESS: 'com.rezics.definitions.catalogue.progress.v1';
export declare const CATALOGUE_ACTIVATED: 'com.rezics.definitions.catalogue.activated.v1';
export declare const SUBJECT_MERGED: 'com.rezics.subject.merged.v1';
export declare const SUBJECT_REVISED: 'com.rezics.subject.revised.v1';
export declare const LINKS_MOVING: 'com.rezics.semantic.links.moving.v1';
export declare const LINKS_CHANGED: 'com.rezics.semantic.links.changed.v1';
export declare const LINK_KEYS_CHANGED: 'com.rezics.semantic.links.keys-changed.v1';
export declare const LINKS_VISIBILITY_CHANGED: 'com.rezics.semantic.links.visibility-changed.v1';
export declare const LINKS_PROJECTED: 'com.rezics.semantic.links.projected.v1';
export declare const IDENTITY_SCOPE_NATIVE_ASSOCIATED: 'com.rezics.semantic.identity-scope.native-associated.v1';
export declare const IDENTITY_SCOPE_DIRECTORY_ENROLLED: 'com.rezics.semantic.identity-scope.directory-enrolled.v1';
export declare const IDENTITY_EPOCH_ADMITTED: 'com.rezics.semantic.identity-epoch.admitted.v1';
export declare const IDENTITY_EPOCH_HOME_AVAILABLE: 'com.rezics.semantic.identity-epoch.home-available.v1';
export declare const IDENTITY_EPOCH_PROGRESS: 'com.rezics.semantic.identity-epoch.progress.v1';
export declare const IDENTITY_EPOCH_BOOTSTRAP: 'com.rezics.semantic.identity-epoch.bootstrap.v1';
export declare const IDENTITY_EPOCH_BOOTSTRAP_SCHEDULED: 'com.rezics.semantic.identity-epoch.bootstrap-scheduled.v1';
export declare const IDENTITY_RATING_REPAIR_CONTINUATION: 'com.rezics.semantic.identity-rating-repair.continuation.v1';
export declare const RECORD_DELETED: 'com.rezics.semantic.record.deleted.v1';
export declare const RECORD_RESTORED: 'com.rezics.semantic.record.restored.v1';
export declare const SUBJECT_PAGE_DEPENDENCIES_CHANGED: 'com.rezics.semantic.subject_page.dependencies_changed.v1';
export declare const SUBJECT_PAGE_REPAIR_QUEUED: 'com.rezics.semantic.subject_page.repair_queued.v1';
export declare const SUBJECT_PAGE_REPAIR_REQUESTED: 'com.rezics.semantic.subject_page.repair_requested.v1';
export declare const SUBJECT_PAGE_WORK_COMMITTED: 'com.rezics.semantic.subject_page.work_committed.v1';
/** Closed semantic event catalogue. Envelope identity and ordering belong to the kernel. */
export declare const SEMANTIC_EVENTS: {
    readonly "com.rezics.semantic.identity-scope.native-associated.v1": Type.TObject<{
        sourceKey: Type.TString;
        scope: Type.TString;
        phase: Type.TUnion<Type.TLiteral<string>[]>;
        transactionId: Type.TString;
    }>;
    readonly "com.rezics.semantic.identity-scope.directory-enrolled.v1": Type.TObject<{
        sourceKey: Type.TString;
        scope: Type.TString;
        transactionId: Type.TString;
    }>;
    readonly 'com.rezics.semantic.public-output.capture.v1': Type.TObject<{
        captureId: Type.TString;
    }>;
    readonly "com.rezics.definitions.catalogue.artifact.v1": Type.TObject<{
        digest: Type.TString;
        kind: Type.TUnion<Type.TLiteral<string>[]>;
    }>;
    readonly "com.rezics.definitions.catalogue.build-requested.v1": Type.TObject<{
        rootDigest: Type.TString;
    }>;
    readonly "com.rezics.definitions.catalogue.activation-requested.v1": Type.TObject<{
        rootDigest: Type.TString;
        activationId: Type.TString;
    }>;
    readonly "com.rezics.definitions.catalogue.progress.v1": Type.TObject<{
        rootDigest: Type.TString;
        state: Type.TUnion<Type.TLiteral<string>[]>;
        steps: Type.TString;
    }>;
    readonly "com.rezics.definitions.catalogue.activated.v1": Type.TObject<{
        rootDigest: Type.TString;
        head: Type.TInteger;
        kindSpec: Type.TLiteral<"https://rezics.com/definitions/kind/1">;
        reduction: Type.TLiteral<"https://rezics.com/definitions/kind-reduction/1">;
    }>;
    readonly 'com.rezics.semantic.public-source.advanced.v1': Type.TObject<{
        id: Type.TString;
        bootstrap: Type.TString;
        execution: Type.TString;
    }>;
    readonly 'com.rezics.semantic.context-directory.changed.v1': Type.TObject<{}>;
    readonly 'com.rezics.semantic.provider-review.projected.v1': Type.TObject<{}>;
    readonly 'com.rezics.semantic.composite.registered.v1': Type.TObject<{
        context: Type.TString;
        digest: Type.TString;
    }>;
    readonly 'com.rezics.semantic.erasure.scheduled.v1': Type.TObject<{
        accountId: Type.TString;
    }>;
    readonly 'com.rezics.semantic.erasure.locator-scheduled.v1': Type.TObject<{
        position: Type.TString;
    }>;
    readonly 'com.rezics.semantic.erasure.locator-advanced.v1': Type.TObject<{
        position: Type.TString;
    }>;
    readonly 'com.rezics.semantic.erasure.progress.v1': Type.TObject<{
        accountId: Type.TString;
    }>;
    readonly "com.rezics.semantic.identity-epoch.home-available.v1": Type.TObject<{
        partition: Type.TInteger;
        after: Type.TString;
    }>;
    readonly "com.rezics.semantic.identity-epoch.bootstrap-scheduled.v1": Type.TObject<{
        partition: Type.TInteger;
    }>;
    readonly "com.rezics.semantic.identity-epoch.admitted.v1": Type.TObject<{
        jobId: Type.TString;
        epoch: Type.TString;
        partition: Type.TInteger;
    }>;
    readonly "com.rezics.semantic.identity-epoch.progress.v1": Type.TObject<{
        partition: Type.TInteger;
        generation: Type.TString;
    }>;
    readonly "com.rezics.semantic.identity-rating-repair.continuation.v1": Type.TObject<{
        partition: Type.TInteger;
        voterPartition: Type.TInteger;
        obligationId: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"prepare">, Type.TLiteral<"drain">]>;
        originals: Type.TArray<Type.TString>;
    }>;
    readonly "com.rezics.semantic.identity-epoch.bootstrap.v1": Type.TObject<{
        partition: Type.TInteger;
        generation: Type.TString;
    }>;
    readonly "com.rezics.semantic.record.deleted.v1": Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"context">;
        id: Type.TString;
        version: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"candidate">;
        id: Type.TString;
        subject: Type.TString;
        version: Type.TString;
        deletedAt: Type.TUnion<[Type.TString, Type.TNull]>;
        purgeAfter: Type.TUnion<[Type.TString, Type.TNull]>;
    }>]>;
    readonly "com.rezics.semantic.record.restored.v1": Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"context">;
        id: Type.TString;
        version: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"candidate">;
        id: Type.TString;
        subject: Type.TString;
        version: Type.TString;
        deletedAt: Type.TUnion<[Type.TString, Type.TNull]>;
        purgeAfter: Type.TUnion<[Type.TString, Type.TNull]>;
    }>]>;
    readonly 'com.rezics.source-record.metadata-changed.v1': Type.TObject<{
        source: Type.TString;
        external_id: Type.TString;
        metadata_revision: Type.TInteger;
    }>;
    readonly "com.rezics.semantic.subject_page.work_committed.v1": Type.TObject<{
        partition: Type.TInteger;
        kind: Type.TUnion<Type.TLiteral<string>[]>;
    }>;
    readonly "com.rezics.semantic.subject_page.repair_queued.v1": Type.TObject<{
        subject: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        cause: Type.TUnion<[Type.TLiteral<"missing-proof">, Type.TLiteral<"explicit">]>;
    }>;
    readonly "com.rezics.semantic.subject_page.dependencies_changed.v1": Type.TObject<{
        deltas: Type.TArray<Type.TObject<{
            subject: Type.TObject<{
                route: Type.TInteger;
                id: Type.TString;
            }>;
            component: Type.TObject<{
                kind: Type.TUnion<Type.TLiteral<string>[]>;
                key: Type.TString;
            }>;
            owner: Type.TObject<{
                kind: Type.TUnion<[Type.TLiteral<"subject">, Type.TLiteral<"source-fence">]>;
                route: Type.TInteger;
                key: Type.TString;
            }>;
            sourceVersion: Type.TString;
            eventId: Type.TString;
            changeId: Type.TString;
            present: Type.TBoolean;
            time: Type.TObject<{
                effectiveAt: Type.TUnion<[Type.TString, Type.TNull]>;
                evidence: Type.TUnion<[Type.TLiteral<"known">, Type.TLiteral<"missing">]>;
            }>;
        }>>;
    }>;
    readonly "com.rezics.semantic.subject_page.repair_requested.v1": Type.TObject<{
        subject: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        owner: Type.TObject<{
            kind: Type.TUnion<[Type.TLiteral<"subject">, Type.TLiteral<"source-fence">]>;
            route: Type.TInteger;
            key: Type.TString;
        }>;
        changeId: Type.TString;
        eventId: Type.TString;
        time: Type.TObject<{
            effectiveAt: Type.TUnion<[Type.TString, Type.TNull]>;
            evidence: Type.TUnion<[Type.TLiteral<"known">, Type.TLiteral<"missing">]>;
        }>;
    }>;
    readonly "com.rezics.subject.merged.v1": Type.TObject<{
        id: Type.TString;
        survivor: Type.TString;
    }>;
    readonly "com.rezics.subject.revised.v1": Type.TObject<{
        id: Type.TString;
        revision: Type.TInteger;
        kind: Type.TUnion<[Type.TLiteral<"create">, Type.TLiteral<"terms">, Type.TLiteral<"propose">, Type.TLiteral<"accept">, Type.TLiteral<"reject">, Type.TLiteral<"adopt">, Type.TLiteral<"merge">, Type.TLiteral<"retract">, Type.TLiteral<"identity">]>;
    }>;
    readonly "com.rezics.semantic.links.moving.v1": Type.TObject<{
        id: Type.TString;
        survivor: Type.TString;
        cursor: Type.TArray<Type.TUnion<[Type.TString, Type.TInteger]>>;
        verification: Type.TOptional<Type.TObject<{
            account: Type.TString;
            receipt: Type.TString;
        }>>;
    }>;
    readonly "com.rezics.semantic.links.keys-changed.v1": Type.TObject<{
        subject: Type.TString;
        direction: Type.TUnion<[Type.TLiteral<"holder">, Type.TLiteral<"target">]>;
        revision: Type.TInteger;
        security_revision: Type.TInteger;
        cursor: Type.TArray<Type.TUnion<[Type.TString, Type.TInteger]>>;
    }>;
    readonly "com.rezics.semantic.links.visibility-changed.v1": Type.TObject<{
        subject: Type.TString;
        revision: Type.TInteger;
        security_revision: Type.TInteger;
        release: Type.TString;
        visible: Type.TBoolean;
        cursor: Type.TArray<Type.TUnion<[Type.TString, Type.TInteger]>>;
    }>;
    readonly 'com.rezics.subject.statement_disclosed.v1': Type.TObject<{
        id: Type.TString;
        candidate: Type.TString;
    }>;
    readonly 'com.rezics.statement.retracted.v1': Type.TObject<{
        candidate: Type.TString;
        revision: Type.TInteger;
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
        security_revision: Type.TInteger;
        changes: Type.TArray<Type.TObject<{
            context_id: Type.TOptional<Type.TString>;
            suppressed: Type.TOptional<Type.TBoolean>;
            property: Type.TString;
            statement: Type.TString;
            target: Type.TUnion<[Type.TString, Type.TNull]>;
            present: Type.TBoolean;
            project_outbound: Type.TOptional<Type.TBoolean>;
            relation: Type.TOptional<Type.TBoolean>;
            slot_id: Type.TOptional<Type.TString>;
            external: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            value: Type.TOptional<Type.TUnion<[Type.TLiteral<"value">, Type.TLiteral<"somevalue">, Type.TLiteral<"novalue">]>>;
            outbound_order: Type.TOptional<Type.TUnion<[Type.TLiteral<"position">, Type.TLiteral<"date">, Type.TLiteral<"name">, Type.TNull]>>;
            outbound_order_key: Type.TOptional<Type.TString>;
            source_type: Type.TOptional<Type.TString>;
            order_key: Type.TOptional<Type.TString>;
            filter_value: Type.TOptional<Type.TString>;
        }>>;
    }>;
    readonly 'com.rezics.semantic.links.projected.v1': Type.TObject<{
        subjects: Type.TArray<Type.TString>;
    }>;
};
