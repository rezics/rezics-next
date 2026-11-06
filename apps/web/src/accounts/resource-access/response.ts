import type { Change } from './data';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A successful HTTP status acknowledges only the exact submitted grant, never an unrelated response. */
export function grantAcknowledged(value: unknown, change: Change, route: number): boolean {
  if (!record(value) || !record(value.grant)) return false;
  const grant = value.grant;
  if (!record(grant.resource) || !record(grant.subject)) return false;
  if (grant.resource.id !== change.resourceId || grant.resource.route !== route || grant.valid !== change.valid)
    return false;
  const subject = change.subject;
  if (grant.subject.kind !== subject.kind) return false;
  if (subject.kind !== 'active_accounts' && grant.subject.id !== subject.id) return false;
  if (subject.kind === 'organization' && grant.subject.role !== subject.role) return false;
  if (change.kind === 'role') return grant.role === change.role;
  const actions = grant.actions;
  return (
    Array.isArray(actions) &&
    actions.length === change.actions.length &&
    new Set(actions).size === change.actions.length &&
    change.actions.every((action) => actions.includes(action))
  );
}

/** Decode the public problem boundary without confusing an arbitrary dependency failure with preparation. */
export function accessProblemCode(error: unknown): string | null {
  if (!record(error)) return null;
  const value = record(error.value) ? error.value : error;
  if (typeof value.code === 'string') return value.code;
  return typeof value.type === 'string' ? (value.type.split('/').at(-1) ?? null) : null;
}

export function accessPreparing(status: number, error: unknown): boolean {
  if (status === 202) return true;
  return status === 503 && accessProblemCode(error) === 'preparing';
}
