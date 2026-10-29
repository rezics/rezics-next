import type { KernelClient } from '@rezics/client';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { changePersonalLibraryEntry, removePersonalLibraryEntry } from './entries-read';
import { libraryEntryStatesWrite, type LibraryEntryStateWrite } from './subject-slot';
import type { SubjectLibraryMutation, SubjectLibraryMutationResponse, SubjectSlotEntry } from './subject-slot';

const writableEntryStates = new Set<LibraryEntryStateWrite>(libraryEntryStatesWrite);

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
    if (input.intent === 'entry') {
      const client = kernelClient();
      if (input.action === 'clear') {
        if (!Number.isSafeInteger(input.revision) || !input.revision || input.revision < 1)
          return { result: 'unavailable' };
        const removed = await removePersonalLibraryEntry(client, request, sessionEnv, {
          subjectId: input.subjectId,
          revision: input.revision,
          ...(input.incarnationId === undefined ? {} : { incarnationId: input.incarnationId }),
          idempotencyKey: input.idempotencyKey,
        });
        if (removed.ok) return { result: 'cleared', entry: null };
        if (removed.reason === 'conflict')
          return {
            result: 'conflict',
            entry: {
              subjectId: removed.entry.subjectId,
              state: removed.entry.state,
              revision: removed.entry.revision,
              ...(removed.entry.incarnationId === undefined ? {} : { incarnationId: removed.entry.incarnationId }),
            },
          };
        return { result: removed.reason === 'closed' ? 'closed' : 'unavailable' };
      }
      if (!input.state || !writableEntryStates.has(input.state)) return { result: 'unavailable' };
      const saved = await changePersonalLibraryEntry(client, request, sessionEnv, {
        subjectId: input.subjectId,
        state: input.state,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        ...(input.incarnationId === undefined ? {} : { incarnationId: input.incarnationId }),
        idempotencyKey: input.idempotencyKey,
      });
      if (saved.ok && saved.entry) return { result: 'saved', entry: saved.entry as SubjectSlotEntry };
      if (saved.ok) return { result: 'unavailable' };
      if (saved.reason === 'conflict')
        return {
          result: 'conflict',
          entry: {
            subjectId: saved.entry.subjectId,
            state: saved.entry.state,
            revision: saved.entry.revision,
            ...(saved.entry.incarnationId === undefined ? {} : { incarnationId: saved.entry.incarnationId }),
          },
        };
      return { result: saved.reason === 'closed' ? 'closed' : 'unavailable' };
    }
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { result: 'unavailable' };
    const client = kernelClient();
    const headers = { authorization, 'idempotency-key': input.idempotencyKey };
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
