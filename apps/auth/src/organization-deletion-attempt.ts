/** Historical uncertainty belongs to an exact mounted attempt, never to read advice. */
export type OrganizationDeletionAttempt = {
  readonly identity: Readonly<{
    organizationId: string;
    humanAccountId?: string | undefined;
    operationKey?: string | undefined;
  }>;
  unresolved: boolean;
  mounted: boolean;
};

export function organizationDeletionAttempt(
  identity: OrganizationDeletionAttempt['identity'],
  unresolved = false,
): OrganizationDeletionAttempt {
  return { identity: Object.freeze({ ...identity }), unresolved, mounted: true };
}

export function warnOrganizationDeletionAttempt(attempt: OrganizationDeletionAttempt | null, selected?: string) {
  return Boolean(attempt?.mounted && attempt.unresolved && attempt.identity.organizationId === selected);
}
