import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { requestLocale } from '../../kernel/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { readQuestionManagementSource } from './native';
import type {
  QuestionManagementAddress,
  QuestionManagementRead,
  QuestionManagementVisit,
} from './types';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const episodePattern = /^[a-f0-9]{64}$/;

type AddressInput = { realmId: string; selectedQuestionId?: string; cursor?: string };

function addressFrom(value: unknown): AddressInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.realmId !== 'string' ||
    !idPattern.test(input.realmId) ||
    (input.selectedQuestionId !== undefined && input.selectedQuestionId !== null &&
      (typeof input.selectedQuestionId !== 'string' || !idPattern.test(input.selectedQuestionId))) ||
    (input.cursor !== undefined &&
      input.cursor !== null &&
      (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 4096))
  )
    return null;
  return {
    realmId: input.realmId,
    ...(typeof input.selectedQuestionId === 'string' ? { selectedQuestionId: input.selectedQuestionId } : {}),
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
  };
}

function addressView(input: AddressInput): QuestionManagementAddress {
  return {
    realmId: input.realmId,
    selectedQuestionId: input.selectedQuestionId ?? null,
    cursor: input.cursor ?? null,
  };
}

async function fingerprint(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function currentSession() {
  const request = getRequest();
  const locale = requestLocale(request) ?? 'en';
  setResponseHeader('cache-control', 'private, no-store');
  const { env } = await import('cloudflare:workers');
  const refused = await prepareSession(request, env as Partial<SessionEnv>, { refresh: false });
  const viewer = refused ? null : (sessionSubject(request) ?? null);
  const authorization = refused ? null : (viewerCredential(request) ?? null);
  const csrf = refused ? null : (requestCsrfToken(request) ?? null);
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN ?? null;
  return {
    request,
    locale,
    viewer,
    authorization,
    csrf,
    origin,
    credentialEpisode: authorization ? await fingerprint(authorization) : null,
    csrfEpisode: csrf ? await fingerprint(csrf) : null,
  };
}

function visitFor(input: AddressInput, session: Awaited<ReturnType<typeof currentSession>>): QuestionManagementVisit {
  const address = addressView(input);
  if (!session.viewer || !session.authorization || !session.csrf)
    return { ...address, locale: session.locale, viewer: null, credentialEpisode: null, csrfEpisode: null, state: 'signed-out' };
  if (!session.origin || !session.credentialEpisode || !session.csrfEpisode)
    return {
      ...address,
      locale: session.locale,
      viewer: session.viewer,
      credentialEpisode: session.credentialEpisode,
      csrfEpisode: session.csrfEpisode,
      state: 'unavailable',
    };
  return {
    ...address,
    locale: session.locale,
    viewer: session.viewer,
    credentialEpisode: session.credentialEpisode,
    csrfEpisode: session.csrfEpisode,
    state: 'preparing',
  };
}

function validVisit(value: unknown): value is QuestionManagementVisit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const visit = value as Record<string, unknown>;
  return (
    typeof visit.realmId === 'string' &&
    idPattern.test(visit.realmId) &&
    (visit.selectedQuestionId === null ||
      (typeof visit.selectedQuestionId === 'string' && idPattern.test(visit.selectedQuestionId))) &&
    (visit.cursor === null || (typeof visit.cursor === 'string' && visit.cursor.length > 0 && visit.cursor.length <= 4096)) &&
    typeof visit.locale === 'string' &&
    typeof visit.viewer === 'string' &&
    idPattern.test(visit.viewer) &&
    typeof visit.credentialEpisode === 'string' &&
    episodePattern.test(visit.credentialEpisode) &&
    typeof visit.csrfEpisode === 'string' &&
    episodePattern.test(visit.csrfEpisode) &&
    visit.state === 'preparing'
  );
}

export const prepareQuestionManagementVisit = createServerFn({ method: 'GET' })
  .validator(addressFrom)
  .handler(async ({ data }): Promise<QuestionManagementVisit> => {
    const locale = requestLocale(getRequest()) ?? 'en';
    if (!data) {
      setResponseHeader('cache-control', 'private, no-store');
      return {
        realmId: '',
        selectedQuestionId: null,
        cursor: null,
        locale,
        viewer: null,
        credentialEpisode: null,
        csrfEpisode: null,
        state: 'invalid-address',
      };
    }
    try {
      return visitFor(data, await currentSession());
    } catch {
      return {
        ...addressView(data),
        locale,
        viewer: null,
        credentialEpisode: null,
        csrfEpisode: null,
        state: 'unavailable',
      };
    }
  });

/** Each mounted browser admission rereads its exact paired source frontier. */
export const readQuestionManagementForViewer = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const address = addressFrom(input.address);
    if (!address || !validVisit(input.visit)) return null;
    const visit = input.visit;
    if (
      visit.realmId !== address.realmId ||
      visit.selectedQuestionId !== (address.selectedQuestionId ?? null) ||
      visit.cursor !== (address.cursor ?? null)
    )
      return null;
    return { address, visit };
  })
  .handler(async ({ data, signal }): Promise<QuestionManagementRead> => {
    const locale = requestLocale(getRequest()) ?? 'en';
    if (!data) return { realmId: '', selectedQuestionId: null, cursor: null, locale, viewer: null, state: 'invalid-address' };
    const address = addressView(data.address);
    try {
      const session = await currentSession();
      const currentVisit = visitFor(data.address, session);
      if (
        currentVisit.state !== 'preparing' ||
        session.locale !== data.visit.locale ||
        session.viewer !== data.visit.viewer ||
        session.credentialEpisode !== data.visit.credentialEpisode ||
        session.csrfEpisode !== data.visit.csrfEpisode
      )
        return { ...address, locale, viewer: session.viewer, state: session.viewer ? 'retired' : 'signed-out' };
      if (!session.origin || !session.authorization)
        return { ...address, locale, viewer: session.viewer, state: 'unavailable' };
      const result = await readQuestionManagementSource({
        origin: session.origin,
        authorization: session.authorization,
        address,
        locale,
        ...(signal ? { signal } : {}),
      });
      if (result.state !== 'ready')
        return { ...address, locale, viewer: session.viewer, state: result.state };
      return {
        ...address,
        locale,
        viewer: session.viewer!,
        credentialEpisode: session.credentialEpisode!,
        csrfEpisode: session.csrfEpisode!,
        state: 'ready',
        page: result.page,
      };
    } catch {
      return { ...address, locale, viewer: data.visit.viewer, state: 'unavailable' };
    }
  });
