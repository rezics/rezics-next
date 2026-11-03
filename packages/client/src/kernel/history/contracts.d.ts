/** Stored role bits: append new powers of two; never reuse or renumber a bit. */
export declare const ACCOUNT_ROLE_BITS: Readonly<{
    principal: 1;
    actor: 2;
    'acting-human': 4;
    delegate: 8;
    operator: 16;
    subject: 32;
    'durable-initiator': 64;
    reporter: 128;
    author: 256;
    member: 512;
    buyer: 1024;
    creator: 2048;
    reviewer: 4096;
    owner: 8192;
    uploader: 16384;
    appellant: 32768;
    voter: 65536;
    'related-party': 131072;
}>;
export type AccountRole = keyof typeof ACCOUNT_ROLE_BITS;
export declare const ACCOUNT_ROLES: readonly ("acting-human" | "actor" | "appellant" | "author" | "buyer" | "creator" | "delegate" | "durable-initiator" | "member" | "operator" | "owner" | "principal" | "related-party" | "reporter" | "reviewer" | "subject" | "uploader" | "voter")[];
export declare const ALL_ACCOUNT_ROLES = 262143;
export declare function validateRoleMask(value: unknown, allowed?: number): number;
export declare function encodeRoles(roles: readonly AccountRole[]): number;
export declare function decodeRoles(mask: number): readonly AccountRole[];
export declare const HISTORY_ARTIFACTS: Readonly<{
    'command-receipt/v1': Readonly<{
        minimizerVersion: 1;
        skeletonFields: readonly string[];
        roles: readonly ("acting-human" | "actor" | "appellant" | "author" | "buyer" | "creator" | "delegate" | "durable-initiator" | "member" | "operator" | "owner" | "principal" | "related-party" | "reporter" | "reviewer" | "subject" | "uploader" | "voter")[];
    }>;
    'outbox-event/v1': Readonly<{
        minimizerVersion: 1;
        skeletonFields: readonly string[];
        roles: readonly ("acting-human" | "actor" | "appellant" | "author" | "buyer" | "creator" | "delegate" | "durable-initiator" | "member" | "operator" | "owner" | "principal" | "related-party" | "reporter" | "reviewer" | "subject" | "uploader" | "voter")[];
    }>;
    'durable-work/v1': Readonly<{
        minimizerVersion: 1;
        skeletonFields: readonly string[];
        roles: readonly ("acting-human" | "actor" | "appellant" | "author" | "buyer" | "creator" | "delegate" | "durable-initiator" | "member" | "operator" | "owner" | "principal" | "related-party" | "reporter" | "reviewer" | "subject" | "uploader" | "voter")[];
    }>;
}>;
export type HistoryArtifactType = keyof typeof HISTORY_ARTIFACTS;
export declare function historyArtifact(type: string, minimizerVersion?: number): Readonly<{
    minimizerVersion: 1;
    skeletonFields: readonly string[];
    roles: readonly ("acting-human" | "actor" | "appellant" | "author" | "buyer" | "creator" | "delegate" | "durable-initiator" | "member" | "operator" | "owner" | "principal" | "related-party" | "reporter" | "reviewer" | "subject" | "uploader" | "voter")[];
}>;
export type EventClassification = Readonly<{
    kind: 'account-bearing';
    roles: readonly AccountRole[];
}> | Readonly<{
    kind: 'non-personal';
    roles: readonly [];
}>;
/** Payload/native owner associations, never inferred from UUIDs or JSON. Command scope is added even for
 * non-personal payloads; an owner's private association overrides a public-resource disposition. */
