import { Type } from 'typebox';
export declare function ACCESS_EVENTS(): {
    readonly 'com.rezics.access.context-role-delivery-advanced.v1': Type.TObject<{}>;
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
        transition: Type.TOptional<Type.TObject<{
            generationId: Type.TString;
            operationId: Type.TString;
        }>>;
    }>;
    readonly 'com.rezics.access.realm-membership-transition-consumed.v1': Type.TObject<{
        accountId: Type.TString;
        principal: Type.TObject<{
            kind: Type.TUnion<[Type.TLiteral<"organization">, Type.TLiteral<"realm">]>;
            id: Type.TString;
        }>;
        reservationId: Type.TString;
        transition: Type.TObject<{
            generationId: Type.TString;
            operationId: Type.TString;
        }>;
        proofTransactionId: Type.TString;
        outcome: Type.TUnion<[Type.TLiteral<"published">, Type.TLiteral<"cancelled">]>;
    }>;
    readonly 'com.rezics.access.realm-membership-legacy-adopted.v1': Type.TObject<{
        accountId: Type.TString;
        principal: Type.TObject<{
            kind: Type.TUnion<[Type.TLiteral<"organization">, Type.TLiteral<"realm">]>;
            id: Type.TString;
        }>;
        reservationId: Type.TString;
        transition: Type.TObject<{
            generationId: Type.TString;
            operationId: Type.TString;
        }>;
    }>;
    readonly 'com.rezics.access.realm-membership-legacy-recorded.v1': Type.TObject<{
        accountId: Type.TString;
        reservationId: Type.TString;
        realmId: Type.TString;
        holdTransactionId: Type.TString;
        state: Type.TUnion<[Type.TUnion<[Type.TLiteral<"published">, Type.TLiteral<"cancelled">]>, Type.TLiteral<"pending">, Type.TLiteral<"uncertain">]>;
    }>;
    readonly 'com.rezics.access.realm-membership-legacy-page.v1': Type.TObject<{
        afterId: Type.TUnion<[Type.TString, Type.TNull]>;
        completed: Type.TBoolean;
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
    readonly 'com.rezics.access.account-discovery-changed.v1': Type.TObject<{
        route: Type.TInteger;
        accountId: Type.TString;
        revision: Type.TString;
        source: Type.TUnion<[Type.TLiteral<"account">, Type.TLiteral<"claim">]>;
    }>;
};
