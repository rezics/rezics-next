import type { KernelClient } from '@rezics/client';
import type { OwnerReadObservation } from '../editor/owner-lifetime';
import { plainText, UI_LOCALES, type ZoneConfiguration, type ZoneLanguage } from '@rezics/composition';

export type OwnedZoneList = NonNullable<Awaited<ReturnType<KernelClient['zones']['get']>>['data']>;
export type OwnedZone = OwnedZoneList['zones'][number];
export type ListInput = { deleted: boolean; cursor?: string };
export type Failure = {
  kind: 'signed-out' | 'denied' | 'closed' | 'actor' | 'missing' | 'invalid' | 'conflict' | 'stale' | 'unavailable';
  fields?: string[];
  ownerObservation?: OwnerReadObservation;
};
export type ListOutcome = ({ kind: 'ready'; page: OwnedZoneList } | Failure) & {
  ownerObservation?: OwnerReadObservation;
};
export type CommandOutcome = ({ kind: 'saved'; zone: OwnedZone } | Failure) & {
  ownerObservation?: OwnerReadObservation;
};
export type LifecycleCommand = { id: string; revision: string; key: string; operation: 'delete' | 'restore' };
export type CreateCommand = {
  starter: string;
  labels: ZoneConfiguration['labels'];
  primaryLanguage?: ZoneLanguage;
  key: string;
};
export const pageLimit = 20;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const labelPattern = new RegExp(Reflect.get(plainText({ maxLength: 80 }), 'pattern'), 'u');

export function listInput(value: Record<string, unknown>): ListInput {
  return {
    deleted: value.deleted === true || value.deleted === 'true',
    ...(typeof value.cursor === 'string' && value.cursor.length > 0 ? { cursor: value.cursor } : {}),
  };
}

export function validLifecycle(command: LifecycleCommand): boolean {
  return (
    !!command &&
    idPattern.test(command.id) &&
    /^[1-9][0-9]*$/.test(command.revision) &&
    /^[0-9a-f-]{36}$/.test(command.key) &&
    ['delete', 'restore'].includes(command.operation)
  );
}

export function invalidLabels(labels: ZoneConfiguration['labels'], primaryLanguage?: ZoneLanguage): string[] {
  if (!labels || typeof labels !== 'object') return UI_LOCALES.map((locale) => `/configuration/labels/${locale}`);
  if (primaryLanguage !== undefined && !UI_LOCALES.includes(primaryLanguage)) return ['/configuration/primaryLanguage'];
  const unknown = Object.keys(labels).filter((key) => !UI_LOCALES.includes(key as ZoneLanguage));
  return [
    ...unknown.map((key) => `/configuration/labels/${key}`),
    ...UI_LOCALES.filter((locale) => {
      if (primaryLanguage !== undefined && locale !== primaryLanguage && !Object.hasOwn(labels, locale)) return false;
      const value = labels[locale];
      return typeof value !== 'string' || !value.trim() || [...value].length > 80 || !labelPattern.test(value);
    }).map((locale) => `/configuration/labels/${locale}`),
  ];
}

/** Only native status/code and field locations are exposed; never raw private Problem details. */
export function failure(status: number, body: unknown): Failure {
  const code = body && typeof body === 'object' ? Reflect.get(body, 'code') : undefined;
  if (status === 401) return { kind: 'signed-out' };
  if (status === 403)
    return { kind: code === 'platform_closed' ? 'closed' : code === 'account_suspended' ? 'actor' : 'denied' };
  if (status === 404) return { kind: 'missing' };
  if (code === 'stale_cursor' || code === 'invalid_cursor') return { kind: 'stale' };
  if (status === 409 || status === 412 || code === 'idempotency_conflict') return { kind: 'conflict' };
  if (status === 400 || status === 422) {
    const errors: unknown = body && typeof body === 'object' ? Reflect.get(body, 'errors') : undefined;
    const fields = Array.isArray(errors)
      ? errors.flatMap((error: unknown) => {
          const pointer: unknown = error && typeof error === 'object' ? Reflect.get(error, 'pointer') : undefined;
          return typeof pointer === 'string' &&
            (pointer.startsWith('/configuration/labels/') || pointer === '/configuration/primaryLanguage')
            ? [pointer]
            : [];
        })
      : [];
    return { kind: 'invalid', fields };
  }
  return { kind: 'unavailable' };
}

export function zonePaths(locale: string, id?: string) {
  const base = `/${locale}/my/zones`;
  return { list: base, create: `${base}/new`, edit: `${base}/${id}/edit`, reader: `/${locale}/zones/${id}` };
}

export function listHref(locale: string, input: ListInput): string {
  const query = new URLSearchParams({ deleted: String(input.deleted) });
  if (input.cursor) query.set('cursor', input.cursor);
  return `${zonePaths(locale).list}?${query}`;
}
