import { createKernelClient, SESSION_HEADER, type KernelClient, type SubjectRead } from '@rezics/client';
import {
  PROFILE_FORMAT,
  PROFILE_ROUTE_MAX_LENGTH,
  PROFILE_ROUTE_PATTERN,
  UI_LOCALES,
  planReads,
  platformRegistry,
  profileDigest,
  resolveTemplate,
  validateComposition,
  validateProfile,
  type CompositionDocument,
  type PresentationProfile,
  type TemplateTarget,
} from '@rezics/composition';
import { requestLanguages } from '../../kernel/languages';
import { admitActiveMetadata } from './curation-read-response';
import type { SubjectPageData } from './subject';

export type PresentationPreviewInput = {
  target: { subject: string; realm?: string } | { route: string };
  locale: string;
};
export type PresentationPreview =
  | {
      ok: true;
      target: PresentationPreviewInput['target'];
      locale: string;
      /** Observed separately; pages.read pins a digest, not an activation head. */
      head: number;
      page: SubjectPageData;
    }
  | { ok: false; reason: 'invalid' | 'denied' | 'missing' | 'unavailable' | 'changed' }
  | { ok: false; reason: 'redirect'; handle: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const route = new RegExp(PROFILE_ROUTE_PATTERN, 'u');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Closed address only: never accept an editor document, descriptors or a caller credential mode. */
export function previewInput(value: unknown): PresentationPreviewInput | null {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== 'target' && key !== 'locale') ||
    typeof value.locale !== 'string' ||
    !(UI_LOCALES as readonly string[]).includes(value.locale) ||
    !record(value.target)
  )
    return null;
  const target = value.target;
  if (
    Object.keys(target).every((key) => key === 'subject' || key === 'realm') &&
    typeof target.subject === 'string' &&
    uuid.test(target.subject) &&
    (target.realm === undefined || (typeof target.realm === 'string' && uuid.test(target.realm)))
  )
    return {
      target: { subject: target.subject, ...(target.realm ? { realm: target.realm as string } : {}) },
      locale: value.locale,
    };
  if (
    Object.keys(target).length === 1 &&
    typeof target.route === 'string' &&
    target.route.length <= PROFILE_ROUTE_MAX_LENGTH &&
    route.test(target.route)
  )
    return { target: { route: target.route }, locale: value.locale };
  return null;
}

/** Strip credentials at the actual transport boundary, including any token remembered by Eden. */
export function anonymousPreviewFetch(fetcher: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    headers.delete(SESSION_HEADER);
    return fetcher(new Request(request, { headers, credentials: 'omit', cache: 'no-store', redirect: 'manual' }));
  }) as typeof fetch;
}

/** One fresh anonymous client per inspection; no viewer or public-page query cache is shared. */
export function presentationPreviewClient(origin: string, fetcher: typeof fetch): KernelClient {
  return createKernelClient(origin, { fetch: anonymousPreviewFetch(fetcher) });
}

function failure(status: number): PresentationPreview {
  return {
    ok: false,
    reason: status === 401 || status === 403 ? 'denied' : status === 404 || status === 410 ? 'missing' : 'unavailable',
  };
}

function documentIdentity(document: CompositionDocument): string {
  // Reuse the package's canonical JSON hashing, solely to compare the two documents.
  return profileDigest({ format: PROFILE_FORMAT, generic: document, bases: [], types: [], routes: [] });
}

/**
 * The native response owns the choice. Use its selection as a witness into the matching immutable profile.
 * In particular, a base witness is NOT a guessed type hierarchy or a claim about other candidate bases.
 */
export function matchesPinnedTemplate(profile: PresentationProfile, page: SubjectPageData): boolean {
  let witness: TemplateTarget;
  const { scope, key } = page.template;
  if (scope === 'generic') {
    if (key !== null) return false;
    witness = {};
  } else {
    if (typeof key !== 'string') return false;
    witness = scope === 'route' ? { route: key } : scope === 'type' ? { type: key } : { bases: [key] };
  }
  const selected = resolveTemplate(profile, witness);
  return (
    selected.scope === scope &&
    selected.key === key &&
    documentIdentity(selected.document) === documentIdentity(page.document as CompositionDocument)
  );
}

