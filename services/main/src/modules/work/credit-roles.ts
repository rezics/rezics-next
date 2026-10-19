/** Admitted attribution roles for either participant alternative. */
export const NATIVE_CREDIT_ROLES = ['author', 'translator', 'editor', 'director', 'artist', 'animation-studio', 'performer'] as const;
/** Preserve the physical seek ranks for saved continuations. */
export const WORK_CREDIT_ROLES = ['author', 'director', 'artist', 'animation-studio', 'translator', 'editor', 'transcriber', 'performer'] as const;
export type NativeCreditRole = typeof NATIVE_CREDIT_ROLES[number];
export type WorkCreditRole = typeof WORK_CREDIT_ROLES[number];
export function isNativeCreditRole(role: string): role is NativeCreditRole {
  return (NATIVE_CREDIT_ROLES as readonly string[]).includes(role);
}
