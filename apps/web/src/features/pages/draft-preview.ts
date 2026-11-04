import {
  isView,
  platformRegistry,
  profileDigest,
  resolveView,
  UI_LOCALES,
  validateComposition,
  validateProfile,
  type CompositionDocument,
  type PresentationProfile,
  type TemplateTarget,
  type View,
} from '@rezics/composition';
import { requestLanguages } from '../../kernel/languages';
import { previewInput } from './presentation-preview';
import type { SubjectPageData } from './subject';

export type DraftPreviewTarget =
  | { subject: string; realm?: string; view?: View }
  | { account: string; view?: View }
  | { route: string };
export type DraftPreviewInput = {
  expectedReader: string;
  profile: PresentationProfile;
  target: DraftPreviewTarget;
  locale: string;
};
export type DraftPreviewResult =
  | { ok: true; digest: string; target: DraftPreviewTarget; locale: string; page: SubjectPageData }
  | { ok: false; reason: 'invalid' | 'denied' | 'missing' | 'unavailable' | 'interrupted' }
  | { ok: false; reason: 'redirect'; handle: string };
export type DraftPreviewRead = (input: DraftPreviewInput) => Promise<DraftPreviewResult>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Share the released local target grammar with the review form without asking native admission. */
export function isSupportedDraftPreviewTarget(value: unknown, locale: string): value is DraftPreviewTarget {
  if (!record(value) || !(UI_LOCALES as readonly string[]).includes(locale)) return false;
  const { view, ...address } = value;
  if (view !== undefined && (!isView(view) || 'route' in address)) return false;
  const account =
    Object.keys(address).length === 1 &&
    typeof address.account === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(address.account);
  return account || !!previewInput({ target: address, locale });
}

/** Detach the whole publication candidate before session preparation or any native IO. */
export function captureDraftPreview(value: unknown): DraftPreviewInput | null {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['expectedReader', 'profile', 'target', 'locale'].includes(key)) ||
    typeof value.expectedReader !== 'string' ||
    !uuid.test(value.expectedReader) ||
    typeof value.locale !== 'string' ||
    !(UI_LOCALES as readonly string[]).includes(value.locale) ||
    !record(value.target)
  )
    return null;
  if (!isSupportedDraftPreviewTarget(value.target, value.locale)) return null;
  try {
    if (validateProfile(platformRegistry, value.profile).length) return null;
    return structuredClone(value) as DraftPreviewInput;
  } catch {
    return null;
  }
}

/** Additive mounted input for Content's complete-input publisher; generated declarations remain publisher-owned. */
export interface DraftPreviewClient {
  pages: {
    $previewDraft: {
      post(
        input: { profile: PresentationProfile; target: DraftPreviewTarget; languages: string[] },
        options: { headers: { authorization: string }; fetch: { cache: 'no-store'; redirect: 'manual' } },
      ): Promise<{ status: number; data?: unknown; error?: { value: unknown } | null }>;
    };
  };
}

/** No active-profile read or leaf-success requirement: native failures retain their supported siblings. */
export async function loadDraftPreview(
  client: DraftPreviewClient,
  input: DraftPreviewInput,
  admission: { reader: string | null | undefined; authorization: string | null | undefined },
): Promise<DraftPreviewResult> {
  if (!admission.authorization || admission.reader !== input.expectedReader) return { ok: false, reason: 'denied' };
  const digest = profileDigest(input.profile);
  try {
    const response = await client.pages.$previewDraft.post(
      { profile: input.profile, target: input.target, languages: requestLanguages(input.locale) },
      { headers: { authorization: admission.authorization }, fetch: { cache: 'no-store', redirect: 'manual' } },
    );
    const raw = response.data ?? response.error?.value;
    if (
      response.status === 308 &&
      record(raw) &&
      record(raw.redirect) &&
      typeof raw.redirect.to === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.redirect.to)
    )
      return { ok: false, reason: 'redirect', handle: raw.redirect.to };
    if (response.status !== 200)
      return {
        ok: false,
        reason:
          response.status === 400
            ? 'invalid'
            : response.status === 401 || response.status === 403
              ? 'denied'
              : response.status === 404 || response.status === 410
                ? 'missing'
                : 'unavailable',
      };
    if (
      !record(raw) ||
      raw.profile !== digest ||
      !record(raw.draft) ||
      raw.draft.digest !== digest ||
      raw.draft.advice !== 'allowed' ||
      !record(raw.draft.target) ||
      Object.keys(raw.draft.target).length !== Object.keys(input.target).length ||
      Object.entries(input.target).some(
        ([key, value]) => (raw.draft as { target: Record<string, unknown> }).target[key] !== value,
      ) ||
      !record(raw.template) ||
      !record(raw.reads) ||
      validateComposition(platformRegistry, raw.document).length
    )
      return { ok: false, reason: 'unavailable' };
    const page = { ...raw, subject: raw.subject ?? null } as unknown as SubjectPageData;
    // The draft witness binds the original target. Native identity resolution may select its current survivor.
    if ('subject' in input.target && (typeof page.subject !== 'string' || !uuid.test(page.subject)))
      return { ok: false, reason: 'unavailable' };
    if ('account' in input.target && page.account?.handle !== input.target.account)
      return { ok: false, reason: 'unavailable' };
    if (
      'route' in input.target &&
      (page.subject !== null || page.template.scope !== 'route' || page.template.key !== input.target.route)
    )
      return { ok: false, reason: 'unavailable' };
    const { scope, key } = page.template;
    let witness: TemplateTarget;
    if (scope === 'generic' && key === null) witness = {};
    else if (typeof key === 'string' && ['route', 'type', 'base'].includes(scope))
      witness = scope === 'route' ? { route: key } : scope === 'type' ? { type: key } : { bases: [key] };
    else return { ok: false, reason: 'unavailable' };
    const selected = resolveView(
      input.profile,
      witness,
      'view' in input.target ? (input.target.view ?? 'overview') : 'overview',
    );
    const identity = (document: CompositionDocument) =>
      profileDigest({ ...input.profile, generic: document, bases: [], types: [], routes: [] });
    if (!selected || identity(selected.document) !== identity(page.document as CompositionDocument))
      return { ok: false, reason: 'unavailable' };
    return { ok: true, digest, target: input.target, locale: input.locale, page };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
