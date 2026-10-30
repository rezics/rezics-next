import { routeOf } from '../route/route.ts';
import type { CapturedContentEdition, CheckoutDecision } from './model.ts';

export class ContentEditionUnavailableError extends Error {
  constructor() {
    super('content-edition-sale-port-pending');
    this.name = 'ContentEditionUnavailableError';
  }
}

export const MAX_CAPTURED_EDITION_BYTES = 4096;

/** Explicit pending producer state, not a guessed Content callable or injected verifier.
 * Replace this adapter with Content's actual readContentEditionSaleAuthority import
 * when edition-sale.ts and its closed callable declaration are delivered.
 */
export type NativeEditionAuthorityUnavailable = Readonly<{
  kind: 'unavailable';
  reason: 'content-edition-sale-port-pending';
}>;
export function nativeEditionAuthorityAvailability(): NativeEditionAuthorityUnavailable {
  return { kind: 'unavailable', reason: 'content-edition-sale-port-pending' };
}

/** Command bodies call after current Commerce authorization and receipt replay.
 * There is deliberately no success state or caller-provided authority callback.
 */
export async function captureCurrentContentEdition(_editionId: string): Promise<CapturedContentEdition> {
  throw new ContentEditionUnavailableError();
}

/** No reusable stored approval. Until the real producer is bound, fresh sale is unavailable. */
export async function requireCurrentContentEdition(_capture: CapturedContentEdition | null | undefined): Promise<void> {
  throw new ContentEditionUnavailableError();
}

/** Payment truth and revocation still apply when current target authority is missing.
 * A last-verified active entitlement stays active; absent/revoked ones cannot be restored.
 */
export function withoutUnverifiedBenefit(decision: CheckoutDecision): CheckoutDecision {
  if (!decision.changed || (decision.entitlement.kind !== 'grant' && decision.entitlement.kind !== 'restore'))
    return decision;
  return { ...decision, entitlement: { kind: 'none' } };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function id(value: unknown): value is string {
  return typeof value === 'string' && routeOf(value) !== null;
}
/** Validate persisted bytes without inferring identity from subject/title/provider data. */
export function decodeCapturedContentEdition(serialized: string | null): CapturedContentEdition | null {
  if (serialized === null) return null;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CAPTURED_EDITION_BYTES) throw new TypeError('Oversized edition capture');
  const value: unknown = JSON.parse(serialized);
  if (!object(value) || !keys(value, ['benefit', 'creatorAccountId', 'targetSubjectId', 'source', 'saleTermsReference', 'delivery', 'acquisition', 'quantity']))
    throw new TypeError('Invalid edition capture');
  const { benefit, source } = value;
  if (
    !object(benefit) || !keys(benefit, ['kind', 'resourceType', 'resource', 'version', 'action']) ||
    benefit.kind !== 'content-edition' || benefit.resourceType !== 'content.edition' || benefit.action !== 'edition:read' ||
    !object(benefit.resource) || !keys(benefit.resource, ['route', 'id']) || !id(benefit.resource.id) ||
    benefit.resource.route !== routeOf(benefit.resource.id) ||
    !object(benefit.version) || !keys(benefit.version, ['revisionId', 'sha256']) || !id(benefit.version.revisionId) ||
    typeof benefit.version.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(benefit.version.sha256) ||
    !id(value.creatorAccountId) || !id(value.targetSubjectId) ||
    !object(source) || !keys(source, ['threadId', 'postId', 'licence']) || !id(source.threadId) || !id(source.postId) ||
    typeof source.licence !== 'string' || source.licence.length < 1 || source.licence.length > 256 ||
    typeof value.saleTermsReference !== 'string' || value.saleTermsReference.length < 1 || value.saleTermsReference.length > 256 ||
    value.delivery !== 'fixed-content-edition' || value.acquisition !== 'one-time-account-bound' || value.quantity !== 1
  ) throw new TypeError('Invalid edition capture');
  // Construct a fresh bounded value, retaining neither unknown fields nor a revision body.
  return value as CapturedContentEdition;
}
export function encodeCapturedContentEdition(value: CapturedContentEdition | null | undefined): string | null {
  if (value == null) return null;
  const serialized = JSON.stringify(value);
  decodeCapturedContentEdition(serialized);
  return serialized;
}

/** Sale/history terms expose no source thread/post identity or revision body.
 * Content alone discloses its source metadata under current native authority.
 */
export function contentEditionTermsView(value: CapturedContentEdition | null | undefined) {
  if (value == null) return null;
  const { source, ...terms } = value;
  return { ...terms, source: { licence: source.licence } };
}
