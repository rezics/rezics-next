import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { requestLocale } from '../../kernel/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { classificationFrontier } from './inventory';
import type { ClassificationFrontier, OwnClassificationsState } from './types';

/** Never replace this with a structural client extension or a raw request. Bind the published declaration. */
type PublishedOwnPage = KernelClient extends { me: { 'classification-assessments': infer Endpoint } }
  ? Endpoint
  : never;
export const publishedOwnClassifications: PublishedOwnPage | null = null;

// Until publication, no server path can return private rows or promise a working ballot command.
export type OwnClassificationsRead = Readonly<{
  state: Exclude<OwnClassificationsState, 'ready'>;
  page: null;
  subject: string | null;
  locale: string;
  frontier: ClassificationFrontier | null;
}>;

export function unavailableOwnClassifications(
  frontier: ClassificationFrontier | null,
  locale: string,
  subject: string | null,
  state: OwnClassificationsRead['state'] = 'unavailable',
): OwnClassificationsRead {
  return { state, page: null, subject, locale, frontier };
}

export const readOwnClassificationsForViewer = createServerFn({ method: 'GET' })
  .validator((input: unknown) =>
    input && typeof input === 'object' && !Array.isArray(input)
      ? classificationFrontier(input as Record<string, unknown>)
      : null,
  )
  .handler(async ({ data }): Promise<OwnClassificationsRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const locale = requestLocale(request) ?? 'en';
    if (!data) return unavailableOwnClassifications(null, locale, null, 'invalid-address');
    try {
      const { env } = await import('cloudflare:workers');
      const refused = await prepareSession(request, env as Partial<SessionEnv>);
      const subject = sessionSubject(request) ?? null;
      if (refused || !subject || !viewerCredential(request))
        return unavailableOwnClassifications(data, locale, null, 'signed-out');
      return unavailableOwnClassifications(data, locale, subject);
    } catch {
      return unavailableOwnClassifications(data, locale, null);
    }
  });
