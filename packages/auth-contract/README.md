# @rezics/auth-contract

Private ESM shapes, host ports, and browser-response ceilings shared by Auth, Access, and trusted composition. It does not store credentials or execute workflows. Product identity, delegation, consent, and preferences stay in [Accounts, authentication and access](../../docs/accounts.md).

`package.json` exports [`src/index.ts`](./src/index.ts) as the package root. Import from `@rezics/auth-contract`.

## Boundaries

Trusted composition installs the ports. HTTP bodies do not construct `TrustedAccessPorts`, workflow results, kind-consent enrollment, native creation context, or receiving closure.

A locator, parsed projection, work declaration, or `ProvisioningEvidenceReference` is nonsecret. A pure helper match does not authorize an API call or complete a business operation. `CredentialEffectBinding` is Auth's commitment; caller digests only compare.

Absent credential-approval ports fail closed. Absent automated-creation proof methods fail closed. Realm membership `recover`, `finalize`, and `cancel` fail closed when absent. Passkeys require `PasskeyTrustedAccessPorts`. Password and key hosts use `CredentialPurpose`.

`withCredentialRequestDeadline(proof, deadline, work)` stores that request deadline on the proof for `work`, then restores the previous value. `credentialRequestDeadline(proof)` reads it.

## API

**Clients.** `AUTH_PAGE_OPERATION_CLIENT_ID` is `rezics-auth-account-operations` (`organization:create`, `account:delete`). `AUTH_MANAGEMENT_CLIENT_ID` is `rezics-auth-account-management`: `rename` is `account:update`, `membership` is `organization:membership`, and `transfer`, `transfer-acceptance`, and `opening` are `account:manage`. `managementOperationProfile(kind)` returns `{ client_id, scope }`. `isManagementOperation` accepts a closed descriptor: text is 1–4096 UTF-16 units, a rename handle matches `/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/`, opening accounts differ, and membership `role: null` requires `reservationId`. Session results are `ready`, `signed-out`, or `unavailable`. Operation results are `complete`, `refused`, `step-up`, `unknown`, or `unavailable`. Transfer-acceptance `complete` carries `reference` and `expiresAt`. Other `complete` kinds except `opening` carry `accountId`.

**Access.** `SessionProof`, `AccessAccount`, `TrustedAccessPorts`, `CredentialApprovalPorts`, `CredentialEffectVerifier`, `CredentialFloorPort`, `EffectAuthorization`, `BarrierProof` (`consent-reduction` or `recovery`), `AuthSessionPort`, `AuthCredentialPort`, `AuthRecoveryPort`, `BarrierProofPort`, and `ProvisioningEvidencePort`. Session input is `authorization`, `subjectAccountId`, `purpose: 'session'`, and `human`. A credential purpose adds `operationKey`, `effectReference`, and optional `deadline`. The floor advances before mutation for password replacement, `remove-password`, and `remove-key`. Add-key and first-password installation do not advance it.

**Workflows.** `AccountOperation` kinds are `rename`, `organization`, `revoke`, `membership`, `automated`, `transfer`, `delete`, `fence-operator`, `consent`, `client-reduction`, and `opening`. `AccountWorkflowPorts` and `MembershipWorkflowPorts` command methods are typed `Promise<{ value: T }>`. `ReadNativeCreationContext` returns `available`, or `unavailable` with `historical-provenance` or `opening-provenance`.

**Erasure and kind consent.** `AuthErasureProofPorts`, `AuthErasureObligationPorts`, `AuthErasureLivePorts`, and `AuthReceivingClosurePorts` take absolute Unix-millisecond deadlines. Obligation cuts fix `participant: 'auth'`, `inventoryVersion: 1`, `producerVersion: 1`, and `partitions: 4096`. Live `current` means durable Source enrollment: not Auth consumption, restore admission, backup or tail custody, or final erasure. Pages always keep `next` and expose no ACK. `CurrentAuthReceivingClosure` is an unserialized brand. Registration creates a pending native obligation. `readClosure` returns a publication reread from Auth's committed closure, or `null`. Kind consent exports `KindConsentParticipant`, `KindConsentInvalidationReceiver`, and `KindConsentOperation` (`call`, `bound`, `actual`).

## Examples

```ts
import {
  isManagementOperation,
  managementOperationProfile,
  parseAccountOperationRefusal,
} from '@rezics/auth-contract';

managementOperationProfile('membership');
// { client_id: 'rezics-auth-account-management', scope: ['organization:membership'] }

isManagementOperation({
  kind: 'rename',
  accountId: 'account',
  handle: 'new-name',
  expectedHandle: null,
});
// true: closed descriptor check

parseAccountOperationRefusal(
  { error: 'step_up_required', effect_status: 'not_applied' },
  401,
);
// { error: 'step_up_required', effect_status: 'not_applied' }
// The same body with status 403 returns null.
```

`step_up_required` matches 401. `account_operation_denied` matches 400, 401, 403, 409, 413, 415, or 503. Every other body or status returns `null`. That object is the recognized pre-effect refusal.

## Results

