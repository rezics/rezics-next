import * as v from 'valibot';
import { hostedId, hostedKey, hostedOwnerViewer } from './hosted-contract';

const target = v.strictObject({
  threadId: hostedId,
  postId: hostedId,
  revisionId: hostedId,
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
});
const scope = { catalogueId: hostedId, target };
const envelope = { expectedViewer: hostedOwnerViewer, idempotencyKey: hostedKey };
/** Private server-function boundary; source admission belongs to the Post operation. */
export const sourceConsentRequest = v.variant('kind', [
  v.strictObject({ ...envelope, kind: v.literal('issue'), body: v.strictObject(scope) }),
  v.strictObject({
    ...envelope,
    kind: v.literal('revoke'),
    body: v.strictObject({ ...scope, disclosureId: hostedId }),
  }),
]);
export const sourceConsentReceipt = v.strictObject({
  disclosureId: hostedId,
  state: v.picklist(['issued', 'revoked']),
  catalogueId: hostedId,
  reused: v.boolean(),
  durableInitiator: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
});
export type SourceConsentRequest = v.InferOutput<typeof sourceConsentRequest>;
export type SourceConsentReceipt = v.InferOutput<typeof sourceConsentReceipt>;
