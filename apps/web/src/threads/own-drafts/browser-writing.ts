import { BrowserWritingStore, type WritingScope } from '../local-writing-draft';
import type { OwnDraftEntry, OwnDraftLocalWritingReader, OwnDraftSelection } from './model';

/** Resolve only the existing composer scope for this selected native post. */
export function ownDraftWritingScope(entry: OwnDraftEntry, selection: OwnDraftSelection): WritingScope | null {
  if (entry.documentKind === 'opening') {
    return {
      kind: 'thread',
      boardId: entry.board.id,
      subjects: [...new Set(entry.subjectIds)].sort(),
    };
  }
  return {
    kind: 'reply',
    threadId: entry.threadId,
    ...(selection.post.parentId ? { parentId: selection.post.parentId } : {}),
    subjects: [],
  };
}

/** The caller supplies browser storage only on the client; no global key scan is performed. */
export function ownDraftBrowserWritingReader(storage: () => Storage): OwnDraftLocalWritingReader {
  return {
    async load({ identity, entry, selection }, signal) {
      if (signal.aborted) return null;
      const scope = ownDraftWritingScope(entry, selection);
      if (!scope) return 'unavailable';
      try {
        const saved = new BrowserWritingStore(storage()).load(identity.accountId, scope);
        return signal.aborted ? null : saved;
      } catch {
        return signal.aborted ? null : 'unavailable';
      }
    },
  };
}
