import { memoizedValue } from '../memoized.ts';
import type { Pool } from 'pg';
import {
  contentEditionBenefitBinding,
  contentPostBenefitBinding,
  copyContentEditionBenefit,
  copyContentPostBenefit,
} from '../access/authenticated-benefit.ts';
import { AccessUnavailableError, classifyUnavailability } from '../access/unavailable.ts';
import type { ContentEditionSaleAuthority } from '../content/edition-model.ts';
import {
  readContentEditionSaleAuthority,
  readContentEditionMechanicalSaleAuthority,
  type ContentEditionConsentReader,
} from '../content/edition-sale.ts';
import type { ReadContext } from '../content/model.ts';
import type { Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { CapturedContentEdition, CapturedContentPost, CheckoutDecision } from './model.ts';
import type { ContentPostSaleAuthority } from '../content/post-benefit.ts';

export function ContentEditionUnavailableError() {
  return memoizedValue(
    ContentEditionUnavailableError,
    () =>
      class ContentEditionUnavailableError extends AccessUnavailableError {
        constructor(cause?: AccessUnavailableError) {
          super(cause?.reason ?? 'overloaded');
          this.message = 'Content edition sale authority is unavailable';
          this.name = 'ContentEditionUnavailableError';
          this.cause = cause;
        }
      },
  );
}
export type ContentEditionUnavailableError = InstanceType<ReturnType<typeof ContentEditionUnavailableError>>;

export const MAX_CAPTURED_EDITION_BYTES = 4096;
export const MAX_CAPTURED_POST_BYTES = 4096;

/** Compatibility diagnostic for callers with no configured native dependencies.
 * Runtime admission uses the actual Content entrypoints below, never this diagnostic.
 */
export type NativeEditionAuthorityUnavailable = Readonly<{
  kind: 'unavailable';
  reason: 'content-edition-sale-port-pending';
}>;
export function nativeEditionAuthorityAvailability(): NativeEditionAuthorityUnavailable {
  return { kind: 'unavailable', reason: 'content-edition-sale-port-pending' };
}

/** Auth-owned consent is an explicit operand of content sale reads; absent when Auth is unconfigured. */
export type SaleDependencies = Readonly<{
  pool: Pool;
  access: Access;
  clock: () => Date;
  readConsent?: ContentEditionConsentReader;
}>;

/** Translate only the closed native facts; this value is immutable terms, not permission. */
export function captureContentEditionSaleAuthority(
  editionId: string,
  authority: ContentEditionSaleAuthority | null,
): CapturedContentEdition {
  if (!authority) throw new (ContentEditionUnavailableError())();
  try {
    const benefit = copyContentEditionBenefit(authority.benefit);
    if (
      benefit.resource.id !== editionId ||
      authority.source.revisionId !== benefit.version.revisionId ||
      authority.source.sha256 !== benefit.version.sha256 ||
      typeof authority.editionRevision !== 'string' ||
      authority.editionRevision.length === 0
    )
      throw new (ContentEditionUnavailableError())();
    const capture: CapturedContentEdition = {
      benefit,
      creatorAccountId: authority.creatorAccountId,
      targetSubjectId: authority.targetSubjectId,
      source: {
        threadId: authority.source.threadId,
        postId: authority.source.postId,
        licence: authority.licence,
      },
      // The native edition, immutable version and publication revision, never a permission token.
      saleTermsReference: JSON.stringify([
        editionId,
        benefit.version.revisionId,
        benefit.version.sha256,
        authority.editionRevision,
      ]),
      delivery: 'fixed-content-edition',
      acquisition: 'one-time-account-bound',
      quantity: 1,
    };
    encodeCapturedContentEdition(capture);
    return capture;
  } catch (error) {
    if (error instanceof TypeError) throw new (ContentEditionUnavailableError())();
    throw error;
  }
}

/** Capture the stable Post/action promise without retaining a revision selector or body. */
export function captureContentPostSaleAuthority(
  postId: string,
  authority: ContentPostSaleAuthority | null,
  expectedTargetSubjectId?: string,
): CapturedContentPost {
  if (!authority) throw new (ContentEditionUnavailableError())();
  try {
    const benefit = copyContentPostBenefit(authority.benefit);
    if (
      benefit.resource.id !== postId ||
      routeOf(postId) !== benefit.resource.route ||
      (expectedTargetSubjectId !== undefined && authority.targetSubjectId !== expectedTargetSubjectId)
    )
      throw new (ContentEditionUnavailableError())();
    const capture: CapturedContentPost = {
      benefit,
      creatorAccountId: authority.creatorAccountId,
      targetSubjectId: authority.targetSubjectId,
      saleTermsReference: 'content-post-revisions-v1',
      delivery: 'eligible-post-revisions',
      acquisition: 'one-time-account-bound',
      quantity: 1,
    };
    encodeCapturedContentPost(capture);
    return capture;
  } catch (error) {
    if (error instanceof TypeError) throw new (ContentEditionUnavailableError())();
    throw error;
  }
}

/** Compare every immutable field, independently of serialized JSON property order. */
export function sameCapturedContentEdition(
  left: CapturedContentEdition | null | undefined,
  right: CapturedContentEdition | null | undefined,
): boolean {
  if (!left || !right) return false;
  const binding = (value: CapturedContentEdition) => {
    encodeCapturedContentEdition(value);
    return JSON.stringify([
      contentEditionBenefitBinding(value.benefit),
      value.creatorAccountId,
      value.targetSubjectId,
      value.source.threadId,
      value.source.postId,
      value.source.licence,
      value.saleTermsReference,
      value.delivery,
      value.acquisition,
      value.quantity,
    ]);
  };
  return binding(left) === binding(right);
}

export function sameCapturedContentPost(
  left: CapturedContentPost | null | undefined,
  right: CapturedContentPost | null | undefined,
): boolean {
  if (!left || !right) return false;
  const binding = (value: CapturedContentPost) => {
    encodeCapturedContentPost(value);
    return JSON.stringify([
      contentPostBenefitBinding(value.benefit),
      value.creatorAccountId,
      value.targetSubjectId,
      value.saleTermsReference,
      value.delivery,
      value.acquisition,
      value.quantity,
    ]);
  };
  return binding(left) === binding(right);
}

/** Compare the immutable closed target union, including UNKNOWN/null preservation. */
export function sameCapturedContentBenefit(
  left: Readonly<{ contentEdition?: CapturedContentEdition | null; contentPost?: CapturedContentPost | null }>,
  right: Readonly<{ contentEdition?: CapturedContentEdition | null; contentPost?: CapturedContentPost | null }>,
): boolean {
  const sameEdition =
    left.contentEdition == null && right.contentEdition == null
      ? true
      : sameCapturedContentEdition(left.contentEdition, right.contentEdition);
  const samePost =
    left.contentPost == null && right.contentPost == null
      ? true
      : sameCapturedContentPost(left.contentPost, right.contentPost);
  return (
    sameEdition &&
    samePost &&
    (left.contentEdition == null) === (right.contentEdition == null) &&
    (left.contentPost == null) === (right.contentPost == null)
  );
}

/** Exhaustive current offer check for the closed Post/edition target union. */
export async function requireCurrentCapturedContentBenefit(
  capture: Readonly<{
    contentEdition?: CapturedContentEdition | null;
    contentPost?: CapturedContentPost | null;
  }>,
  dependencies: SaleDependencies,
  context: ReadContext,
): Promise<Readonly<{ contentEdition?: CapturedContentEdition; contentPost?: CapturedContentPost }>> {
  if (capture.contentPost && !capture.contentEdition)
    return { contentPost: await requireCurrentContentPost(capture.contentPost, dependencies, context) };
  if (capture.contentEdition && !capture.contentPost)
    return { contentEdition: await requireCurrentContentEdition(capture.contentEdition, dependencies, context) };
  throw new (ContentEditionUnavailableError())();
}

/** Settlement revalidates only native source availability; Access still guards every actual read. */
export async function requireMechanicalCapturedContentBenefit(
  capture: Readonly<{
    contentEdition?: CapturedContentEdition | null;
    contentPost?: CapturedContentPost | null;
  }>,
  dependencies: SaleDependencies,
  context: Readonly<{ deadline: number }>,
): Promise<Readonly<{ contentEdition?: CapturedContentEdition; contentPost?: CapturedContentPost }>> {
  if (capture.contentPost && !capture.contentEdition)
    return { contentPost: await requireMechanicalContentPost(capture.contentPost, dependencies, context) };
  if (capture.contentEdition && !capture.contentPost)
    return {
      contentEdition: await requireMechanicalContentEdition(capture.contentEdition, dependencies, context),
    };
  throw new (ContentEditionUnavailableError())();
}

export function isContentEditionUnavailable(error: unknown): boolean {
  return error instanceof ContentEditionUnavailableError() || classifyUnavailability(error) !== undefined;
}

/** Called on released command preparation, with the actual request Actor. */
export async function captureCurrentContentEdition(
  editionId: string,
  dependencies?: SaleDependencies,
  context?: ReadContext,
): Promise<CapturedContentEdition> {
  if (!dependencies || !context || routeOf(editionId) === null) throw new (ContentEditionUnavailableError())();
  try {
    return captureContentEditionSaleAuthority(
      editionId,
      await readContentEditionSaleAuthority(dependencies, editionId, context),
    );
  } catch (error) {
    if (error instanceof AccessUnavailableError) throw new (ContentEditionUnavailableError())(error);
    throw error;
  }
}

export async function captureCurrentContentPost(
  postId: string,
  dependencies?: SaleDependencies,
  context?: ReadContext,
  targetSubjectId?: string,
): Promise<CapturedContentPost> {
  if (!dependencies || !context || routeOf(postId) === null) throw new (ContentEditionUnavailableError())();
  try {
    const { readContentPostSaleAuthority } = await import('../content/post-benefit.ts');
    return captureContentPostSaleAuthority(
      postId,
      await readContentPostSaleAuthority(dependencies, postId, context, targetSubjectId),
      targetSubjectId,
    );
  } catch (error) {
    if (error instanceof AccessUnavailableError) throw new (ContentEditionUnavailableError())(error);
    throw error;
  }
}

export async function requireCurrentContentEdition(
  capture: CapturedContentEdition | null | undefined,
  dependencies?: SaleDependencies,
  context?: ReadContext,
): Promise<CapturedContentEdition> {
  if (!capture) throw new (ContentEditionUnavailableError())();
  const current = await captureCurrentContentEdition(capture.benefit.resource.id, dependencies, context);
  if (!sameCapturedContentEdition(capture, current)) throw new (ContentEditionUnavailableError())();
  return current;
}

export async function requireCurrentContentPost(
  capture: CapturedContentPost | null | undefined,
  dependencies?: SaleDependencies,
  context?: ReadContext,
): Promise<CapturedContentPost> {
  if (!capture) throw new (ContentEditionUnavailableError())();
  const current = await captureCurrentContentPost(
    capture.benefit.resource.id,
    dependencies,
    context,
    capture.targetSubjectId,
  );
  if (!sameCapturedContentPost(capture, current)) throw new (ContentEditionUnavailableError())();
  return current;
}

/** Trusted workflow reads have native buyer admission, never a fabricated buyer Actor. */
export async function requireMechanicalContentEdition(
  capture: CapturedContentEdition | null | undefined,
  dependencies: SaleDependencies,
  context: Readonly<{ deadline: number }>,
): Promise<CapturedContentEdition> {
  if (!capture) throw new (ContentEditionUnavailableError())();
  const editionId = capture.benefit.resource.id;
  let current: CapturedContentEdition;
  try {
    current = captureContentEditionSaleAuthority(
      editionId,
      await readContentEditionMechanicalSaleAuthority(dependencies, editionId, context),
    );
  } catch (error) {
    if (error instanceof AccessUnavailableError) throw new (ContentEditionUnavailableError())(error);
    throw error;
  }
  if (!sameCapturedContentEdition(capture, current)) throw new (ContentEditionUnavailableError())();
  return current;
}

export async function requireMechanicalContentPost(
  capture: CapturedContentPost | null | undefined,
  dependencies: SaleDependencies,
  context: Readonly<{ deadline: number }>,
): Promise<CapturedContentPost> {
  if (!capture) throw new (ContentEditionUnavailableError())();
  let current: CapturedContentPost;
  try {
    const { readContentPostMechanicalSaleAuthority } = await import('../content/post-benefit.ts');
    current = captureContentPostSaleAuthority(
      capture.benefit.resource.id,
      await readContentPostMechanicalSaleAuthority(
        dependencies,
        capture.benefit.resource.id,
        capture.targetSubjectId,
        context,
      ),
      capture.targetSubjectId,
    );
  } catch (error) {
    if (error instanceof AccessUnavailableError) throw new (ContentEditionUnavailableError())(error);
    throw error;
  }
  if (!sameCapturedContentPost(capture, current)) throw new (ContentEditionUnavailableError())();
  return current;
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
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CAPTURED_EDITION_BYTES)
    throw new TypeError('Oversized edition capture');
  const value: unknown = JSON.parse(serialized);
  if (
    !object(value) ||
    !keys(value, [
      'benefit',
      'creatorAccountId',
      'targetSubjectId',
      'source',
      'saleTermsReference',
      'delivery',
      'acquisition',
      'quantity',
    ])
  )
    throw new TypeError('Invalid edition capture');
  const { benefit, source } = value;
  if (
    !object(benefit) ||
    !keys(benefit, ['kind', 'resourceType', 'resource', 'version', 'action']) ||
    benefit.kind !== 'content-edition' ||
    benefit.resourceType !== 'content.edition' ||
    benefit.action !== 'edition:read' ||
    !object(benefit.resource) ||
    !keys(benefit.resource, ['route', 'id']) ||
    !id(benefit.resource.id) ||
    benefit.resource.route !== routeOf(benefit.resource.id) ||
    !object(benefit.version) ||
    !keys(benefit.version, ['revisionId', 'sha256']) ||
    !id(benefit.version.revisionId) ||
    typeof benefit.version.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(benefit.version.sha256) ||
    !id(value.creatorAccountId) ||
    !id(value.targetSubjectId) ||
    !object(source) ||
    !keys(source, ['threadId', 'postId', 'licence']) ||
    !id(source.threadId) ||
    !id(source.postId) ||
    typeof source.licence !== 'string' ||
    source.licence.length < 1 ||
    source.licence.length > 256 ||
    typeof value.saleTermsReference !== 'string' ||
    value.saleTermsReference.length < 1 ||
    value.saleTermsReference.length > 256 ||
    value.delivery !== 'fixed-content-edition' ||
    value.acquisition !== 'one-time-account-bound' ||
    value.quantity !== 1
  )
    throw new TypeError('Invalid edition capture');
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

/** Post terms expose the stable Post selector and the all-eligible-revisions promise only. */
export function contentPostTermsView(value: CapturedContentPost | null | undefined) {
  return value == null ? null : { ...value };
}

/** Validate persisted Post terms without deriving identity from subject/title/provider data. */
export function decodeCapturedContentPost(serialized: string | null): CapturedContentPost | null {
  if (serialized === null) return null;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CAPTURED_POST_BYTES) throw new TypeError('Oversized Post capture');
  const value: unknown = JSON.parse(serialized);
  if (
    !object(value) ||
    !keys(value, [
      'benefit',
      'creatorAccountId',
      'targetSubjectId',
      'saleTermsReference',
      'delivery',
      'acquisition',
      'quantity',
    ])
  )
    throw new TypeError('Invalid Post capture');
  const { benefit } = value;
  if (
    !object(benefit) ||
    !keys(benefit, ['kind', 'resourceType', 'resource', 'action']) ||
    benefit.kind !== 'content-post' ||
    benefit.resourceType !== 'content.post' ||
    benefit.action !== 'post:read' ||
    !object(benefit.resource) ||
    !keys(benefit.resource, ['route', 'id']) ||
    !id(benefit.resource.id) ||
    benefit.resource.route !== routeOf(benefit.resource.id) ||
    !id(value.creatorAccountId) ||
    !id(value.targetSubjectId) ||
    value.saleTermsReference !== 'content-post-revisions-v1' ||
    value.delivery !== 'eligible-post-revisions' ||
    value.acquisition !== 'one-time-account-bound' ||
    value.quantity !== 1
  )
    throw new TypeError('Invalid Post capture');
  return value as CapturedContentPost;
}

export function encodeCapturedContentPost(value: CapturedContentPost | null | undefined): string | null {
  if (value == null) return null;
  const serialized = JSON.stringify(value);
  decodeCapturedContentPost(serialized);
  return serialized;
}
