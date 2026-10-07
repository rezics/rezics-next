import type { CopiesApi } from './api.ts';
import { savedCopyMatches } from './intent.ts';
import type { CopyDraft, CopyRecord, RecordResult } from './types.ts';
import { submitRecord, writeNewest, type CommandInstance } from './write.ts';

/**
 * Records one owned copy. The lane is this dialog command, so a second save
 * with the same fields is another copy, while a retry of this unresolved
 * command keeps the command's key.
 */
export function recordOwnedCopy(api: CopiesApi, command: CommandInstance, work: string, draft: CopyDraft):
  Promise<RecordResult<CopyRecord>> {
  return submitRecord(command.id(), draft, (choice, round) => writeNewest(round, 0,
    () => api.createCopy(choice, round.key),
    async () => {
      const copies = await api.copies(work);
      if (!copies.ok) return copies;
      return { ok: true, data: copies.data.items.find(copy => savedCopyMatches(copy, choice)) ?? null };
    },
    current => savedCopyMatches(current, choice),
    current => current.version, false)).then(written => {
    command.finish(written);
    return written;
  });
}
