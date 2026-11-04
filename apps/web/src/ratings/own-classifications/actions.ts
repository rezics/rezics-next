import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { requestLocale } from '../../kernel/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { classificationFrontier } from './inventory';
import { createOwnClassificationClient } from './native';
import { parseClassificationIntent } from './intent';
import type { ClassificationFrontier, OwnClassificationsRead } from './types';
export type { OwnClassificationsRead } from './types';

export function unavailableOwnClassifications(
  frontier: ClassificationFrontier | null,
  locale: string,
  subject: string | null,
  state: Exclude<OwnClassificationsRead['state'], 'ready'> = 'unavailable',
): OwnClassificationsRead {
  return { state, page: null, subject, locale, frontier };
}

async function prepareNativeClient() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const locale = requestLocale(request) ?? 'en';
  const { env } = await import('cloudflare:workers');
  const refused = await prepareSession(request, env as Partial<SessionEnv>, { refresh: false });
  const subject = sessionSubject(request) ?? null;
  const authorization = viewerCredential(request);
  const csrfToken = requestCsrfToken(request);
  if (refused || !subject || !authorization || !csrfToken) return { locale, subject: null, client: null };
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  return {
    locale,
    subject,
    client: origin
      ? await createOwnClassificationClient({
          origin,
          authorization,
          accountId: subject,
          csrfToken,
          locale,
          signal: request.signal,
        })
      : null,
  };
}

const readFrontier = (input: unknown) =>
  input && typeof input === 'object' && !Array.isArray(input)
    ? classificationFrontier(input as Record<string, unknown>)
    : null;

/** Router loader caches retain only session preparation, never private inventory rows. */
export const prepareOwnClassificationsVisit = createServerFn({ method: 'GET' })
  .validator(readFrontier)
  .handler(async ({ data }): Promise<OwnClassificationsRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale(getRequest()) ?? 'en';
    if (!data) return unavailableOwnClassifications(null, locale, null, 'invalid-address');
    try {
      const session = await prepareNativeClient();
      return unavailableOwnClassifications(
        data,
        locale,
        session.subject,
        !session.subject ? 'signed-out' : session.client ? 'preparing' : 'unavailable',
      );
    } catch {
      return unavailableOwnClassifications(data, locale, null);
    }
  });

export const readOwnClassificationsForViewer = createServerFn({ method: 'GET' })
  .validator(readFrontier)
  .handler(async ({ data }): Promise<OwnClassificationsRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale(getRequest()) ?? 'en';
    if (!data) return unavailableOwnClassifications(null, locale, null, 'invalid-address');
    try {
      const session = await prepareNativeClient();
      if (!session.subject) return unavailableOwnClassifications(data, locale, null, 'signed-out');
      return session.client ? session.client.read(data) : unavailableOwnClassifications(data, locale, session.subject);
    } catch {
      return unavailableOwnClassifications(data, locale, null);
    }
  });

export const executeClassificationIntent = createServerFn({ method: 'POST' })
  .validator(parseClassificationIntent)
  .handler(async ({ data }) => {
    try {
      const session = await prepareNativeClient();
      return session.client
        ? session.client.execute(data)
        : { kind: session.subject ? ('unavailable' as const) : ('denied' as const) };
    } catch {
      return { kind: 'unavailable' as const };
    }
  });

export const reviewClassificationIntent = createServerFn({ method: 'POST' })
  .validator(parseClassificationIntent)
  .handler(async ({ data }) => {
    try {
      const session = await prepareNativeClient();
      return session.client ? session.client.review(data) : { kind: 'unavailable' as const };
    } catch {
      return { kind: 'unavailable' as const };
    }
  });
