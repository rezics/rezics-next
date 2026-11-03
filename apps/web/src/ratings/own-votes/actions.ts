import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import { Value } from '@sinclair/typebox/value';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { OwnVoteActionsSchema, OwnVotesPageSchema } from '../../../../../services/kernel/src/rating/own-votes-schemas.ts';
import type { OwnVotesPage } from '../../../../../services/kernel/src/rating/own-votes-page.ts';
import { requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { indexOwnVotes, OWN_VOTES_OPERATION, OWN_VOTES_SOURCE, ownVotesCursor } from './inventory';
import { isAdmittedVoteAction, parseOwnVoteIntent, validOwnVoteUnits, type OwnVoteIntent } from './intent';
import { commandOutcome, readOriginalOwnVote, type OwnVoteReadback } from './readback';

export type OwnVotesRead =
  | {
      state: 'ready';
      page: OwnVotesPage;
      subject: string;
      cursor: string | null;
      locale: string;
      source: typeof OWN_VOTES_SOURCE;
    }
  | {
      state: 'signed-out' | 'denied' | 'preparing' | 'unavailable' | 'invalid-cursor';
      page: null;
      subject: string | null;
      cursor: string | null;
      locale: string;
      source: typeof OWN_VOTES_SOURCE | null;
    };

export type OwnVoteCommandResult =
  | { kind: 'acknowledged'; readback: OwnVoteReadback }
  | { kind: 'rejected' | 'uncertain' | 'signed-out' | 'stale' };

function readInput(value: unknown): { cursor: string | null; valid: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { cursor: null, valid: false };
  const cursor = 'cursor' in value ? value.cursor : undefined;
  const address = ownVotesCursor(cursor);
  return { cursor: address.valid ? address.cursor : null, valid: address.valid };
}

function commandInput(value: unknown): OwnVoteIntent {
  const intent = parseOwnVoteIntent(value);
  if (!intent) throw new Error('This rating command is no longer current. Review the page before trying again.');
  return intent;
}

function createNativeTransport(origin: string, authorization: string, fetcher: typeof fetch = globalThis.fetch) {
  let sessionToken: string | null = null;
  const transport: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', authorization);
    if (sessionToken !== null) headers.set(SESSION_HEADER, sessionToken);
    const response = await fetcher(input, {
      ...init,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'manual',
    });
    const next = response.headers.get(SESSION_HEADER);
    if (next !== null) sessionToken = next;
    return response;
  };
  return { transport, client: createKernelClient(origin, { fetch: transport }) };
}

function emptyRead(
  state: Exclude<OwnVotesRead['state'], 'ready'>,
  subject: string | null,
  cursor: string | null,
  locale: string,
): OwnVotesRead {
  return { state, page: null, subject, cursor, locale, source: null };
}

async function readPage(address: { cursor: string | null; valid: boolean }): Promise<OwnVotesRead> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const locale = requestLocale(request) ?? 'en';
  if (!address.valid) return emptyRead('invalid-cursor', null, null, locale);
  const { env } = await import('cloudflare:workers');
  const sessionEnv = env as Partial<SessionEnv>;
  let refused: boolean;
  try {
    refused = await prepareSession(request, sessionEnv);
  } catch {
    return emptyRead('preparing', null, address.cursor, locale);
  }
  const subject = sessionSubject(request) ?? null;
  const authorization = viewerCredential(request);
  if (refused || !subject || !authorization) return emptyRead('signed-out', null, address.cursor, locale);
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (!origin) return emptyRead('unavailable', subject, address.cursor, locale);
  const url = new URL('/v1/me/rating-votes', origin);
  if (address.cursor !== null) url.searchParams.set('cursor', address.cursor);
  try {
    const { transport } = createNativeTransport(origin, authorization);
    const response = await transport(url, { method: 'GET', signal: request.signal });
    if (response.status === 401) return emptyRead('signed-out', null, address.cursor, locale);
    if (response.status === 403) return emptyRead('denied', subject, address.cursor, locale);
    if (response.status === 400) return emptyRead('invalid-cursor', subject, address.cursor, locale);
    if (response.status !== 200) return emptyRead('unavailable', subject, address.cursor, locale);
    const value: unknown = await response.json();
    if (
      !Value.Check(OwnVotesPageSchema, value) ||
      value.viewer.accountId !== subject ||
      !ownVotesCursor(value.next).valid
    )
      return emptyRead('unavailable', subject, address.cursor, locale);
    try {
      indexOwnVotes(value);
      for (const entry of value.votes) {
        if (entry.question.id !== entry.questionId || !validOwnVoteUnits(entry.own.units, entry.question.scale))
          return emptyRead('unavailable', subject, address.cursor, locale);
        if (
          entry.actions.state === 'editable' &&
          (!isAdmittedVoteAction(entry, entry.actions, 'PUT') ||
            !isAdmittedVoteAction(entry, entry.actions, 'DELETE') ||
            !isAdmittedVoteAction(entry, entry.actions, 'GET'))
        )
          return emptyRead('unavailable', subject, address.cursor, locale);
        if (
          entry.actions.state === 'retired' &&
          (!isAdmittedVoteAction(entry, entry.actions, 'DELETE') || !isAdmittedVoteAction(entry, entry.actions, 'GET'))
        )
          return emptyRead('unavailable', subject, address.cursor, locale);
      }
    } catch {
      return emptyRead('unavailable', subject, address.cursor, locale);
    }
    return {
      state: 'ready',
      page: value,
      subject,
      cursor: address.cursor,
      locale,
      source: OWN_VOTES_SOURCE,
    };
  } catch {
    return emptyRead('unavailable', subject, address.cursor, locale);
  }
}

