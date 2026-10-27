import { Type } from 'typebox';
import governance from './platform-governance.json';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const identity = Type.String({ pattern: `^${uuid}$`, minLength: 36, maxLength: 36 });
const resource = Type.Object(
  { route: Type.Integer({ minimum: 0, maximum: 65535 }), id: identity },
  { additionalProperties: false },
);
const subject = Type.Union([
  Type.Object({ kind: Type.Literal('active_accounts') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('account'), id: identity }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('organization'),
      id: identity,
      role: Type.Union([Type.Literal('owner'), Type.Literal('member')]),
    },
    { additionalProperties: false },
  ),
]);
const action = Type.String({ pattern: '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$(?![\\s\\S])' });
const handle = Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$', minLength: 1, maxLength: 64 });
const iso = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
  minLength: 24,
  maxLength: 24,
});
const text = Type.String({ minLength: 1, maxLength: 256 });
const epoch = Type.String({ pattern: '^[1-9][0-9]{0,18}$', maxLength: 19 });
const digest = Type.String({ pattern: '^[0-9a-f]{64}$', minLength: 64, maxLength: 64 });
const version = Type.String({ pattern: '^(0|[1-9][0-9]{0,18})$', minLength: 1, maxLength: 19 });
const principal = Type.Object(
  { kind: Type.Union([Type.Literal('organization'), Type.Literal('realm')]), id: identity },
  { additionalProperties: false },
);
const grantFields = {
  resource,
  actions: Type.Array(action, { minItems: 1 }),
  // Commands return the supplied PostgreSQL range text, not a normalized timestamp.
  valid: Type.String(),
};
const grant = Type.Union([
  Type.Object({ ...grantFields, subject }, { additionalProperties: false }),
  Type.Object(
    {
      ...grantFields,
      subjectId: identity,
      subjectRole: Type.Union([Type.Literal(''), Type.Literal('owner'), Type.Literal('member')]),
    },
    { additionalProperties: false },
  ),
]);
const roleGrant = Type.Object(
  { resource, subject, role: Type.String({ pattern: '^[a-z][a-z0-9_.-]*$(?![\\s\\S])' }), valid: Type.String() },
  { additionalProperties: false },
);
const assignment = Type.Object(
  { requestedBy: Type.String({ pattern: `^urn:rezics:request:${uuid}:${uuid}$`, minLength: 92, maxLength: 92 }) },
  { additionalProperties: false },
);
const operatorIds = { operatorAccountId: identity, subjectAccountId: identity, reservationId: identity };
const fenceReceipt = (kind: 'fence' | 'tombstone', prior: 'null' | 'optional') =>
  Type.Object(
    {
      receiptId: identity,
      accountId: identity,
      minimumAuthnEpoch: epoch,
      kind: Type.Literal(kind),
      priorOperatorAccountId: prior === 'null' ? Type.Null() : Type.Union([identity, Type.Null()]),
    },
    { additionalProperties: false },
  );
const membershipHold = { accountId: identity, principal, reservationId: identity };
const reservedHandleException = Type.Optional(Type.Literal(true));
const handlePublication = { accountId: identity, handle, operationId: text, reservedHandleException };
const opening = Type.Object(
  {
    ...operatorIds,
    version,
    receiptId: identity,
    actingHumanId: identity,
    purpose: Type.Union([Type.Literal('session'), Type.Literal('credential-management')]),
    clientId: text,
    scopes: Type.Array(Type.String({ minLength: 1, maxLength: 128 })),
    requestedBy: Type.Union([text, Type.Null()]),
    expiresAt: iso,
  },
  { additionalProperties: false },
);

const exposure = (open: boolean) =>
  Type.Object(
    {
      group: Type.String({ pattern: '^(?!any$|open$|close$)[a-z][a-z_-]{0,62}$(?![\\s\\S])' }),
      open: Type.Literal(open),
      changed: Type.Boolean(),
    },
    { additionalProperties: false },
  );