/** One native current aggregate, plus two fixed presentation control reads. Never read a draft or a source row. */
export async function loadPresentationPreview(client: KernelClient, value: unknown): Promise<PresentationPreview> {
  const input = previewInput(value);
  if (!input) return { ok: false, reason: 'invalid' };
  try {
    const response = await client.pages.$read.post(
      { target: input.target, languages: requestLanguages(input.locale) },
      { fetch: { redirect: 'manual', credentials: 'omit', cache: 'no-store' } },
    );
    if (response.status === 308) {
      const body: unknown = response.data ?? response.error?.value;
      return record(body) &&
        record(body.redirect) &&
        typeof body.redirect.to === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.redirect.to)
        ? { ok: false, reason: 'redirect', handle: body.redirect.to }
        : { ok: false, reason: 'unavailable' };
    }
    if (response.status !== 200 || !response.data) return failure(response.status);
    const raw = response.data;
    if (
      !digest.test(raw.profile) ||
      raw.account !== undefined ||
      validateComposition(platformRegistry, raw.document).length > 0
    )
      return { ok: false, reason: 'unavailable' };
    const { account: _account, ...native } = raw;
    const page: SubjectPageData = { ...native, subject: native.subject ?? null };
    // Bind the aggregate to the requested address before planning reads or consulting presentation controls.
    // A self-consistent subject body alone cannot establish which subject was requested.
    if ('subject' in input.target) {
      if (page.subject !== input.target.subject) return { ok: false, reason: 'unavailable' };
      // Context identity authorizes reads; population identity binds the requested Realm.
      const population = page.context?.population;
      if (
        input.target.realm !== undefined &&
        (population?.kind !== 'realm' || population.id !== input.target.realm)
      )
        return { ok: false, reason: 'unavailable' };
    } else if (page.subject !== null) {
      return { ok: false, reason: 'unavailable' };
    }
    const plan = planReads(platformRegistry, page.document as CompositionDocument, {
      subject: page.subject,
      ...(page.context ? { context: page.context } : {}),
    });
    for (const key of Object.keys(plan.reads)) {
      const read = page.reads[key];
      // A failed leaf cannot turn into a successful static shell in this inspection.
      if (!read || read.status !== 200) return failure(read?.status ?? 503);
    }
    if ('subject' in input.target) {
      const requestedSubject = input.target.subject;
      const entry = Object.entries(plan.reads).find(
        ([, read]) => read.kind === 'subject' && read.id === requestedSubject,
      );
      // Native pages.read already probes the target even when its configured template needs no subject body.
      if (entry) {
        const body: unknown = page.reads[entry[0]]?.body;
        if (!record(body) || !record(body.subject) || body.subject.id !== requestedSubject || !record(body.related))
          return { ok: false, reason: 'unavailable' };
        // Preserve the native body (including original/terminal source selection and metadata) unchanged.
        const subject = body.subject as SubjectRead['subject'];
        if (page.template.scope === 'type' && page.template.key !== subject.type)
          return { ok: false, reason: 'unavailable' };
      }
    }
    const [pinned, active] = await Promise.all([
      client.presentation.profiles({ digest: page.profile }).get({ fetch: { cache: 'no-store' } }),
      client.presentation.active.get({ fetch: { cache: 'no-store' } }),
    ]);
    if (pinned.status !== 200 || !pinned.data) return failure(pinned.status);
    if (active.status !== 200 || !active.data) return failure(active.status);
    const activeMetadata = admitActiveMetadata(active.data);
    if (!activeMetadata) return { ok: false, reason: 'unavailable' };
    if (activeMetadata.digest !== page.profile) return { ok: false, reason: 'changed' };
    if (pinned.data.digest !== page.profile || validateProfile(platformRegistry, pinned.data.profile).length > 0)
      return { ok: false, reason: 'unavailable' };
    const profile = pinned.data.profile as PresentationProfile;
    if (profileDigest(profile) !== page.profile || !matchesPinnedTemplate(profile, page))
      return { ok: false, reason: 'unavailable' };
    // Native route reads allow generic fallback. An unknown route is not an inspectable supported page here.
    if ('route' in input.target) {
      const route = input.target.route;
      if (
        !profile.routes.some((entry) => entry.route === route) ||
        page.template.scope !== 'route' ||
        page.template.key !== route
      )
        return { ok: false, reason: 'missing' };
    }
    return { ok: true, target: input.target, locale: input.locale, head: activeMetadata.head, page };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
