import type { KernelClient } from '@rezics/client';
import { checkSubjectStructure } from '@rezics/definitions/validate';
import type { ReviewContext } from '../../subject/candidates';
import { settingsId } from '../contexts/settings';
import type { EditorialSettingsTransport } from './context-settings';

export type EditorialAddress = { id: string; session?: string };
type Continuity = { session?: string };
export type EditorialCommand = Continuity & { key: string } & (
    | {
        operation: 'create';
        labels: NonNullable<Parameters<KernelClient['contexts']['post']>[0]['labels']>;
        settings?: string;
      }
    | { operation: 'delete' | 'restore'; id: string }
  );
export type EditorialFailure = Continuity & {
  ok: false;
  reason: 'denied' | 'missing' | 'invalid' | 'conflict' | 'unavailable';
};
export type EditorialRead = EditorialFailure | (Continuity & { ok: true; context: ReviewContext });
export type EditorialResult =
  | EditorialFailure
  | (Continuity & {
      ok: true;
      id: string;
      operation: EditorialCommand['operation'];
      context?: ReviewContext;
    });
export type EditorialTransport = {
  read: (address: EditorialAddress) => Promise<EditorialRead>;
  submit: (command: EditorialCommand) => Promise<EditorialResult>;
  settings?: EditorialSettingsTransport;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Context request');
  return input as Record<string, unknown>;
}
function continuity(input: Record<string, unknown>): Continuity {
  if (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
    throw new Error('Invalid continuity');
  return typeof input.session === 'string' ? { session: input.session } : {};
}
export function editorialAddress(input: unknown): EditorialAddress {
  const value = record(input);
  if (typeof value.id !== 'string' || !uuid.test(value.id)) throw new Error('Invalid Context');
  return { id: value.id, ...continuity(value) };
}
export function editorialCommand(input: unknown): EditorialCommand {
  const value = record(input);
  if (typeof value.key !== 'string' || !uuid.test(value.key)) throw new Error('Invalid action key');
  const base = { key: value.key, ...continuity(value) };
  if (value.operation === 'create') {
    if (Object.keys(value).some((key) => !['operation', 'key', 'session', 'labels', 'settings'].includes(key)))
      throw new Error('Invalid Context creation');
    const labels = record(value.labels);
    if (
      !Object.keys(labels).length ||
      checkSubjectStructure({ labels }).violations.length ||
      Object.values(labels).some((label) => typeof label !== 'string' || !label.trim()) ||
      (value.settings !== undefined && !settingsId(value.settings))
    )
      throw new Error('Invalid Context name');
    return Object.freeze({
      ...base,
      operation: 'create',
      labels: Object.freeze({ ...labels }),
      ...(typeof value.settings === 'string' ? { settings: value.settings } : {}),
    });
  }
  if (
    (value.operation !== 'delete' && value.operation !== 'restore') ||
    Object.keys(value).some((key) => !['operation', 'key', 'session', 'id'].includes(key))
  )
    throw new Error('Invalid Context lifecycle');
  return { ...base, ...editorialAddress(value), operation: value.operation };
}
function token(headers?: HeadersInit): Continuity {
  const session = new Headers(headers).get('rezics-session-token');
  return session ? { session } : {};
}
function failure(status: number, problem: unknown, headers?: HeadersInit): EditorialFailure {
  const code = problem && typeof problem === 'object' ? Reflect.get(problem, 'code') : undefined;
  return {
    ok: false,
    ...token(headers),
    reason:
      status === 401 || status === 403
        ? 'denied'
        : status === 404 && code === 'not_found'
          ? 'missing'
          : status === 409 || code === 'idempotency_conflict'
            ? 'conflict'
            : status === 400 || status === 422
              ? 'invalid'
              : 'unavailable',
  };
}
export async function readEditorialContext(
  client: KernelClient,
  authorization: string,
  address: EditorialAddress,
): Promise<EditorialRead> {
  try {
    const response = await client.contexts({ id: address.id }).get({
      headers: {
        authorization,
        ...(address.session ? { 'rezics-session-token': address.session } : {}),
      },
    });
    if (response.status !== 200 || !response.data)
      return failure(response.status, response.error?.value, response.headers);
    if (response.data.context.id !== address.id) return { ok: false, reason: 'unavailable' };
    return { ok: true, context: response.data.context, ...token(response.headers) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Bind only generated native methods. No creator flags, client deadline or invented lifecycle DTO. */
export async function submitEditorialContext(
  client: KernelClient,
  authorization: string,
  input: EditorialCommand,
): Promise<EditorialResult> {
  let command: EditorialCommand;
  try {
    command = editorialCommand(input);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const options = {
    headers: {
      authorization,
      'idempotency-key': JSON.stringify(command.key),
      ...(command.session ? { 'rezics-session-token': command.session } : {}),
    },
  };
  try {
    if (command.operation === 'create') {
      const body = {
        labels: command.labels,
        ...(command.settings ? { settings: command.settings } : {}),
      };
      const response = await client.contexts.post(body, options);
      if (response.status !== 201 || !response.data)
        return failure(response.status, response.error?.value, response.headers);
      if (!uuid.test(response.data.context.id) || response.data.context.kind !== 'community')
        return { ok: false, reason: 'unavailable' };
      return {
        ok: true,
        operation: 'create',
        id: response.data.context.id,
        context: response.data.context,
        ...token(response.headers),
      };
    }
    const endpoint = client.contexts({ id: command.id });
    const response =
      command.operation === 'delete'
        ? await endpoint.delete(undefined, options)
        : await endpoint.$restore.post({}, options);
    if (response.status !== 200 || !response.data)
      return failure(response.status, response.error?.value, response.headers);
    if (
      response.data.context.id !== command.id ||
      response.data.context.state !== (command.operation === 'delete' ? 'deleted' : 'active')
    )
      return { ok: false, reason: 'unavailable' };
    return { ok: true, operation: command.operation, id: command.id, ...token(response.headers) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
