import type { Pool } from 'pg';
import type { MediaStorage } from './media-storage.ts';
export type UploadErasureCursor = Readonly<{ phase: 'media' | 'fields'; after: string | null }>;
export async function eraseAccountUploadsPage(
  _deps: { pool: Pool; storage: MediaStorage },
  _accountId: string,
  _cursor: UploadErasureCursor | null,
): Promise<{ next: UploadErasureCursor | null; found: number; pending: number }> {
  return { next: null, found: 0, pending: 0 };
}

export function createAccountUploadIndexEffect(_pool: Pool) {
  return { name: 'content_account_upload', types: [] as string[], async run(_event: unknown) {} };
}
