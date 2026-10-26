import { kernelClient } from '../kernel/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type {
  LibraryEntryState,
  SubjectLibraryMutation,
  SubjectLibraryMutationResponse,
  SubjectSlotEntry,
} from './subject-slot';

const entryStates = new Set<LibraryEntryState>(['planned', 'in_progress', 'completed', 'paused', 'dropped']);

function problemCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const body = value as { value?: unknown; code?: unknown };
  const detail = body.value && typeof body.value === 'object' ? (body.value as { code?: unknown }) : body;
  return typeof detail.code === 'string' ? detail.code : undefined;
}

export async function applySubjectLibraryMutation(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: SubjectLibraryMutation,
): Promise<SubjectLibraryMutationResponse> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { result: 'unavailable' };
    const client = kernelClient();
    const headers = { authorization, 'idempotency-key': input.idempotencyKey };
    if (input.intent === 'entry') {
      if (input.action === 'clear') {
        if (!Number.isSafeInteger(input.revision) || !input.revision || input.revision < 1)
          return { result: 'unavailable' };
        const removed = await client
          .libraryEntries({ subjectId: input.subjectId })
          .delete({}, { query: { revision: input.revision }, headers: headers as never });
        if (removed.error) {
          if (isPlatformClosedProblem(removed.status, removed.error.value)) return { result: 'closed' };
          return {
            result: removed.status === 409 && problemCode(removed.error) === 'conflict' ? 'conflict' : 'unavailable',
          };
        }
        return { result: 'cleared', entry: null };
      }
      if (!input.state || !entryStates.has(input.state)) return { result: 'unavailable' };
      const saved = await client
        .libraryEntries({ subjectId: input.subjectId })
        .put(
          { state: input.state, ...(input.revision === undefined ? {} : { revision: input.revision }) },
          { headers: headers as never },
        );
      if (saved.error) {
        if (isPlatformClosedProblem(saved.status, saved.error.value)) return { result: 'closed' };
        return { result: saved.status === 409 && problemCode(saved.error) === 'conflict' ? 'conflict' : 'unavailable' };
      }
      return { result: 'saved', entry: saved.data.libraryEntry as SubjectSlotEntry };
    }
    if (!input.collectionId) return { result: 'unavailable' };
    const added = await client
      .collections({ collectionId: input.collectionId })
      .members.post({ subjectId: input.subjectId }, { headers: headers as never });
    if (added.error) {
      if (isPlatformClosedProblem(added.status, added.error.value)) return { result: 'closed' };
      if (added.status === 409 && problemCode(added.error) === 'collection_full') return { result: 'collection-full' };
      return { result: 'unavailable' };
    }
    return { result: 'added' };
  } catch (error) {
    return { result: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}
