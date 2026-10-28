import { Type, type TSchema } from 'typebox';
import { type Validator } from 'typebox/compile';
declare const productEventTypes: {
    readonly "com.rezics.subject.merged.v1": Type.TObject<{
        id: Type.TString;
        survivor: Type.TString;
    }>;
    readonly "com.rezics.subject.revised.v1": Type.TObject<{
        id: Type.TString;
        revision: Type.TInteger;
        kind: Type.TUnion<[Type.TLiteral<"create">, Type.TLiteral<"propose">, Type.TLiteral<"accept">, Type.TLiteral<"reject">, Type.TLiteral<"adopt">, Type.TLiteral<"merge">, Type.TLiteral<"retract">, Type.TLiteral<"identity">]>;
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
    readonly 'com.rezics.zone.created.v1': Type.TObject<{
        id: Type.TString;
        revision: Type.TString;
    }>;
    readonly 'com.rezics.zone.configured.v1': Type.TObject<{
        id: Type.TString;
        revision: Type.TString;
    }>;
    readonly 'com.rezics.zone.published.v1': Type.TObject<{
        id: Type.TString;
        revision: Type.TString;
    }>;
    readonly 'com.rezics.zone.deleted.v1': Type.TObject<{
        id: Type.TString;
        revision: Type.TString;
    }>;
    readonly 'com.rezics.zone.restored.v1': Type.TObject<{
        id: Type.TString;
        revision: Type.TString;
    }>;
    readonly 'com.rezics.access.organization-close.page.v1': Type.TObject<{
        count: Type.TInteger;
        members: Type.TArray<Type.TString>;
        handle: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    readonly 'com.rezics.access.organization-close.release.v1': Type.TObject<{
        accountId: Type.TString;
    }>;
    readonly 'com.rezics.access.organization-close.completed.v1': Type.TObject<{
        accountId: Type.TString;
    }>;
    readonly 'com.rezics.access.rating-counter.changed.v1': Type.TObject<{
        accountId: Type.TString;
        at: Type.TString;
    }>;
    readonly 'com.rezics.access.exposure.opened.v1': Type.TObject<{
        group: Type.TString;
        open: Type.TLiteral<boolean>;
        changed: Type.TBoolean;
    }>;
    readonly 'com.rezics.access.exposure.closed.v1': Type.TObject<{
        group: Type.TString;
        open: Type.TLiteral<boolean>;
        changed: Type.TBoolean;
    }>;
    readonly 'com.rezics.access.operator.fence-page.v1': Type.TObject<{
        pageKey: Type.TString;
        count: Type.TInteger;
    }>;
    readonly 'com.rezics.access.operator.unfence-page.v1': Type.TObject<{
        pageKey: Type.TString;
        count: Type.TInteger;
    }>;
    readonly 'com.rezics.access.operator.subject-unfenced.v1': Type.TObject<{
        accountId: Type.TString;
        lifted: Type.TBoolean;
    }>;
    readonly 'com.rezics.access.operator.subject-fenced.v1': Type.TObject<{
        accountId: Type.TString;
        fenced: Type.TBoolean;
        receiptId: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    readonly 'com.rezics.access.account.suspended.v1': Type.TObject<{
        accountId: Type.TString;
        state: Type.TLiteral<"suspended">;
        continuationOperationKey: Type.TOptional<Type.TString>;
        minimumAuthnEpoch: Type.TString;
        receiptId: Type.TString;
    }>;
    readonly 'com.rezics.access.account.reinstated.v1': Type.TObject<{
        accountId: Type.TString;
        state: Type.TLiteral<"active">;
        continuationOperationKey: Type.TOptional<Type.TString>;
        minimumAuthnEpoch: Type.TString;
        receiptId: Type.TString;
    }>;
    readonly 'com.rezics.access.account.rate-tier-set.v1': Type.TObject<{
        accountId: Type.TString;
        tier: Type.TUnion<[Type.TLiteral<"ordinary">, Type.TLiteral<"trusted">, Type.TLiteral<"service">]>;
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
    readonly 'com.rezics.access.handle-held.v1': Type.TObject<{
        accountId: Type.TString;
        handle: Type.TString;
        reservationId: Type.TString;
        operationId: Type.TString;
    }>;
    readonly 'com.rezics.access.organization-handle-published.v1': Type.TObject<{
        accountId: Type.TString;
        handle: Type.TString;
        operationId: Type.TString;
        reservedHandleException: Type.TOptional<Type.TLiteral<true>>;
    }>;
    readonly 'com.rezics.access.account-handle-published.v1': Type.TObject<{
        accountId: Type.TString;
        handle: Type.TString;
        operationId: Type.TString;
        reservedHandleException: Type.TOptional<Type.TLiteral<true>>;
    }>;
    readonly 'com.rezics.access.transition-handle-claimed.v1': Type.TObject<{
        accountId: Type.TString;
        handle: Type.TString;
    }>;
    readonly 'com.rezics.access.transition-handle-redirected.v1': Type.TObject<{
        accountId: Type.TString;
        handle: Type.TString;
        reservedUntil: Type.TString;
    }>;
    readonly 'com.rezics.access.handle-transition-completed.v1': Type.TObject<{
        accountId: Type.TString;
        handle: Type.TString;
    }>;
    readonly 'com.rezics.access.handle-transition-cancelled.v1': Type.TObject<{
        accountId: Type.TString;
        operationId: Type.TString;
    }>;
    readonly 'com.rezics.access.handle-transition-released.v1': Type.TObject<{
        accountId: Type.TString;
        handle: Type.TString;
    }>;
    readonly 'com.rezics.access.registration-expired.v1': Type.TObject<{
        receiptId: Type.TString;
        accountId: Type.TString;
        minimumAuthnEpoch: Type.TString;
        kind: Type.TLiteral<"fence" | "tombstone">;
        priorOperatorAccountId: Type.TNull | Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    readonly 'com.rezics.access.registration-handle-released.v1': Type.TObject<{
        accountId: Type.TString;
        handle: Type.TString;
    }>;
    readonly 'com.rezics.access.handle-reserved.v1': Type.TObject<{
        handle: Type.TString;
        accountId: Type.TString;
        reservationId: Type.TString;
        expiresAt: Type.TString;
        reservedHandleException: Type.TOptional<Type.TLiteral<true>>;
    }>;
    readonly 'com.rezics.access.actor-pending.v1': Type.TObject<{
        accountId: Type.TString;
        registrationId: Type.TString;
        expiresAt: Type.TString;
    }>;
    readonly 'com.rezics.access.actor-activated.v1': Type.TObject<{
        accountId: Type.TString;
    }>;
    readonly 'com.rezics.access.self-read-installed.v1': Type.TObject<{
        accountId: Type.TString;
        installed: Type.TInteger;
    }>;
    readonly 'com.rezics.access.handle-claimed.v1': Type.TObject<{
        handle: Type.TString;
        accountId: Type.TString;
        reservedHandleException: Type.TOptional<Type.TLiteral<true>>;
    }>;
    readonly 'com.rezics.access.handle-redirected.v1': Type.TObject<{
        handle: Type.TString;
        accountId: Type.TString;
        reservedUntil: Type.TString;
    }>;
    readonly 'com.rezics.access.handle-expired.v1': Type.TObject<{
        handle: Type.TString;
        released: Type.TLiteral<true>;
    }>;
    readonly 'com.rezics.access.coordination-reserved.v1': Type.TObject<{
        accountId: Type.TString;
        relatedAccountId: Type.TString;
        purpose: Type.TLiteral<"operator">;
        reservationId: Type.TString;
    }>;
    readonly 'com.rezics.access.membership-terminalized.v1': Type.TObject<{
        organizationId: Type.TString;
        memberAccountId: Type.TString;
        reservationId: Type.TString;
        key: Type.TString;
        transactionId: Type.TString;
    }>;
    readonly 'com.rezics.access.organization-created.v1': Type.TObject<{
        accountId: Type.TString;
        ownerAccountId: Type.TString;
    }>;
    readonly 'com.rezics.access.authentication-floor-advanced.v1': Type.TObject<{
        receiptId: Type.TString;
        accountId: Type.TString;
        minimumAuthnEpoch: Type.TString;
        kind: Type.TLiteral<"fence" | "tombstone">;
        priorOperatorAccountId: Type.TNull | Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    readonly 'com.rezics.access.authentication-fenced.v1': Type.TObject<{
        receiptId: Type.TString;
        accountId: Type.TString;
        minimumAuthnEpoch: Type.TString;
        kind: Type.TLiteral<"fence" | "tombstone">;
        priorOperatorAccountId: Type.TNull | Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    readonly 'com.rezics.access.authentication-established.v1': Type.TObject<{
        accountId: Type.TString;
        receiptId: Type.TString;
        minimumAuthnEpoch: Type.TString;
    }>;
    readonly 'com.rezics.access.account-updated.v1': Type.TObject<{
        accountId: Type.TString;
    }>;
    readonly 'com.rezics.access.account-display-name-changed.v1': Type.TObject<{
        accountId: Type.TString;
    }>;
    readonly 'com.rezics.access.agent-verification.reversing.v1': Type.TObject<{
        accountId: Type.TString;
        catalogueSubjectId: Type.TString;
        verificationReceiptId: Type.TString;
        receiptId: Type.TString;
        requestedBy: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"released">, Type.TLiteral<"revoked">]>;
        reason: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    readonly 'com.rezics.access.agent-verification.reversed.v1': Type.TObject<{
        accountId: Type.TString;
        catalogueSubjectId: Type.TString;
        verificationReceiptId: Type.TString;
        receiptId: Type.TString;
        requestedBy: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"released">, Type.TLiteral<"revoked">]>;
        reason: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    readonly 'com.rezics.access.agent-verification.requested.v1': Type.TObject<{
        requestId: Type.TString;
        accountId: Type.TString;
        catalogueSubjectId: Type.TString;
    }>;
    readonly 'com.rezics.access.agent-verification.withdrawn.v1': Type.TObject<{
        requestId: Type.TString;
        accountId: Type.TString;
    }>;
    readonly 'com.rezics.access.agent-verification.approved.v1': Type.TObject<{
        requestId: Type.TString;
        accountId: Type.TString;
        catalogueSubjectId: Type.TString;
        receiptId: Type.TString;
    }>;
    readonly 'com.rezics.access.agent-verification.rejected.v1': Type.TObject<{
        requestId: Type.TString;
        accountId: Type.TString;
        catalogueSubjectId: Type.TString;
        receiptId: Type.TString;
    }>;
    readonly 'com.rezics.access.agent-verification.failed.v1': Type.TObject<{
        requestId: Type.TString;
        accountId: Type.TString;
        catalogueSubjectId: Type.TString;
        receiptId: Type.TString;
        problemType: Type.TString;
    }>;
    readonly 'com.rezics.access.agent-verification.verified.v1': Type.TObject<{
        requestId: Type.TString;
        accountId: Type.TString;
        catalogueSubjectId: Type.TString;
        receiptId: Type.TString;
    }>;
    readonly 'com.rezics.access.membership-changed.v1': Type.TObject<{
        organizationId: Type.TString;
        memberAccountId: Type.TString;
        reservationId: Type.TString;
        role: Type.TUnion<[Type.TLiteral<"owner">, Type.TLiteral<"member">, Type.TNull]>;
    }>;
    readonly 'com.rezics.access.account-tombstoned.v1': Type.TObject<{
        receiptId: Type.TString;
        accountId: Type.TString;
        minimumAuthnEpoch: Type.TString;
        kind: Type.TLiteral<"fence" | "tombstone">;
        priorOperatorAccountId: Type.TNull | Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    readonly 'com.rezics.access.membership-inverse-reserved.v1': Type.TObject<{
        accountId: Type.TString;
        principal: Type.TObject<{
            kind: Type.TUnion<[Type.TLiteral<"organization">, Type.TLiteral<"realm">]>;
            id: Type.TString;
        }>;
        reservationId: Type.TString;
    }>;
    readonly 'com.rezics.access.membership-inverse-bootstrapped.v1': Type.TObject<{
        accountId: Type.TString;
        principal: Type.TObject<{
            kind: Type.TUnion<[Type.TLiteral<"organization">, Type.TLiteral<"realm">]>;
            id: Type.TString;
        }>;
        reservationId: Type.TString;
        sourceTransactionId: Type.TString;
    }>;
    readonly 'com.rezics.access.membership-inverse-released.v1': Type.TObject<{
        accountId: Type.TString;
        principal: Type.TObject<{
            kind: Type.TUnion<[Type.TLiteral<"organization">, Type.TLiteral<"realm">]>;
            id: Type.TString;
        }>;
        reservationId: Type.TString;
        proofTransactionId: Type.TString;
    }>;
    readonly 'com.rezics.access.membership-coordination-released.v1': Type.TObject<{
        accountId: Type.TString;
        principal: Type.TObject<{
            kind: Type.TUnion<[Type.TLiteral<"organization">, Type.TLiteral<"realm">]>;
            id: Type.TString;
        }>;
        reservationId: Type.TString;
        proofTransactionId: Type.TString;
        organizationId: Type.TString;
        memberAccountId: Type.TString;
    }>;
    readonly 'com.rezics.access.operator.management-provisioned.v1': Type.TObject<{
        operatorAccountId: Type.TString;
        action: Type.TString;
    }>;
    readonly 'com.rezics.access.operator.responsibility-reserved.v1': Type.TObject<{
        operatorAccountId: Type.TString;
        subjectAccountId: Type.TString;
        reservationId: Type.TString;
    }>;
    readonly 'com.rezics.access.operator.relation-recorded.v1': Type.TObject<{
        subjectAccountId: Type.TString;
        operatorAccountId: Type.TString;
        reservationId: Type.TString;
        version: Type.TString;
    }>;
    readonly 'com.rezics.access.operator.responsibility-retired.v1': Type.TObject<{
        operatorAccountId: Type.TString;
        subjectAccountId: Type.TString;
        reservationId: Type.TString;
    }>;
    readonly 'com.rezics.access.operator.responsibility-released.v1': Type.TObject<{
        operatorAccountId: Type.TString;
        subjectAccountId: Type.TString;
        reservationId: Type.TString;
    }>;
    readonly 'com.rezics.access.operator.opening-authorized.v1': Type.TObject<{
        operatorAccountId: Type.TString;
        subjectAccountId: Type.TString;
        reservationId: Type.TString;
        version: Type.TString;
        receiptId: Type.TString;
        actingHumanId: Type.TString;
        purpose: Type.TUnion<[Type.TLiteral<"session">, Type.TLiteral<"credential-management">]>;
        clientId: Type.TString;
        scopes: Type.TArray<Type.TString>;
        requestedBy: Type.TUnion<[Type.TString, Type.TNull]>;
        expiresAt: Type.TString;
    }>;
    readonly 'com.rezics.access.operator.opening-consumed.v1': Type.TObject<{
        operatorAccountId: Type.TString;
        subjectAccountId: Type.TString;
        reservationId: Type.TString;
        version: Type.TString;
        receiptId: Type.TString;
        actingHumanId: Type.TString;
        purpose: Type.TUnion<[Type.TLiteral<"session">, Type.TLiteral<"credential-management">]>;
        clientId: Type.TString;
        scopes: Type.TArray<Type.TString>;
        requestedBy: Type.TUnion<[Type.TString, Type.TNull]>;
        expiresAt: Type.TString;
    }>;
    readonly 'com.rezics.access.workflow-bound.v1': Type.TObject<{
        digest: Type.TString;
    }>;
    readonly 'com.rezics.access.workflow-approved.v1': Type.TObject<{
        approvalId: Type.TString;
        digest: Type.TString;
    }>;
    readonly 'com.rezics.access.credential-approved-consumed.v1': Type.TObject<{
        approvalId: Type.TString;
    }>;
    readonly 'com.rezics.access.workflow-approvals-swept.v1': Type.TObject<{
        route: Type.TInteger;
        count: Type.TInteger;
    }>;
    readonly 'com.rezics.access.credential-floor-advanced.v1': Type.TObject<{
        openingReceiptId: Type.TString;
    }>;
    readonly 'com.rezics.access.standing-parent.installed.v1': Type.TObject<{
        resource: Type.TObject<{
            route: Type.TInteger;
            id: Type.TString;
        }>;
        actions: Type.TArray<Type.TString>;
    }>;
    readonly 'com.rezics.access.cleanup-continuation.recorded.v1': Type.TObject<{
        continuationId: Type.TString;
        receiptId: Type.TString;
    }>;
    readonly 'com.rezics.access.cleanup-continuation.renewed.v1': Type.TObject<{
        continuationId: Type.TString;
        expiresAt: Type.TString;
        receiptId: Type.TString;
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
        actor: Type.TString;
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
        realmId: Type.TString;
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
    readonly 'com.rezics.library.account-facts.purged.v1': Type.TObject<{
        accountId: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"entry">, Type.TLiteral<"copy">, Type.TLiteral<"follow">]>;
        examined: Type.TInteger;
        removed: Type.TInteger;
    }>;
    readonly 'com.rezics.library.subject.listed.v1': Type.TObject<{
        subjectId: Type.TString;
    }>;
    readonly 'com.rezics.library.follow.updated.v1': Type.TObject<{
        targetId: Type.TString;
    }>;
    readonly 'com.rezics.library.entry.updated.v1': Type.TObject<{
        subjectId: Type.TString;
    }>;
    readonly 'com.rezics.library.entry.deleted.v1': Type.TObject<{
        subjectId: Type.TString;
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
    readonly 'com.rezics.library.published_log.updated.v1': Type.TObject<{
        logId: Type.TString;
    }>;
    readonly 'com.rezics.library.published_log.deleted.v1': Type.TObject<{
        logId: Type.TString;
    }>;
    readonly 'com.rezics.library.collection.updated.v1': Type.TObject<{
        collectionId: Type.TString;
    }>;
    readonly 'com.rezics.library.collection.deleted.v1': Type.TObject<{
        collectionId: Type.TString;
    }>;
    readonly 'com.rezics.library.collection.member.changed.v1': Type.TObject<{
        collectionId: Type.TString;
        memberId: Type.TString;
        subjectId: Type.TString;
    }>;
    readonly 'com.rezics.library.collection.listing.changed.v1': Type.TObject<{
        collectionId: Type.TString;
    }>;
    readonly 'com.rezics.rating.voter-realm.changed.v1': Type.TObject<{
        voterId: Type.TString;
        realmId: Type.TString;
    }>;
    readonly 'com.rezics.rating.vote.changed.v1': Type.TObject<{
        voterId: Type.TString;
        questionId: Type.TString;
        targetId: Type.TString;
        aggregateTargetId: Type.TOptional<Type.TString>;
        previous: Type.TUnion<[Type.TInteger, Type.TNull]>;
        units: Type.TUnion<[Type.TInteger, Type.TNull]>;
        revision: Type.TInteger;
        populations: Type.TArray<Type.TString>;
    }>;
    readonly 'com.rezics.rating.aggregate.applied.v1': Type.TObject<{
        applied: Type.TInteger;
    }>;
    readonly 'com.rezics.rating.prior_epoch.work.v1': Type.TObject<{
        action: Type.TUnion<[Type.TLiteral<"check">, Type.TLiteral<"mark">, Type.TLiteral<"advance">]>;
        questionId: Type.TString;
        populationId: Type.TString;
        generation: Type.TString;
        subjects: Type.TInteger;
    }>;
    readonly 'com.rezics.rating.public_figure.changed.v1': Type.TObject<{
        questionId: Type.TString;
        populationId: Type.TString;
        subjectId: Type.TString;
        count: Type.TInteger;
        mean: Type.TUnion<[Type.TNumber, Type.TNull]>;
        score: Type.TUnion<[Type.TNumber, Type.TNull]>;
        m: Type.TUnion<[Type.TNumber, Type.TNull]>;
        C: Type.TUnion<[Type.TInteger, Type.TNull]>;
        priorEpoch: Type.TUnion<[Type.TInteger, Type.TNull]>;
        revision: Type.TString;
        asOf: Type.TUnion<[Type.TString, Type.TNull]>;
        position: Type.TString;
    }>;
    readonly 'com.rezics.rating.segment.page.v1': Type.TUnion<[Type.TObject<{
        voterId: Type.TString;
        direction: Type.TLiteral<"rekey">;
        at: Type.TString;
        allowMissing: Type.TBoolean;
        votes: Type.TArray<Type.TObject<{
            questionId: Type.TString;
            targetId: Type.TString;
            countedTargetId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            units: Type.TUnion<[Type.TInteger, Type.TNull]>;
            revision: Type.TInteger;
            populations: Type.TArray<Type.TString>;
            changedAt: Type.TString;
        }>>;
    }>, Type.TObject<{
        voterId: Type.TString;
        direction: Type.TUnion<[Type.TLiteral<"adding">, Type.TLiteral<"removing">]>;
        votes: Type.TArray<Type.TObject<{
            questionId: Type.TString;
            targetId: Type.TString;
            countedTargetId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            units: Type.TUnion<[Type.TInteger, Type.TNull]>;
            revision: Type.TInteger;
            populations: Type.TArray<Type.TString>;
        }>>;
    }>, Type.TObject<{
        voterId: Type.TString;
        realmId: Type.TString;
        direction: Type.TUnion<[Type.TLiteral<"adding">, Type.TLiteral<"removing">]>;
        votes: Type.TArray<Type.TObject<{
            questionId: Type.TString;
            targetId: Type.TString;
            countedTargetId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            units: Type.TUnion<[Type.TInteger, Type.TNull]>;
            revision: Type.TInteger;
        }>>;
    }>]>;
    readonly 'com.rezics.rating.eligibility.changed.v1': Type.TObject<{
        voterId: Type.TString;
    }>;
    readonly 'com.rezics.rating.population.pending.v1': Type.TObject<{
        populationId: Type.TString;
        pendingJobs: Type.TInteger;
    }>;
    readonly 'com.rezics.rating.source_statistic.changed.v1': Type.TObject<{
        subjectId: Type.TString;
        source: Type.TLiteral<"vndb">;
        sourceRecordId: Type.TString;
    }>;
    readonly 'com.rezics.rating.subject-merge.page.v1': Type.TObject<{
        id: Type.TString;
        survivor: Type.TString;
        voters: Type.TInteger;
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
    readonly 'com.rezics.subject.statement_visibility_changed.v1': Type.TObject<{
        id: Type.TString;
        candidate: Type.TString;
        visibility: Type.TUnion<[Type.TLiteral<"visible">, Type.TLiteral<"hidden">, Type.TLiteral<"taken_down">]>;
        security_revision: Type.TInteger;
    }>;
    readonly 'com.rezics.semantic.context.created.v1': Type.TObject<{
        id: Type.TString;
    }>;
};
/** Schema view retained for consumers that inspect event contracts. */
export declare const EVENT_TYPES: Readonly<typeof productEventTypes> & Readonly<Record<string, TSchema>>;
/** Register startup-only event contracts, compiling each schema exactly once. */
export declare function registerEventTypes(entries: Readonly<Record<string, TSchema>>): void;
export declare function lookupEventType(type: string): Validator | undefined;
/** Called only after a command transaction has committed successfully. */
export declare function sealEventTypes(): void;
export {};
