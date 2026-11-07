/** Principal kind marker only; never an account ID. */
export const ANONYMOUS_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000000';
export type CommandPrincipal =
  | { kind: 'account'; id: string }
  | { kind: 'anonymous'; id: typeof ANONYMOUS_PRINCIPAL_ID };

/** Pure receipt-key validation; the anonymous marker never identifies an account. */
export function normalizeCommandKey(principal: CommandPrincipal, key: string): string {
  if (
    !principal ||
    (principal.kind !== 'account' && principal.kind !== 'anonymous') ||
    (principal.kind === 'anonymous' && principal.id !== ANONYMOUS_PRINCIPAL_ID) ||
    (principal.kind === 'account' &&
      (typeof principal.id !== 'string' || principal.id.length === 0 || principal.id === ANONYMOUS_PRINCIPAL_ID))
  )
    throw new TypeError('Invalid command principal');
  if (typeof key !== 'string' || key.length < 1 || key.length > 255)
    throw new TypeError('A command key must be a string of 1 to 255 characters');
  if (principal.kind === 'account') return key;
  if (
    key.length !== 36 ||
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(key)
  )
    throw new TypeError('An anonymous command key must be a canonical UUIDv4');
  return key.toLowerCase();
}