/** Exact public command return values; command keys, credentials and opening context stay private. */
export const ACCESS_EVENTS = {
  'com.rezics.access.organization-close.page.v1': Type.Object(
    {
      count: Type.Integer({ minimum: 0, maximum: 100 }),
      members: Type.Array(identity, { maxItems: 100 }),
      handle: Type.Union([handle, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.organization-close.release.v1': Type.Object(
    { accountId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.organization-close.completed.v1': Type.Object(
    { accountId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.rating-counter.changed.v1': Type.Object(
    {
      accountId: identity,
      // Preserve the transaction's PostgreSQL T, including microseconds.
      at: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?[+-]\\d{2}$' }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.exposure.opened.v1': exposure(true),
  'com.rezics.access.exposure.closed.v1': exposure(false),
  'com.rezics.access.operator.fence-page.v1': Type.Object(
    { pageKey: digest, count: Type.Integer({ minimum: 0, maximum: 100 }) },
    { additionalProperties: false },
  ),
  'com.rezics.access.operator.unfence-page.v1': Type.Object(
    { pageKey: digest, count: Type.Integer({ minimum: 0, maximum: 100 }) },
    { additionalProperties: false },
  ),
  'com.rezics.access.operator.subject-unfenced.v1': Type.Object(
    { accountId: identity, lifted: Type.Boolean() },
    { additionalProperties: false },
  ),
  'com.rezics.access.operator.subject-fenced.v1': Type.Object(
    { accountId: identity, fenced: Type.Boolean(), receiptId: Type.Union([identity, Type.Null()]) },
    { additionalProperties: false },
  ),
  'com.rezics.access.account.suspended.v1': Type.Object(
    {
      accountId: identity,
      state: Type.Literal('suspended'),
      continuationOperationKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      minimumAuthnEpoch: Type.String({ pattern: '^[1-9][0-9]{0,18}$', maxLength: 19 }),
      receiptId: identity,
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.account.reinstated.v1': Type.Object(
    {
      accountId: identity,
      state: Type.Literal('active'),
      continuationOperationKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      minimumAuthnEpoch: Type.String({ pattern: '^[1-9][0-9]{0,18}$', maxLength: 19 }),
      receiptId: identity,
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.account.rate-tier-set.v1': Type.Object(
    {
      accountId: identity,
      tier: Type.Union([Type.Literal('ordinary'), Type.Literal('trusted'), Type.Literal('service')]),
      receiptId: identity,
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.grant.create.v1': grant,
  'com.rezics.access.grant.change.v1': grant,
  'com.rezics.access.grant.revoke.v1': grant,
  'com.rezics.access.role-grant.create.v1': roleGrant,
  'com.rezics.access.role-grant.change.v1': roleGrant,
  'com.rezics.access.role-grant.revoke.v1': roleGrant,
  'com.rezics.access.assignment.create.v1': assignment,
  'com.rezics.access.assignment.revoke.v1': assignment,
  'com.rezics.access.governance.bootstrapped.v1': Type.Object(
    {
      accountId: Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }),
      resource: Type.Object(
        { route: Type.Literal(0), id: Type.Literal('00000000-0000-8000-8000-000000000000') },
        { additionalProperties: false },
      ),
      role: Type.Literal(governance.role),
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.handle-held.v1': Type.Object(
    { accountId: identity, handle, reservationId: identity, operationId: text },
    { additionalProperties: false },
  ),
  'com.rezics.access.organization-handle-published.v1': Type.Object(handlePublication, {
    additionalProperties: false,
  }),
  'com.rezics.access.account-handle-published.v1': Type.Object(handlePublication, { additionalProperties: false }),
  'com.rezics.access.transition-handle-claimed.v1': Type.Object(
    { accountId: identity, handle },
    { additionalProperties: false },
  ),
  'com.rezics.access.transition-handle-redirected.v1': Type.Object(
    { accountId: identity, handle, reservedUntil: iso },
    { additionalProperties: false },
  ),
  'com.rezics.access.handle-transition-completed.v1': Type.Object(
    { accountId: identity, handle },
    { additionalProperties: false },
  ),
  'com.rezics.access.handle-transition-cancelled.v1': Type.Object(
    { accountId: identity, operationId: text },
    { additionalProperties: false },
  ),
  'com.rezics.access.handle-transition-released.v1': Type.Object(
    { accountId: identity, handle },
    { additionalProperties: false },
  ),
  'com.rezics.access.registration-expired.v1': fenceReceipt('tombstone', 'optional'),
  'com.rezics.access.registration-handle-released.v1': Type.Object(
    { accountId: identity, handle },
    { additionalProperties: false },
  ),
  'com.rezics.access.handle-reserved.v1': Type.Object(
    { handle, accountId: identity, reservationId: identity, expiresAt: iso, reservedHandleException },
    { additionalProperties: false },
  ),
  'com.rezics.access.actor-pending.v1': Type.Object(
    { accountId: identity, registrationId: identity, expiresAt: iso },
    { additionalProperties: false },
  ),
  'com.rezics.access.actor-activated.v1': Type.Object({ accountId: identity }, { additionalProperties: false }),
  'com.rezics.access.self-read-installed.v1': Type.Object(
    { accountId: identity, installed: Type.Integer({ minimum: 0 }) },
    { additionalProperties: false },
  ),
  'com.rezics.access.handle-claimed.v1': Type.Object(
    { handle, accountId: identity, reservedHandleException },
    { additionalProperties: false },
  ),
  'com.rezics.access.handle-redirected.v1': Type.Object(
    { handle, accountId: identity, reservedUntil: iso },
    { additionalProperties: false },
  ),
  'com.rezics.access.handle-expired.v1': Type.Object(
    { handle, released: Type.Literal(true) },
    { additionalProperties: false },
  ),
  'com.rezics.access.coordination-reserved.v1': Type.Object(
    { accountId: identity, relatedAccountId: identity, purpose: Type.Literal('operator'), reservationId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.membership-terminalized.v1': Type.Object(
    {
      organizationId: identity,
      memberAccountId: identity,
      reservationId: identity,
      key: text,
      transactionId: identity,
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.organization-created.v1': Type.Object(
    { accountId: identity, ownerAccountId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.authentication-floor-advanced.v1': fenceReceipt('fence', 'null'),
  'com.rezics.access.authentication-fenced.v1': fenceReceipt('fence', 'null'),
  'com.rezics.access.authentication-established.v1': Type.Object(
    { accountId: identity, receiptId: identity, minimumAuthnEpoch: epoch },
    { additionalProperties: false },
  ),
  'com.rezics.access.account-updated.v1': Type.Object({ accountId: identity }, { additionalProperties: false }),
  'com.rezics.access.account-display-name-changed.v1': Type.Object(
    { accountId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.agent-verification.requested.v1': Type.Object(
    { requestId: identity, accountId: identity, catalogueSubjectId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.agent-verification.withdrawn.v1': Type.Object(
    { requestId: identity, accountId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.agent-verification.approved.v1': Type.Object(
    { requestId: identity, accountId: identity, catalogueSubjectId: identity, receiptId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.agent-verification.rejected.v1': Type.Object(
    { requestId: identity, accountId: identity, catalogueSubjectId: identity, receiptId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.agent-verification.failed.v1': Type.Object(
    {
      requestId: identity,
      accountId: identity,
      catalogueSubjectId: identity,
      receiptId: identity,
      problemType: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.agent-verification.verified.v1': Type.Object(
    { requestId: identity, accountId: identity, catalogueSubjectId: identity, receiptId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.membership-changed.v1': Type.Object(
    {
      organizationId: identity,
      memberAccountId: identity,
      reservationId: identity,
      role: Type.Union([Type.Literal('owner'), Type.Literal('member'), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.account-tombstoned.v1': fenceReceipt('tombstone', 'optional'),
  'com.rezics.access.membership-inverse-reserved.v1': Type.Object(membershipHold, { additionalProperties: false }),
  'com.rezics.access.membership-inverse-bootstrapped.v1': Type.Object(
    { ...membershipHold, sourceTransactionId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.membership-inverse-released.v1': Type.Object(
    { ...membershipHold, proofTransactionId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.membership-coordination-released.v1': Type.Object(
    {
      ...membershipHold,
      proofTransactionId: identity,
      organizationId: identity,
      memberAccountId: identity,
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.operator.management-provisioned.v1': Type.Object(
    {
      operatorAccountId: identity,
      action: Type.String({ pattern: '^(account|access):[a-z][a-z0-9_-]*$(?![\\s\\S])' }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.access.operator.responsibility-reserved.v1': Type.Object(operatorIds, { additionalProperties: false }),
  'com.rezics.access.operator.relation-recorded.v1': Type.Object(
    { subjectAccountId: identity, operatorAccountId: identity, reservationId: identity, version },
    { additionalProperties: false },
  ),
  'com.rezics.access.operator.responsibility-retired.v1': Type.Object(operatorIds, { additionalProperties: false }),
  'com.rezics.access.operator.responsibility-released.v1': Type.Object(operatorIds, { additionalProperties: false }),
  'com.rezics.access.operator.opening-authorized.v1': opening,
  'com.rezics.access.operator.opening-consumed.v1': opening,
  'com.rezics.access.workflow-bound.v1': Type.Object({ digest }, { additionalProperties: false }),
  'com.rezics.access.workflow-approved.v1': Type.Object(
    { approvalId: identity, digest },
    { additionalProperties: false },
  ),
  'com.rezics.access.credential-approved-consumed.v1': Type.Object(
    { approvalId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.workflow-approvals-swept.v1': Type.Object(
    { route: Type.Integer({ minimum: 0, maximum: 65535 }), count: Type.Integer({ minimum: 0, maximum: 1000 }) },
    { additionalProperties: false },
  ),
  'com.rezics.access.credential-floor-advanced.v1': Type.Object(
    { openingReceiptId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.standing-parent.installed.v1': Type.Object(
    { resource, actions: Type.Array(action, { minItems: 1 }) },
    { additionalProperties: false },
  ),
  'com.rezics.access.cleanup-continuation.recorded.v1': Type.Object(
    { continuationId: identity, receiptId: identity },
    { additionalProperties: false },
  ),
  'com.rezics.access.cleanup-continuation.renewed.v1': Type.Object(
    { continuationId: identity, expiresAt: iso, receiptId: identity },
    { additionalProperties: false },
  ),
} as const;
