import * as v from 'valibot';
import type { NativePreferenceFailure } from './preferences';
import type { ManagedAuthNavigation } from './managed-account-vocabulary';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const managedAccountId = v.pipe(v.string(), v.regex(uuidPattern));
const text = v.nullable(v.string());
const identity = v.strictObject({
  id: managedAccountId,
  kind: v.picklist(['actor', 'organization']),
  handle: text,
  displayName: text,
});
const role = v.picklist(['owner', 'member']);
const responsibilityPage = v.strictObject({
  items: v.pipe(
    v.array(
      v.strictObject({
        reservationId: managedAccountId,
        accountId: managedAccountId,
        account: v.nullable(identity),
        state: v.picklist(['current', 'reconciling']),
        navigation: v.optional(v.strictObject({ state: v.picklist(['admitted', 'unavailable', 'concealed']) })),
      }),
    ),
    v.maxLength(20),
  ),
  next: text,
});
// Local validation mirrors services/kernel/src/access/account-management.ts, accountManagementSchema.
export const managementSchema = v.strictObject({
  account: identity,
  self: v.boolean(),
  role: v.nullable(role),
  operator: v.nullable(identity),
  relation: v.nullable(
    v.strictObject({ operatorAccountId: managedAccountId, reservationId: managedAccountId, version: v.string() }),
  ),
  members: v.strictObject({
    state: v.picklist(['ready', 'denied']),
    items: v.pipe(
      v.array(v.strictObject({ accountId: managedAccountId, account: v.nullable(identity), role })),
      v.maxLength(20),
    ),
    next: text,
  }),
  responsibilities: v.nullable(responsibilityPage),
  // Validate this optional dependency separately: a malformed action observation cannot hide read-only detail.
  authActions: v.optional(v.unknown()),
});
export type ManagementDetail = Omit<v.InferOutput<typeof managementSchema>, 'authActions'>;
export type ManagementIdentity = ManagementDetail['account'];
export type DetailSection = 'members' | 'responsibilities';
export type DetailRequest = {
  viewerId: string;
  accountId: string;
  section?: DetailSection | undefined;
  cursor?: string | undefined;
};
export type DetailFailure = NativePreferenceFailure & { transient: boolean };
export type DetailResult =
  | { ok: true; viewerId: string; value: ManagementDetail; authNavigation?: ManagedAuthNavigation }
  | { ok: false; failure: DetailFailure };
export type DetailRead = (input: DetailRequest, signal?: AbortSignal) => Promise<DetailResult>;
