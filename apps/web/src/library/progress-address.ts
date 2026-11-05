/** Addresses are opaque: validate shape and native bounds, never decode a cursor. */
export const progressAddressId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ProgressIndexAddress = {
  subjectId?: string;
  state?: string;
  mode?: string;
  profileId?: string;
  cursor?: string;
};
export type ProgressSessionAddress = { id: string; changes?: string; units?: string; logs?: string };
export type ProgressAddressField =
  | 'subjectId'
  | 'state'
  | 'mode'
  | 'profileId'
  | 'cursor'
  | 'id'
  | 'changes'
  | 'units'
  | 'logs';

// Preserve malformed search values as invalid strings instead of silently dropping a filter.
function value(input: unknown): string | undefined {
  return input === undefined ? undefined : typeof input === 'string' ? input : `\0${JSON.stringify(input)}`;
}
export function progressIndexAddress(input: unknown): ProgressIndexAddress {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    ...(source.subjectId === undefined ? {} : { subjectId: value(source.subjectId)! }),
    ...(source.state === undefined ? {} : { state: value(source.state)! }),
    ...(source.mode === undefined ? {} : { mode: value(source.mode)! }),
    ...(source.profileId === undefined ? {} : { profileId: value(source.profileId)! }),
    ...(source.cursor === undefined ? {} : { cursor: value(source.cursor)! }),
  };
}
export function progressSessionAddress(input: unknown): ProgressSessionAddress {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    id: value(source.id) ?? '',
    ...(source.changes === undefined ? {} : { changes: value(source.changes)! }),
    ...(source.units === undefined ? {} : { units: value(source.units)! }),
    ...(source.logs === undefined ? {} : { logs: value(source.logs)! }),
  };
}
export function progressAddressIssue(
  address: ProgressIndexAddress | ProgressSessionAddress,
): ProgressAddressField | undefined {
  const id = 'id' in address ? 'id' : 'subjectId';
  const identifier = address[id as keyof typeof address];
  if (identifier !== undefined && !progressAddressId.test(identifier)) return id;
  if (!('id' in address)) {
    const index = address as ProgressIndexAddress;
    const modes = ['scalar_amount', 'cursor_position', 'completed_units'];
    if (index.state !== undefined && !['active', 'completed', 'abandoned'].includes(index.state)) return 'state';
    if (index.mode !== undefined && !modes.includes(index.mode)) return 'mode';
    if (
      index.profileId !== undefined &&
      (!index.profileId.length || index.profileId.length > 128 || /[\x00-\x1f\x7f]/.test(index.profileId))
    )
      return 'profileId';
    if ([index.state, index.mode, index.profileId].filter((value) => value !== undefined).length > 1)
      return index.profileId !== undefined ? 'profileId' : 'mode';
  }
  for (const key of ['cursor', 'changes', 'units', 'logs'] as const) {
    const cursor = (address as Partial<Record<ProgressAddressField, string>>)[key];
    if (cursor !== undefined && (!cursor.length || cursor.length > 4096 || /[\x00-\x1f\x7f]/.test(cursor))) return key;
  }
  return undefined;
}
export class ProgressAddressError extends Error {
  constructor(public field: ProgressAddressField) {
    super('Invalid Progress address');
  }
}
/** A correction changes exactly one operand, retaining every other requested position. */
export function correctProgressAddress<T extends ProgressIndexAddress | ProgressSessionAddress>(
  address: T,
  field: ProgressAddressField,
  replacement?: string,
): T {
  const next = { ...address };
  if (replacement === undefined) delete (next as Record<string, unknown>)[field];
  else (next as Record<string, unknown>)[field] = replacement;
  return next;
}