Closed readers return `null` on a shape miss: sign-in, passkey enrollment, registration, and account-operation approval and execution.

`parseSignInProof(value, profile, method)` keeps `client_id === profile.client_id`, scope equal to `[...new Set(profile.scope)].sort()`, safe-integer epochs ≥ 0, and `amr: [method]`. `parseSignInOptions` pins `rpId` `rezics.com`, a 43-character base64url challenge, and timeout `60000`. `plugin: true` requires input `userVerification: 'preferred'` and returns `'required'`. `parseSignInError` returns `authentication_denied` for that sole field when status ≠ 200, `rate_limited` for a 429 `{ error }` or sole `{ code }`, and `ACCOUNT_SUSPENDED` for 403 `{ error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' }`.

`parseAccountOperationApprovalResponse` requires a nonempty `reference` ≤ 4096 and `expiresAt` ≤ 27 that round-trips `new Date(expiresAt).toISOString()`. Rename also requires `isAccountOperationReference` (`/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/`). Membership uses `/^[A-Za-z0-9][A-Za-z0-9:_/-]*(?:\.[A-Za-z0-9_-]+)?$/`. `parseAccountOperationApproval` rejects U+0000–U+0020 and U+007F and round-trips `new Date(Date.parse(expiresAt))`.

Execution readers accept only a nonempty `accountId` ≤ 4096. `parseTransferExecution(value, subjectAccountId)` also requires `isOperatorPageId` equal to that subject: 36 lowercase characters, version nibble `7` or `8`, variant `8`, `9`, `a`, or `b`. `parseTransferOperationRefusal` returns `account_operation_denied` for the denial statuses above, `step_up_required` at 401, or `platform_closed` at 403. `TRANSFER_MAX_ERROR_BYTES` also covers `account_operation_unavailable`; the reader does not return it. `parseOrganizationOperationError` adds 503 `{ error: 'unavailable' }` and 403 `platform_closed`. `{ error: 'account_operation_unresolved' }` has no `effect_status`.

`registrationError` is `registration_denied` or `handle_unavailable`; ids are 1–128. Recovery 200 is `{ success: true }`. Recovery 400, 401, 429, and 503 are `{ error: 'authentication_denied' }`. `readOriginalLifecycleResult` returns `null` for an absent, imported, retired, minimized, or mismatched original.

`kindConsentOperationBound`, `kindConsentOperationActual`, the verified and transport bound/actual helpers return a frozen `KindConsentWorkDeclaration` or `undefined` outside the ceilings. `kindConsentEnrollmentResultValid` accepts `{ status: 'unavailable' }`, or `enrolled` scopes that strictly increase and each occur in the request (≤ 512). Identifiers are 1–1024 characters of `\x21-\x7e`. Scopes are ≤ 128 and match `^[\x21\x23-\x5b\x5d-\x7e]+$`. `verify` reads the receiver's own receipt and fence. A declaration does not enroll or finish consent.

`securityJsonStringBytes` and `securityResponseByteBudgets` throw `RangeError` outside a safe integer in range. `selectedLimit` defaults to 20 and is 1–100. `securityScopeLimit()` is 1000 with no catalogue; otherwise the size of `openid`, `offline_access`, `media:complete`, and the supplied actions.

## Bounds

Escaped UTF-16 units cost six UTF-8 bytes. The named exports are the computed ceilings.

- Security `securityResponseLimits`: id 1024, displayName 100, userAgent 512, passkeyName 128, scope 128, date 27, sessions 64, passkeys 32, selectedPage 20. Also `securityFixedResponseByteBudgets`, `securityResponseByteBudgets`, `securityActionResponseByteBudgets`.
- `signInProofBytes`, `signInResponseBytes`, `REGISTRATION_ACK_MAX_BYTES`, `REGISTRATION_ERROR_MAX_BYTES` (31), `recoveryResponseByteBounds`.
- Consent: 1000 scopes, length 128, query 8192, id 1024, name 100, email 254; page, decision, and reduction ceilings.
- `credentialEffectResponseLimits` (`textUnits` 1024), `credentialEffectResponseByteBudgets`, `credentialEffectNotAppliedStatuses`, `passkeyEnrollmentLimits`, `passkeyEnrollmentResponseBytes`. Predicates cover version-4 UUIDs, sealed `payload.hmac` references, and four-digit-year `toISOString` expiry.
- Account operations: reference 4096; automated expiry 24, account id 36, key 128; rename, deletion, membership, organization, and transfer ceilings; `automatedAccountOperationResponseByteBudgets`; `automatedAccountOperationRequestByteBudgets.execute`.
- Operator id 36, version `9223372036854775807`, `isOperatorPageVersion`. Rename id ceiling and 8 actions. `membershipResponseBytes`. Automated creation and organization deletion: id 36, handle 64, display name 4096.
- Kind consent: input 80000, request 90000, response 80000, duration 3000 ms, access token 16384, JWKS request 4096, JWKS response 65536, HTTP control 8192, kernel control 8192, scope octets 66047, statements 11, points 4, witnesses 3, empty seeks 3, native rows 2.
