import type {
  KernelClient,
  PersonalEntry,
  PersonalEntryAnnotationWrite,
  PersonalEntryObservation,
  PersonalEntrySourceCorrection,
} from '@rezics/client';

export type PrivateEntryRead = { kind: 'ready'; entry: PersonalEntry } | { kind: 'unavailable' };

export async function readPrivateEntry(
  client: KernelClient,
  subjectId: string,
  authorization: string,
): Promise<PrivateEntryRead> {
  const result = await client.libraryEntries({ subjectId }).personal.get({ headers: { authorization } });
  if (result.error || !result.data?.personalEntry || result.data.personalEntry.subjectId !== subjectId)
    return { kind: 'unavailable' };
  return { kind: 'ready', entry: result.data.personalEntry };
}

export type AnnotationWriteResult =
  | { kind: 'saved'; entry: PersonalEntry }
  | { kind: 'conflict' | 'missing' | 'denied' | 'retired' | 'uncertain' };

export async function writePrivateAnnotations(
  client: KernelClient,
  input: {
    subjectId: string;
    body: PersonalEntryAnnotationWrite;
    key: string;
    authorization: string;
  },
): Promise<AnnotationWriteResult> {
  const result = await client.libraryEntries({ subjectId: input.subjectId }).annotations.put(input.body, {
    headers: { authorization: input.authorization, 'idempotency-key': input.key },
  });
  if (!result.error && result.data?.personalEntry?.subjectId === input.subjectId)
    return { kind: 'saved', entry: result.data.personalEntry };
  if (result.status === 409) return { kind: 'conflict' };
  if (result.status === 401) return { kind: 'retired' };
  if (result.status === 403) return { kind: 'denied' };
  if (result.status === 404) return { kind: 'missing' };
  return { kind: 'uncertain' };
}

export type SourceCorrectionResult =
  | { kind: 'saved'; observation: PersonalEntryObservation }
  | { kind: 'conflict' | 'missing' | 'denied' | 'retired' | 'uncertain' };

export async function correctPrivateSourceObservation(
  client: KernelClient,
  input: {
    subjectId: string;
    body: PersonalEntrySourceCorrection;
    key: string;
    authorization: string;
  },
): Promise<SourceCorrectionResult> {
  const result = await client.libraryEntries({ subjectId: input.subjectId }).sourceObservations.patch(input.body, {
    headers: { authorization: input.authorization, 'idempotency-key': input.key },
  });
  if (!result.error && result.data?.sourceObservation?.recordId === input.body.recordId)
    return { kind: 'saved', observation: result.data.sourceObservation };
  if (result.status === 409) return { kind: 'conflict' };
  if (result.status === 401) return { kind: 'retired' };
  if (result.status === 403) return { kind: 'denied' };
  if (result.status === 404) return { kind: 'missing' };
  return { kind: 'uncertain' };
}