export const readOwnVotesForViewer = createServerFn({ method: 'GET' })
  .validator(readInput)
  .handler(async ({ data }) => readPage(data));

async function currentCommand(intent: OwnVoteIntent): Promise<OwnVoteCommandResult> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const { env } = await import('cloudflare:workers');
  try {
    await prepareSession(request, env as Partial<SessionEnv>);
  } catch {
    return { kind: 'signed-out' };
  }
  const authorization = viewerCredential(request);
  if (!authorization) return { kind: 'signed-out' };
  if (sessionSubject(request) !== intent.viewer) return { kind: 'stale' };
  if (!Value.Check(OwnVoteActionsSchema, intent.actions)) return { kind: 'stale' };
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (!origin) return { kind: 'uncertain' };
  const { client } = createNativeTransport(origin, authorization);
  const vote = client.subjects({ id: intent.targetId }).ratings({ questionId: intent.questionId }).vote;
  const headers = { authorization, 'idempotency-key': intent.key };
  try {
    const response =
      intent.method === 'PUT'
        ? intent.body
          ? await vote.put(intent.body, { headers })
          : null
        : await vote.delete(undefined, { headers });
    if (!response) return { kind: 'stale' };
    const outcome = commandOutcome(response.status, response.error);
    if (outcome !== 'acknowledged') return { kind: outcome };
    const readback = await readOriginalOwnVote(
      client,
      authorization,
      intent.targetId,
      intent.questionId,
      intent.method,
    );
    return { kind: 'acknowledged', readback };
  } catch {
    return { kind: 'uncertain' };
  }
}

export const executeOwnVoteIntent = createServerFn({ method: 'POST' })
  .validator(commandInput)
  .handler(async ({ data }) => currentCommand(data));

async function reviewCommand(input: { intent: OwnVoteIntent; after: 'PUT' | 'DELETE' | 'REVIEW' }): Promise<OwnVoteReadback> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const { env } = await import('cloudflare:workers');
  try {
    await prepareSession(request, env as Partial<SessionEnv>);
  } catch {
    return { kind: 'unavailable' };
  }
  const authorization = viewerCredential(request);
  if (!authorization || sessionSubject(request) !== input.intent.viewer) return { kind: 'unavailable' };
  if (
    !Value.Check(OwnVoteActionsSchema, input.intent.actions) ||
    input.intent.actions.state === 'unavailable' ||
    input.intent.actions.readback !== input.intent.path
  )
    return { kind: 'unavailable' };
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (!origin) return { kind: 'unavailable' };
  const { client } = createNativeTransport(origin, authorization);
  return readOriginalOwnVote(
    client,
    authorization,
    input.intent.targetId,
    input.intent.questionId,
    input.after,
  );
}

export const reviewOwnVoteIntent = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('intent' in value) || !('after' in value))
      throw new Error('Invalid rating review');
    const intent = parseOwnVoteIntent(value.intent);
    const after = value.after;
    if (!intent || (after !== 'PUT' && after !== 'DELETE' && after !== 'REVIEW'))
      throw new Error('Invalid rating review');
    return { intent, after };
  })
  .handler(async ({ data }) => reviewCommand(data));

export function voteReadbackForIntent(intent: OwnVoteIntent, after: 'PUT' | 'DELETE' | 'REVIEW') {
  return reviewOwnVoteIntent({ data: { intent, after } });
}

export type OwnVoteReview = OwnVoteReadback;
export const ownVotesOperation = OWN_VOTES_OPERATION;
