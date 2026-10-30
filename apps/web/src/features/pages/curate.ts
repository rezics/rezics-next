import type { KernelClient } from '@rezics/client';
import {
  templateViews,
  VIEWS,
  isView,
  type CompositionDocument,
  type GenericTemplate,
  type PresentationProfile,
  type TemplateBody,
  type View,
} from '@rezics/composition';

export type Template = { scope: 'generic'; key: null } | { scope: 'base' | 'type' | 'route'; key: string };
export type CurationFailure =
  | { ok: false; reason: 'stale' | 'forbidden' }
  | { ok: false; reason: 'unavailable'; outcome?: 'unknown'; phase?: 'publish' | 'activate' }
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

function templateBody(profile: PresentationProfile, template: Template): TemplateBody | GenericTemplate | undefined {
  switch (template.scope) {
    case 'generic':
      return profile.generic;
    case 'base':
      return profile.bases.find((item) => item.base === template.key);
    case 'type':
      return profile.types.find((item) => item.type === template.key);
    case 'route':
      return profile.routes.find((item) => item.route === template.key);
  }
}

/** Only locally defined documents are editable; missing views retain native fallback resolution. */
export function templateViewNames(profile: PresentationProfile, template: Template): View[] {
  const body = templateBody(profile, template);
  const views = body && templateViews(body);
  return VIEWS.filter((view) => views?.[view] !== undefined);
}

export function viewOf(profile: PresentationProfile, template: Template, view: View): CompositionDocument | undefined {
  const body = templateBody(profile, template);
  return body && templateViews(body)[view];
}

export function overviewOf(profile: PresentationProfile, template: Template): CompositionDocument | undefined {
  return viewOf(profile, template, 'overview');
}

/** Keep the shorthand for overview-only templates and every sibling document of a multi-view template. */
function bodyWith(existing: TemplateBody | undefined, document: CompositionDocument, view: View): TemplateBody {
  if (existing?.views) return { views: { ...existing.views, [view]: document } };
  if (view === 'overview') return { document };
  if (!existing?.document) throw new TypeError('A template requires an overview');
  return { views: { overview: existing.document, [view]: document } };
}

export function withView(
  profile: PresentationProfile,
  template: Template,
  view: View,
  document: CompositionDocument,
): PresentationProfile {
  if (!isView(view) || (template.scope === 'route' && view !== 'overview'))
    throw new TypeError('Unsupported template view');
  switch (template.scope) {
    case 'generic':
      return {
        ...profile,
        generic:
          'views' in profile.generic
            ? { views: { ...profile.generic.views, [view]: document } }
            : view === 'overview'
              ? document
              : { views: { overview: profile.generic, [view]: document } },
      };
    case 'base':
      return {
        ...profile,
        bases: replace(profile.bases, (entry) => entry.base, template.key, {
          base: template.key,
          ...bodyWith(
            profile.bases.find((entry) => entry.base === template.key),
            document,
            view,
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
            view,
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
            view,
          ),
        }),
      };
  }
}

export function withTemplate(profile: PresentationProfile, template: Template, document: CompositionDocument) {
  return withView(profile, template, 'overview', document);
}

/** Native validation uses array positions, never a label or a template key in place of a JSON pointer. */
export function viewPointer(profile: PresentationProfile, template: Template, view: View): string {
  const body = templateBody(profile, template);
  const root =
    template.scope === 'generic'
      ? '/generic'
      : template.scope === 'base'
        ? `/bases/${profile.bases.findIndex((entry) => entry.base === template.key)}`
        : template.scope === 'type'
          ? `/types/${profile.types.findIndex((entry) => entry.type === template.key)}`
          : `/routes/${profile.routes.findIndex((entry) => entry.route === template.key)}`;
  return body && 'views' in body ? `${root}/views/${view}` : template.scope === 'generic' ? root : `${root}/document`;
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
  let phase: 'publish' | 'activate' = 'publish';
  try {
    const published = await client.presentation.profiles.post(
      { profile },
      { headers: { authorization, 'idempotency-key': keys.publish } as { 'idempotency-key': string } },
    );
    if (published.status >= 400) return curationFailure(published.status, published.error?.value, published.headers);
    if (!published.data) return { ok: false, reason: 'unavailable', outcome: 'unknown', phase };
    phase = 'activate';
    const activated = await client.presentation
      .profiles({ digest: published.data.digest })
      .$activate.post(
        { expected_head: expectedHead },
        { headers: { authorization, 'idempotency-key': keys.activate } as { 'idempotency-key': string } },
      );
    if (activated.status >= 400) return curationFailure(activated.status, activated.error?.value, activated.headers);
    return activated.data
      ? { ok: true, ...activated.data }
      : { ok: false, reason: 'unavailable', outcome: 'unknown', phase };
  } catch {
    return { ok: false, reason: 'unavailable', outcome: 'unknown', phase };
  }
}
