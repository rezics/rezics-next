import type { KernelClient } from '@rezics/client';
import { checkSubjectStructure } from '@rezics/definitions/validate';
import { settingsId } from './settings';

export type ContextDto = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['contexts']>['get']>>['data']
>['context'];
export type DirectoryPage = NonNullable<Awaited<ReturnType<KernelClient['contexts']['get']>>['data']>;
export type ContextDirectoryEntry = DirectoryPage['contexts'][number];
export type DirectoryInput = { query?: string; cursor?: string; deleted: boolean; limit: number };
export type Failure = {
  kind: 'signed-out' | 'denied' | 'missing' | 'invalid' | 'conflict' | 'stale' | 'unavailable' | 'unknown';
  session?: string;
};
export type Result<T> = { kind: 'ready'; value: T; session?: string } | Failure;
export type Actions = { action: string; operations: string[] }[];
export type Workspace = {
  context: ContextDto | null;
  lifecycle: ContextDirectoryEntry | null;
  actions: Result<Actions>;
  lifecycleUnavailable: boolean;
};
export type DirectoryWorkspace = { page: Result<DirectoryPage>; creation: Result<Actions> };
export type Command = Readonly<
  { key: string; session?: string } & (
    | { operation: 'create'; labels: Readonly<Record<string, string>>; settings?: string }
    | { operation: 'delete' | 'restore'; id: string }
  )
>;
export type MutationResult =
  | Failure
  | {
      kind: 'confirmed';
      operation: Command['operation'];
      id: string;
      current: Result<Workspace>;
      created?: ContextDto;
      session?: string;
    };
export const contextId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const unavailable = { kind: 'unavailable' } as const;
export function directoryInput(input: Record<string, unknown>): DirectoryInput {
  return {
    deleted: input.deleted === true || input.deleted === 'true',
    limit: 20,
    ...(typeof input.query === 'string' && input.query.trim() ? { query: input.query.trim() } : {}),
    ...(typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
  };
}
export function parseAddress(value: unknown): { id: string; session?: string } {
  const input = record(value);
  if (typeof input.id !== 'string' || !contextId.test(input.id)) throw new Error('Invalid Context address');
  return { id: input.id, ...continuity(input) };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Context request');
  return value as Record<string, unknown>;
}
function continuity(input: Record<string, unknown>): { session?: string } {
  if (input.session === undefined) return {};
  if (typeof input.session !== 'string' || input.session.length > 16384) throw new Error('Invalid continuity');
  return { session: input.session };
}
/** Copy and seal one native payload/key. An uncertain request can only replay this intent. */
export function parseCommand(value: unknown): Command {
  const input = record(value);
  if (typeof input.key !== 'string' || !contextId.test(input.key)) throw new Error('Invalid action key');
  const base = { key: input.key, ...continuity(input) };
  const keys = ['key', 'session', 'operation'];
  if (input.operation === 'create') {
    const labels = record(input.labels);
    const allowed = [...keys, 'labels', 'settings'];
    if (
      !Object.keys(labels).length ||
      checkSubjectStructure({ labels }).violations.length ||
      Object.values(labels).some((label) => typeof label !== 'string' || !label.trim()) ||
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      (input.settings !== undefined && !settingsId(input.settings))
    )
      throw new Error('Invalid Context labels');
    return Object.freeze({
      ...base,
      operation: 'create',
      labels: Object.freeze({ ...labels } as Record<string, string>),
      ...(typeof input.settings === 'string' ? { settings: input.settings } : {}),
    });
  }
  if (
    (input.operation !== 'delete' && input.operation !== 'restore') ||
    Object.keys(input).some((key) => ![...keys, 'id'].includes(key))
  )
    throw new Error('Invalid Context action');
  return Object.freeze({ ...base, ...parseAddress(input), operation: input.operation });
}
export function admits(actions: Result<Actions>, operation: Command['operation']): boolean {
  return (
    actions.kind === 'ready' &&
    actions.value.some(
      (entry) => entry.action === `context:${operation}` && entry.operations.includes(`context.${operation}`),
    )
  );
}
export function lifecycleOperation(value: Workspace): 'delete' | 'restore' | null {
  if ((value.context ?? value.lifecycle)?.kind !== 'community') return null;
  if (value.lifecycle?.state === 'deleted') return value.lifecycle.purgeAfter ? 'restore' : null;
  return value.context ? 'delete' : null;
}
export function directoryHref(
  locale: string,
  input: { query?: string | undefined; cursor?: string | undefined; deleted?: boolean | undefined } = {},
): string {
  const search = new URLSearchParams();
  if (input.query) search.set('query', input.query);
  if (input.deleted) search.set('deleted', 'true');
  if (input.cursor) search.set('cursor', input.cursor);
  return `/${locale}/my/contexts${search.size ? `?${search}` : ''}`;
}
export function detailHref(locale: string, id: string) {
  return `/${locale}/my/contexts/${encodeURIComponent(id)}`;
}
export function contextQueryKey(actor: string, locale: string, mode: string, input: unknown) {
  return ['context-workspace', actor, locale, mode, input] as const;
}