export declare const EVENT_CLASSIFICATIONS: Readonly<{
    'com.rezics.access.account-display-name-changed.v1': EventClassification;
    'com.rezics.access.account-handle-published.v1': EventClassification;
    'com.rezics.access.account-tombstoned.v1': EventClassification;
    'com.rezics.history.erasure-acknowledged.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.access.account-updated.v1': EventClassification;
    'com.rezics.access.account.rate-tier-set.v1': EventClassification;
    'com.rezics.access.account.reinstated.v1': EventClassification;
    'com.rezics.access.account.suspended.v1': EventClassification;
    'com.rezics.access.actor-activated.v1': EventClassification;
    'com.rezics.access.actor-pending.v1': EventClassification;
    'com.rezics.access.agent-verification.approved.v1': EventClassification;
    'com.rezics.access.agent-verification.failed.v1': EventClassification;
    'com.rezics.access.agent-verification.rejected.v1': EventClassification;
    'com.rezics.access.agent-verification.requested.v1': EventClassification;
    'com.rezics.access.agent-verification.reversed.v1': EventClassification;
    'com.rezics.access.agent-verification.reversing.v1': EventClassification;
    'com.rezics.access.agent-verification.verified.v1': EventClassification;
    'com.rezics.access.agent-verification.withdrawn.v1': EventClassification;
    'com.rezics.access.assignment.create.v1': EventClassification;
    'com.rezics.access.assignment.revoke.v1': EventClassification;
    'com.rezics.access.authentication-established.v1': EventClassification;
    'com.rezics.access.authentication-fenced.v1': EventClassification;
    'com.rezics.access.authentication-floor-advanced.v1': EventClassification;
    'com.rezics.access.cleanup-continuation.recorded.v1': EventClassification;
    'com.rezics.access.cleanup-continuation.renewed.v1': EventClassification;
    'com.rezics.access.coordination-reserved.v1': EventClassification;
    'com.rezics.access.credential-approved-consumed.v1': EventClassification;
    'com.rezics.access.credential-floor-advanced.v1': EventClassification;
    'com.rezics.access.exposure.closed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.access.exposure.opened.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.access.governance.bootstrapped.v1': EventClassification;
    'com.rezics.access.grant.change.v1': EventClassification;
    'com.rezics.access.grant.create.v1': EventClassification;
    'com.rezics.access.grant.revoke.v1': EventClassification;
    'com.rezics.access.handle-claimed.v1': EventClassification;
    'com.rezics.access.handle-expired.v1': EventClassification;
    'com.rezics.access.handle-held.v1': EventClassification;
    'com.rezics.access.handle-redirected.v1': EventClassification;
    'com.rezics.access.handle-reserved.v1': EventClassification;
    'com.rezics.access.handle-transition-cancelled.v1': EventClassification;
    'com.rezics.access.handle-transition-completed.v1': EventClassification;
    'com.rezics.access.handle-transition-released.v1': EventClassification;
    'com.rezics.access.membership-changed.v1': EventClassification;
    'com.rezics.access.membership-coordination-released.v1': EventClassification;
    'com.rezics.access.membership-inverse-bootstrapped.v1': EventClassification;
    'com.rezics.access.membership-inverse-released.v1': EventClassification;
    'com.rezics.access.membership-inverse-reserved.v1': EventClassification;
    'com.rezics.access.membership-terminalized.v1': EventClassification;
    'com.rezics.access.operator.fence-page.v1': EventClassification;
    'com.rezics.access.operator.management-provisioned.v1': EventClassification;
    'com.rezics.access.operator.opening-authorized.v1': EventClassification;
    'com.rezics.access.operator.opening-consumed.v1': EventClassification;
    'com.rezics.access.operator.relation-recorded.v1': EventClassification;
    'com.rezics.access.operator.responsibility-released.v1': EventClassification;
    'com.rezics.access.operator.responsibility-reserved.v1': EventClassification;
    'com.rezics.access.operator.responsibility-retired.v1': EventClassification;
    'com.rezics.access.operator.subject-fenced.v1': EventClassification;
    'com.rezics.access.operator.subject-unfenced.v1': EventClassification;
    'com.rezics.access.operator.unfence-page.v1': EventClassification;
    'com.rezics.access.organization-close.completed.v1': EventClassification;
    'com.rezics.access.organization-close.page.v1': EventClassification;
    'com.rezics.access.organization-close.release.v1': EventClassification;
    'com.rezics.access.organization-created.v1': EventClassification;
    'com.rezics.access.organization-handle-published.v1': EventClassification;
    'com.rezics.access.rating-counter.changed.v1': EventClassification;
    'com.rezics.access.registration-expired.v1': EventClassification;
    'com.rezics.access.registration-handle-released.v1': EventClassification;
    'com.rezics.access.role-grant.change.v1': EventClassification;
    'com.rezics.access.role-grant.create.v1': EventClassification;
    'com.rezics.access.role-grant.revoke.v1': EventClassification;
    'com.rezics.access.self-read-installed.v1': EventClassification;
    'com.rezics.access.standing-parent.installed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.access.transition-handle-claimed.v1': EventClassification;
    'com.rezics.access.transition-handle-redirected.v1': EventClassification;
    'com.rezics.access.workflow-approvals-swept.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.access.workflow-approved.v1': EventClassification;
    'com.rezics.access.workflow-bound.v1': EventClassification;
    'com.rezics.commerce.entitlement.granted.v1': EventClassification;
    'com.rezics.commerce.entitlement.restored.v1': EventClassification;
    'com.rezics.commerce.entitlement.revoked.v1': EventClassification;
    'com.rezics.commerce.offer.created.v1': EventClassification;
    'com.rezics.commerce.offer.delisted.v1': EventClassification;
    'com.rezics.commerce.offer.revised.v1': EventClassification;
    'com.rezics.commerce.order.created.v1': EventClassification;
    'com.rezics.commerce.order.repair_requested.v1': EventClassification;
    'com.rezics.commerce.order.updated.v1': EventClassification;
    'com.rezics.commerce.payout_statement.paid.v1': EventClassification;
    'com.rezics.commerce.payout_statement.updated.v1': EventClassification;
    'com.rezics.commerce.money.observed.v1': EventClassification;
    'com.rezics.commerce.transactions.recorded.v1': EventClassification;
    'com.rezics.community.publication.adopted.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.publication.rejected.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.publication.withdrawn.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.realm.ban.v1': EventClassification;
    'com.rezics.community.realm.board-scheme.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.realm.created.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.realm.membership.v1': EventClassification;
    'com.rezics.community.realm.membership.requested.v1': EventClassification;
    'com.rezics.community.realm.membership.terminalized.v1': EventClassification;
    'com.rezics.community.realm.unban.v1': EventClassification;
    'com.rezics.community.realm.updated.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.space.address-activated.v1': EventClassification;
    'com.rezics.community.space.address-changed.v1': EventClassification;
    'com.rezics.community.space.address-claim-accepted.v1': EventClassification;
    'com.rezics.community.space.address-claim-pending.v1': EventClassification;
    'com.rezics.community.space.address-reservation-skipped.v1': EventClassification;
    'com.rezics.community.space.address-reserved.v1': EventClassification;
    'com.rezics.community.space.created.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.space.updated.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.space.removed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.space.restored.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.realm.removed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.community.realm.restored.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.content.author-erasure.requested.v1': EventClassification;
    'com.rezics.content.author-item.projected.v1': EventClassification;
    'com.rezics.content.edition.created.v1': EventClassification;
    'com.rezics.content.edition.published.v1': EventClassification;
    'com.rezics.content.edition.unpublished.v1': EventClassification;
    'com.rezics.content.edition.creator-indexed.v1': EventClassification;
    'com.rezics.content.authored-field.created.v1': EventClassification;
    'com.rezics.content.authored-field.erased.v1': EventClassification;
    'com.rezics.content.board-thread.projected.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.content.board.created.v1': EventClassification;
    'com.rezics.content.media.available.v1': EventClassification;
    'com.rezics.content.media.collected.v1': EventClassification;
    'com.rezics.content.media.collection-pending.v1': EventClassification;
    'com.rezics.content.media.erased.v1': EventClassification;
    'com.rezics.content.media.import-requested.v1': EventClassification;
    'com.rezics.content.media.rejected.v1': EventClassification;
    'com.rezics.content.media.reserved.v1': EventClassification;
    'com.rezics.content.media.taken-down.v1': EventClassification;
    'com.rezics.content.media.uploaded.v1': EventClassification;
    'com.rezics.content.moderation.appeal-created.v1': EventClassification;
    'com.rezics.content.moderation.appeal-resolved.v1': EventClassification;
    'com.rezics.content.moderation.erasure.v1': EventClassification;
    'com.rezics.content.moderation.restored.v1': EventClassification;
    'com.rezics.content.moderation.takedown.v1': EventClassification;
    'com.rezics.content.post.created.v1': EventClassification;
    'com.rezics.content.post.erased.v1': EventClassification;
    'com.rezics.content.reaction.changed.v1': EventClassification;
    'com.rezics.content.report-reporter.erased.v1': EventClassification;
    'com.rezics.content.report-reporter.projected.v1': EventClassification;
    'com.rezics.content.catalogue-report.projected.v1': EventClassification;
    'com.rezics.content.report-target.projected.v1': EventClassification;
    'com.rezics.content.report.created.v1': EventClassification;
    'com.rezics.content.report.evidence-erased.v1': EventClassification;
    'com.rezics.content.report.resolved.v1': EventClassification;
    'com.rezics.content.revision.created.v1': EventClassification;
    'com.rezics.content.source_fence.taken_down.v1': EventClassification;
    'com.rezics.content.subject-thread.projected.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.content.thread.created.v1': EventClassification;
    'com.rezics.definitions.activated.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.definitions.published.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.library.bulk.confirmed.v1': EventClassification;
    'com.rezics.library.bulk.changed.v1': EventClassification;
    'com.rezics.library.account-facts.purged.v1': EventClassification;
    'com.rezics.library.collection.deleted.v1': EventClassification;
    'com.rezics.library.collection.listing.changed.v1': EventClassification;
    'com.rezics.library.collection.member.changed.v1': EventClassification;
    'com.rezics.library.collection.updated.v1': EventClassification;
    'com.rezics.library.copy.deleted.v1': EventClassification;
    'com.rezics.library.copy.updated.v1': EventClassification;
    'com.rezics.library.entry.deleted.v1': EventClassification;
    'com.rezics.library.entry.updated.v1': EventClassification;
    'com.rezics.library.follow.updated.v1': EventClassification;
    'com.rezics.library.label.changed.v1': EventClassification;
    'com.rezics.library.label.retention-purged.v1': EventClassification;
    'com.rezics.library.entry.purged.v1': EventClassification;
    'com.rezics.library.progress_session.updated.v1': EventClassification;
    'com.rezics.library.published_log.deleted.v1': EventClassification;
    'com.rezics.library.published_log.updated.v1': EventClassification;
    'com.rezics.library.subject.listed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.presentation.profile.activated.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.presentation.profile.published.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.rating.aggregate.applied.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.rating.eligibility.changed.v1': EventClassification;
    'com.rezics.rating.identity-repair.page.v1': EventClassification;
    'com.rezics.rating.identity-work.changed.v1': EventClassification;
    'com.rezics.rating.population.pending.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.rating.population-total.delivery.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.rating.prior_epoch.work.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.rating.public_figure.changed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.rating.segment.page.v1': EventClassification;
    'com.rezics.rating.source_statistic.changed.v1': EventClassification;
    'com.rezics.rating.subject-merge.page.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.rating.vote.changed.v1': EventClassification;
    'com.rezics.rating.voter-realm.changed.v1': EventClassification;
    'com.rezics.search.identity_writer.changed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.semantic.context.created.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.semantic.record.deleted.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.semantic.record.restored.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.semantic.composite.registered.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.semantic.erasure.scheduled.v1': EventClassification;
    'com.rezics.semantic.erasure.locator-scheduled.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.semantic.erasure.locator-advanced.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.semantic.erasure.progress.v1': EventClassification;
    'com.rezics.semantic.links.changed.v1': EventClassification;
    'com.rezics.semantic.subject_page.dependencies_changed.v1': EventClassification;
    'com.rezics.semantic.links.keys-changed.v1': EventClassification;
    'com.rezics.semantic.links.moving.v1': EventClassification;
    'com.rezics.semantic.links.projected.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.semantic.links.visibility-changed.v1': EventClassification;
    'com.rezics.statement.accepted.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.statement.proposed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.statement.rejected.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.statement.retracted.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.subject.adopted.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.subject.created.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.subject.merged.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.subject.revised.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.subject.statement_disclosed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.subject.statement_visibility_changed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.subject.visibility_changed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'capture.created': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'durable-test.created': EventClassification;
    'durable-test.step': EventClassification;
    'erasure-provenance-test.restored': EventClassification;
    'com.rezics.admission-grant.v1': EventClassification;
    'com.rezics.growth.admission.v1': EventClassification;
    'com.rezics.library.follow.changed.v1': EventClassification;
    'com.rezics.community.realm.banned.v1': EventClassification;
    'com.rezics.community.account-records.erased.v1': EventClassification;
    'com.rezics.community.party-locator.projected.v1': EventClassification;
    'com.rezics.access.time-probe.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.fixture.created.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.fixture.finalize.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.fixture.manifest-growth.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.fixture.manifest.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.fixture.resource-created.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.growth.event.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.growth.media-reservation.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.growth.parent-created.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.growth.payout-seed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.growth.permission-anchor.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.growth.permission-seed.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.growth.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.public-floor.checked.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.search.growth.freshness.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.search.growth.reconcile.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.test.admission-anonymous.v1': EventClassification;
    'com.rezics.test.admission-created.v1': EventClassification;
    'com.rezics.test.admission-delegated.v1': EventClassification;
    'com.rezics.test.admission-growth.v1': EventClassification;
    'com.rezics.test.admission-retry.v1': EventClassification;
    'com.rezics.test.admission-roles.v1': EventClassification;
    'com.rezics.test.admission.v1': EventClassification;
    'com.rezics.test.anonymous-growth-report.v1': EventClassification;
    'com.rezics.test.anonymous-report.v1': EventClassification;
    'com.rezics.test.anonymous.v1': EventClassification;
    'com.rezics.test.anonymous_growth.v1': EventClassification;
    'com.rezics.test.authorized.v1': EventClassification;
    'com.rezics.test.checked.v1': EventClassification;
    'com.rezics.test.cover_claimed.v1': EventClassification;
    'com.rezics.test.growth-resource-authorized.v1': EventClassification;
    'com.rezics.test.happened.v1': EventClassification;
    'com.rezics.test.imported-growth.v1': EventClassification;
    'com.rezics.test.imported.v1': EventClassification;
    'com.rezics.test.left.v1': EventClassification;
    'com.rezics.test.migration.v1': EventClassification;
    'com.rezics.test.principal.v1': EventClassification;
    'com.rezics.test.report.v1': EventClassification;
    'com.rezics.test.resource-authorized.v1': EventClassification;
    'com.rezics.test.updated.v1': EventClassification;
    'com.rezics.zone.configured.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.zone.created.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.zone.deleted.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.zone.published.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
    'com.rezics.zone.restored.v1': Readonly<{
        kind: 'non-personal';
        roles: readonly [];
    }>;
}>;
export declare function classifyEvent(type: string): EventClassification;
export declare function assertEventClassifications(types: Iterable<string>): void;
