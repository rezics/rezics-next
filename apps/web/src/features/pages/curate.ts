import type { KernelClient } from '@rezics/client';
import {
  templateViews,
  type CompositionDocument,
  type PresentationProfile,
  type TemplateBody,
} from '@rezics/composition';

export type Template = { scope: 'generic'; key: null } | { scope: 'base' | 'type' | 'route'; key: string };
export type CurationFailure =
  | { ok: false; reason: 'stale' | 'forbidden' | 'unavailable' }
  | { ok: false; reason: 'invalid'; errors: { pointer: string; code: string }[] }
  | { ok: false; reason: 'rate-limited'; retryAfter?: number };
export type PublishInput = {
  profile: PresentationProfile;
  expectedHead: number;
  keys: { publish: string; activate: string };
};
export type PublishResult = { ok: true; digest: string; head: number } | CurationFailure;

export function profileTemplates(profile: PresentationProfile): Template[] {
  return [
    { scope: 'generic', key: null },
    ...profile.bases.map(({ base }) => ({ scope: 'base' as const, key: base })),
    ...profile.types.map(({ type }) => ({ scope: 'type' as const, key: type })),
    ...profile.routes.map(({ route }) => ({ scope: 'route' as const, key: route })),
  ];
}

function replace<T>(list: T[], keyOf: (entry: T) => string, key: string, entry: T): T[] {
  const next = list.filter((item) => keyOf(item) !== key);
  const index = next.findIndex((item) => keyOf(item) > key);
  next.splice(index < 0 ? next.length : index, 0, entry);
  return next;
}

/** The body of a template whose overview is `document`; the other views of an existing template stay. */
function bodyWith(existing: TemplateBody | undefined, document: CompositionDocument): TemplateBody {
  return existing?.views ? { views: { ...existing.views, overview: document } } : { document };
}

/** The overview document of a template: the one the editor edits. */
export function overviewOf(profile: PresentationProfile, template: Template): CompositionDocument | undefined {
  switch (template.scope) {
    case 'generic':
      return templateViews(profile.generic).overview;
    case 'base': {
      const entry = profile.bases.find((item) => item.base === template.key);
      return entry && templateViews(entry).overview;
    }
    case 'type': {
      const entry = profile.types.find((item) => item.type === template.key);
      return entry && templateViews(entry).overview;
    }
    case 'route': {
      const entry = profile.routes.find((item) => item.route === template.key);
      return entry && templateViews(entry).overview;
    }
  }
}

export function withTemplate(
  profile: PresentationProfile,
  template: Template,
  document: CompositionDocument,
): PresentationProfile {
  switch (template.scope) {
    case 'generic':
      return {
        ...profile,
        generic: 'views' in profile.generic ? { views: { ...profile.generic.views, overview: document } } : document,
      };
    case 'base':
      return {
        ...profile,
        bases: replace(profile.bases, (entry) => entry.base, template.key, {
          base: template.key,
          ...bodyWith(
            profile.bases.find((entry) => entry.base === template.key),
            document,
          ),
        }),
      };
    case 'type':
      return {
        ...profile,
        types: replace(profile.types, (entry) => entry.type, template.key, {
          type: template.key,
          ...bodyWith(
            profile.types.find((entry) => entry.type === template.key),
            document,
          ),
        }),
      };
    case 'route':
      return {
        ...profile,
        routes: replace(profile.routes, (entry) => entry.route, template.key, {
          route: template.key,
          ...bodyWith(
            profile.routes.find((entry) => entry.route === template.key),
            document,
          ),
        }),
      };
  }
}

export function curationFailure(status: number, body: unknown, headers?: HeadersInit): CurationFailure {
  const problem = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (status === 409 && problem.code === 'stale_editorial_head') return { ok: false, reason: 'stale' };
  if (status === 400) {
    const errors = Array.isArray(problem.errors)
      ? problem.errors.filter(
          (error): error is { pointer: string; code: string } =>
            error !== null &&
            typeof error === 'object' &&
            typeof error.pointer === 'string' &&
            typeof error.code === 'string',
        )
      : [];
    return { ok: false, reason: 'invalid', errors };
  }
  if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
  if (status === 429) {
    const value = new Headers(headers).get('retry-after');
    const seconds = value === null || value.trim() === '' ? NaN : Number(value);
    const retryAfter =
      Number.isFinite(seconds) && seconds >= 0
        ? Math.ceil(seconds)
        : value
          ? Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1000))
          : NaN;
    return { ok: false, reason: 'rate-limited', ...(Number.isFinite(retryAfter) ? { retryAfter } : {}) };
  }
  return { ok: false, reason: 'unavailable' };
}

export async function publishProfile(
  client: KernelClient,
  { profile, expectedHead, authorization, keys }: PublishInput & { authorization: string },
): Promise<PublishResult> {
  try {
    const published = await client.presentation.profiles.post(
      { profile },
      { headers: { authorization, 'idempotency-key': keys.publish } as { 'idempotency-key': string } },
    );
    if (published.status >= 400) return curationFailure(published.status, published.error?.value, published.headers);
    if (!published.data) return { ok: false, reason: 'unavailable' };
    const activated = await client.presentation
      .profiles({ digest: published.data.digest })
      .$activate.post(
        { expected_head: expectedHead },
        { headers: { authorization, 'idempotency-key': keys.activate } as { 'idempotency-key': string } },
      );
    if (activated.status >= 400) return curationFailure(activated.status, activated.error?.value, activated.headers);
    return activated.data ? { ok: true, ...activated.data } : { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
