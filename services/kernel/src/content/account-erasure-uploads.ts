import type { Pool } from 'pg';
import type { MediaStorage } from './media-storage.ts';
export type UploadErasureCursor = Readonly<{ phase: 'media' | 'fields'; after: string | null }>;
export async function eraseAccountUploadsPage(
  _deps: { pool: Pool; storage: MediaStorage },
  _accountId: string,
  _cursor: UploadErasureCursor | null,
): Promise<{ next: UploadErasureCursor | null; found: number; pending: number }> {
  throw new Error('Account upload erasure requires a bounded media claim ownership contract');
}

export function createAccountUploadIndexEffect(_pool: Pool) {
  return { name: 'content_account_upload', types: [] as string[], async run(_event: unknown) {} };
}
