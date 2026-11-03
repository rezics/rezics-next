import type { SessionEnv } from '../../session/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { problemResponse } from '../../media/kernel';
import { readSubjectSuggestions, type SuggestQuery } from '../../search/suggestions';
import type { DescriptorRead } from './type-directory-client';
import {
  parseIdentityIntakeRequest,
  type IdentityHit,
  type IdentityIntakeBinding,
  type IdentityIntakePage,
  type IdentityIntakeStatus,
} from './identity-intake';

type NativeSuggestionPage = Awaited<ReturnType<typeof readSubjectSuggestions>>;
type ViewerState = IdentityIntakePage['viewer']['state'];

export type IdentityIntakeRuntime = {
  prepareSession(request: Request, env: Partial<SessionEnv>): Promise<boolean>;
  carriesSession(request: Request): boolean;
  viewerCredential(request: Request): string | null;
  readTypeDescriptor(typeId: string, locale: string): Promise<DescriptorRead>;
  readSuggestions(
    query: SuggestQuery,
    credential: string | null,
    signal: AbortSignal,
    locale: string,
  ): Promise<NativeSuggestionPage>;
};

async function defaultRuntime(): Promise<IdentityIntakeRuntime> {
  const [session, csrf, directory, search, kernel] = await Promise.all([
    import('../../session/request'),
    import('../../session/csrf'),
    import('./type-directory-client'),
    import('../../search/suggestions'),
    import('../../kernel/client'),
  ]);
  return {
    prepareSession: session.prepareSession,
    carriesSession: csrf.carriesSession,
    viewerCredential: session.viewerCredential,
    readTypeDescriptor: (typeId, locale) =>
      directory.readDirectoryDescriptor(kernel.kernelClient(locale), typeId, locale),
    readSuggestions: (query, credential, signal, locale) =>
      search.readSubjectSuggestions(kernel.kernelClient(locale), query, credential, signal),
  };
}

function limited(value: string, maxBytes = 256): string {
  const encoder = new TextEncoder();
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBytes) return `${output}…`;
    output += character;
    bytes += size;
  }
  return output;
}

function preferredLabels(
  labels: Record<string, string>,
  locale: string,
  language: string,
): { language: string; value: string }[] {
  const priority = (key: string) => (key === language ? 0 : key === locale ? 1 : 2);
  return Object.keys(labels)
    .filter((key) => languageTag.test(key))
    .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
    .slice(0, 5)
    .flatMap((key) => {
      const value = labels[key];
      return typeof value === 'string' && value ? [{ language: key, value: limited(value) }] : [];
    });
}

const languageTag = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;

function projectResults(
  page: NativeSuggestionPage,
  descriptor: Extract<DescriptorRead, { ok: true }>['descriptor'],
  language: string,
): IdentityHit[] {
  return page.subjects.slice(0, 8).map((subject) => {
    const typeLabel = subject.type === descriptor.typeId ? descriptor.label : '';
    const labels = preferredLabels(subject.labels, locale, language);
    const summary = subject.summary
      ? {
          ...(subject.summary.label
            ? {
                label: {
                  language: limited(subject.summary.label.language, 35),
                  value: limited(subject.summary.label.value),
                },
              }
            : {}),
          creativeWork: subject.summary.creativeWork,
          types: subject.summary.types.slice(0, 4).map((type) => limited(type, 96)),
        }
      : null;
    return {
      id: subject.id,
      type: limited(subject.type, 128),
      ...(typeLabel ? { typeLabel: limited(typeLabel, 128) } : {}),
      labels,
      summary,
    };
  });
}

function createPage(
  binding: IdentityIntakeBinding | null,
  status: IdentityIntakeStatus,
  viewer: ViewerState,
  results: IdentityHit[] = [],
): IdentityIntakePage {
  const continueWithResults = status === 'ready' || status === 'partial' || status === 'empty';
  const continueUnverified = status === 'unavailable' || status === 'denied' || status === 'signed-out';
  return {
    binding,
    status,
    viewer: { state: viewer },
    actions: {
      openExisting: results.length > 0,
      continueWithResults,
      continueUnverified,
      retry: status === 'unavailable' || status === 'denied' || status === 'signed-out' || status === 'stale',
      // No current parent-scoped subject:create action read is mounted for the direct generic creator.
      createAuthority: 'unknown',
    },
    results,
  };
}

function failureStatus(error: unknown): IdentityIntakeStatus {
  if (isPlatformClosedError(error)) return 'denied';
  const mapped = problemResponse(error);
  if (mapped.status === 401) return 'signed-out';
  if (mapped.status === 403) return 'denied';
  if (mapped.status === 400 || mapped.status === 422) return 'invalid';
  return 'unavailable';
}

function privateJson(page: IdentityIntakePage, status = 200): Response {
  return Response.json(page, { status, headers: { 'cache-control': 'private, no-store' } });
}

export async function identityIntakeResponse(
  request: Request,
  env: Partial<SessionEnv>,
  runtime?: IdentityIntakeRuntime,
): Promise<Response> {
  if (request.method !== 'GET')
    return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'private, no-store' } });
  const binding = parseIdentityIntakeRequest(new URL(request.url).searchParams);
  if (!binding) return privateJson(createPage(null, 'invalid', 'unknown'), 400);
  let dependencies: IdentityIntakeRuntime;
  try {
    dependencies = runtime ?? (await defaultRuntime());
  } catch {
    return privateJson(createPage(binding, 'unavailable', 'unavailable'));
  }

  let staleSession = false;
  let credential: string | null = null;
  let viewer: ViewerState = 'signed-out';
  try {
    staleSession = await dependencies.prepareSession(request, env);
    credential = staleSession ? null : dependencies.viewerCredential(request);
    if (!staleSession && credential) viewer = 'signed-in';
    else if (!staleSession && dependencies.carriesSession(request))
      return privateJson(createPage(binding, 'unavailable', 'unavailable'));
  } catch {
    return privateJson(createPage(binding, 'unavailable', 'unavailable'));
  }

  let descriptor: DescriptorRead;
  try {
    descriptor = await dependencies.readTypeDescriptor(binding.typeId, binding.locale);
  } catch {
    return privateJson(createPage(binding, 'unavailable', viewer));
  }
  if (!descriptor.ok && descriptor.reason === 'missing')
    return privateJson(createPage(binding, 'stale', viewer));
  if (!descriptor.ok) return privateJson(createPage(binding, 'unavailable', viewer));
  if (descriptor.descriptor.typeId !== binding.typeId || descriptor.descriptor.releaseDigest !== binding.releaseDigest)
    return privateJson(createPage(binding, 'stale', viewer));

  try {
    const suggestions = await dependencies.readSuggestions(
      {
        q: binding.q,
        limit: 8,
        languages: [binding.language],
        filter: JSON.stringify({ type: { in: [binding.typeId] } }),
      },
      credential,
      request.signal,
      binding.locale,
    );
    const results = projectResults(suggestions, descriptor.descriptor, binding.language);
    const partial = results.some((hit) => !hit.summary || !hit.typeLabel || hit.labels.length === 0);
    return privateJson(createPage(binding, results.length === 0 ? 'empty' : partial ? 'partial' : 'ready', viewer, results));
  } catch (error) {
    const status = failureStatus(error);
    const nextViewer = status === 'signed-out' ? 'signed-out' : viewer;
    return privateJson(createPage(binding, status, nextViewer));
  }
}
