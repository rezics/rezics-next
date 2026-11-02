import type { KernelClient } from '@rezics/client';
import {
  profileDigest,
  templateViews,
  VIEWS,
  isView,
  type CompositionDocument,
  type GenericTemplate,
  type PresentationProfile,
  type TemplateBody,
  type View,
  type ViewDocuments,
} from '@rezics/composition';
import { admittedActivationResult, admittedPublishDigest } from './curation-publication-response';

export type Template = { scope: 'generic'; key: null } | { scope: 'base' | 'type' | 'route'; key: string };
/** The failed stage remains visible even when the server returned a typed rejection. */
export type CurationFailure = { ok: false; phase?: 'publish' | 'activate' } & (
  | { reason: 'stale' }
  | { reason: 'forbidden'; admissionChanged?: boolean }
  | { reason: 'unavailable'; outcome?: 'unknown' }
  | { reason: 'invalid'; errors: { pointer: string; code: string }[] }
  | { reason: 'rate-limited'; retryAfter?: number }
);
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

export type CompanionViewSource = 'overview' | 'empty';

/** Add one supported local view from an explicit source without aliasing the overview document. */
export function addCompanionView(
  profile: PresentationProfile,
  template: Template,
  view: View,
  source: CompanionViewSource,
): PresentationProfile {
  if (template.scope === 'route' || !isView(view) || view === 'overview' || viewOf(profile, template, view))
    throw new TypeError('Unsupported companion view');
  const document =
    source === 'overview'
      ? overviewOf(profile, template)
      : source === 'empty'
        ? { root: { props: {} }, content: [] }
        : undefined;
  if (!document) throw new TypeError('A companion view requires an explicit local overview or empty document');
  return withView(profile, template, view, structuredClone(document));
}

/** Remove only the selected local override; overview shorthand and every sibling remain intact. */
export function resetCompanionView(profile: PresentationProfile, template: Template, view: View): PresentationProfile {
  if (template.scope === 'route' || !isView(view) || view === 'overview')
    throw new TypeError('Unsupported companion view');

  function resetBody(body: TemplateBody): TemplateBody {
    if (!body.views || body.views[view] === undefined) return body;
    const views: Partial<ViewDocuments> = { ...body.views };
    delete views[view];
    const overview = views.overview;
    if (!overview) throw new TypeError('A template requires an overview');
    return Object.keys(views).length === 1 ? { document: overview } : { views: views as ViewDocuments };
  }

  switch (template.scope) {
    case 'generic': {
      if (!('views' in profile.generic) || profile.generic.views[view] === undefined) return profile;
      const views: Partial<ViewDocuments> = { ...profile.generic.views };
      delete views[view];
      const overview = views.overview;
      if (!overview) throw new TypeError('A template requires an overview');
      return {
        ...profile,
        generic: Object.keys(views).length === 1 ? overview : { views: views as ViewDocuments },
      };
    }
    case 'base': {
      const entry = profile.bases.find((item) => item.base === template.key);
      if (!entry?.views || entry.views[view] === undefined) return profile;
      return {
        ...profile,
        bases: replace(profile.bases, (item) => item.base, template.key, {
          base: template.key,
          ...resetBody(entry),
        }),
      };
    }
    case 'type': {
      const entry = profile.types.find((item) => item.type === template.key);
      if (!entry?.views || entry.views[view] === undefined) return profile;
      return {
        ...profile,
        types: replace(profile.types, (item) => item.type, template.key, {
          type: template.key,
          ...resetBody(entry),
        }),
      };
    }
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
  const digest = profileDigest(profile);
  let phase: 'publish' | 'activate' = 'publish';
  const unknown = (): PublishResult => ({ ok: false, reason: 'unavailable', outcome: 'unknown', phase });
  try {
    const published = await client.presentation.profiles.post(
      { profile },
      { headers: { authorization, 'idempotency-key': keys.publish } as { 'idempotency-key': string } },
    );
    if (published.status >= 400)
      return { ...curationFailure(published.status, published.error?.value, published.headers), phase };
    if (!admittedPublishDigest(published.data, digest)) return unknown();
    phase = 'activate';
    const activated = await client.presentation
      .profiles({ digest })
      .$activate.post(
        { expected_head: expectedHead },
        { headers: { authorization, 'idempotency-key': keys.activate } as { 'idempotency-key': string } },
      );
    if (activated.status >= 400)
      return { ...curationFailure(activated.status, activated.error?.value, activated.headers), phase };
    const admitted = admittedActivationResult(activated.data, digest);
    return admitted ? { ok: true, digest: admitted.digest, head: admitted.head } : unknown();
  } catch {
    return unknown();
  }
}
