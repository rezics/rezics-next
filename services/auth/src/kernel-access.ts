/** Auth-side kernel Access ports for terminal account erasure.
 * Access implements acknowledgement; Auth never imports kernel modules.
 * The trusted Access object is the binding key, not a request field.
 */
export type AuthErasureAcknowledgement = {
  acknowledgeAccountErasure(accountId: string, outcome: 'erased' | 'none'): Promise<void>;
};

export type AuthDeletionHandleRead = {
  readDeletionHandle(token: string, accountId: string): Promise<string | null>;
};

const acknowledgements = new WeakMap<object, AuthErasureAcknowledgement>();
const handleReads = new WeakMap<object, AuthDeletionHandleRead>();

export function bindAuthErasureAcknowledgement(trustedAccess: object, kernel: AuthErasureAcknowledgement): void {
  acknowledgements.set(trustedAccess, kernel);
}

export function authErasureAcknowledgement(trustedAccess: object): AuthErasureAcknowledgement | undefined {
  return acknowledgements.get(trustedAccess);
}

export function bindAuthDeletionHandleRead(access: object, kernel: AuthDeletionHandleRead): void {
  handleReads.set(access, kernel);
}

export function authDeletionHandleRead(access: object): AuthDeletionHandleRead | undefined {
  return handleReads.get(access);
}

export function normalizeDeletionConfirmation(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

export function deletionConfirmationMatches(confirmation: string, handle: string): boolean {
  return normalizeDeletionConfirmation(confirmation) === normalizeDeletionConfirmation(handle);
}
