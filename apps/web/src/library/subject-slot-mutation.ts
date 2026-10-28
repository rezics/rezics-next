import type { KernelClient } from '@rezics/client';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { libraryFullQuery } from './reads';
import { libraryEntryStatesWrite, type LibraryEntryStateWrite } from './subject-slot';
import type { SubjectLibraryMutation, SubjectLibraryMutationResponse, SubjectSlotEntry } from './subject-slot';

const writableEntryStates = new Set<LibraryEntryStateWrite>(libraryEntryStatesWrite);

function problemCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const body = value as { value?: unknown; code?: unknown };
  const detail = body.value && typeof body.value === 'object' ? (body.value as { code?: unknown }) : body;
  return typeof detail.code === 'string' ? detail.code : undefined;
}

/** A stale revision leaves the stored entry unchanged, so the caller can show what is there now. */
async function reloadEntry(
  client: KernelClient,
  subjectId: string,
  authorization: string,
): Promise<SubjectSlotEntry | null | undefined> {
  const loaded = await client.libraryEntries({ subjectId }).get({
    query: libraryFullQuery(),
    headers: { authorization },
  });
  if (loaded.status === 404) return null;
  if (loaded.error || loaded.data == null) return undefined;
  const entry = loaded.data.libraryEntry;
  return { subjectId: entry.subjectId, state: entry.state, revision: entry.revision };
}

async function explainConflict(
  client: KernelClient,
  subjectId: string,
  authorization: string,
): Promise<SubjectLibraryMutationResponse> {
  const current = await reloadEntry(client, subjectId, authorization);
  if (current === undefined) return { result: 'unavailable' };
  return { result: 'conflict', entry: current };
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
          if (removed.status === 409 && problemCode(removed.error) === 'conflict')
            return explainConflict(client, input.subjectId, authorization);
          return { result: 'unavailable' };
        }
        return { result: 'cleared', entry: null };
      }
      if (!input.state || !writableEntryStates.has(input.state)) return { result: 'unavailable' };
      const saved = await client
        .libraryEntries({ subjectId: input.subjectId })
        .put(
          { state: input.state, ...(input.revision === undefined ? {} : { revision: input.revision }) },
          { headers: headers as never },
        );
      if (saved.error) {
        if (isPlatformClosedProblem(saved.status, saved.error.value)) return { result: 'closed' };
        if (saved.status === 409 && problemCode(saved.error) === 'conflict')
          return explainConflict(client, input.subjectId, authorization);
        return { result: 'unavailable' };
      }
      return { result: 'saved', entry: saved.data.libraryEntry };
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
