/** Native deletion episode only; the server owns the original retention deadline. */
export type DeletionEvidence = { deletionId: string; revision: number };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function nativeRevision(value: string | null): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision <= 2_147_483_646 ? revision : undefined;
}

export function deletionEvidence(headers: Headers, kind: 'Copy' | 'Published-Log'): DeletionEvidence | undefined {
  const deletionId = headers.get(`Library-${kind}-Deletion-Id`);
  const revision = nativeRevision(headers.get(`Library-${kind}-Deletion-Revision`));
  return deletionId && uuid.test(deletionId) && revision !== undefined ? { deletionId, revision } : undefined;
}
