import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { isRecord } from './shared';
import { validateViewCursor } from './view-cursor';

/** Revisions per window. A continuation reads the next native window; it never reconstructs an offset. */
export const SUBJECT_HISTORY_PAGE_LIMIT = 20;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cursorLimit = 8192;

export type SubjectHistoryRevision = { revision: number; kind: string };

/** `next: null` is the end of history. A failure is never an end: it keeps the existing rows and the continuation. */
export type SubjectHistoryRead =
  | { kind: 'ready'; revisions: SubjectHistoryRevision[]; next: string | null }
  | { kind: 'failure'; status: number | undefined };

export type SubjectHistoryRequest = {
  subject: string;
  locale: string;
  reader?: string | null | undefined;
  cursor?: string | undefined;
};

/** One native revision window of the subject. Only the revision number and kind leave this reader. */
export async function readSubjectHistory(
  client: KernelClient,
  input: { subject: string; cursor?: string | undefined },
  authorization?: string | undefined,
  signal?: AbortSignal,
): Promise<SubjectHistoryRead> {
  try {
    const response = await client.subjects({ id: input.subject }).revisions.get({
      query: { limit: SUBJECT_HISTORY_PAGE_LIMIT, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) },
      headers: authorization ? { authorization } : {},
      fetch: { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) },
    });
    if (response.status !== 200 || !response.data) return { kind: 'failure', status: response.status };
    return {
      kind: 'ready',
      revisions: response.data.revisions.map(({ revision, kind }) => ({ revision, kind })),
      next: response.data.next,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    // A transport failure is unavailable history, not the end of it.
    return { kind: 'failure', status: undefined };
  }
}

/** Public, Global-reading history window for the mounted relation reader. */
export const loadSubjectHistory = createServerFn({ method: 'GET', strict: false })
  .validator((value: unknown): SubjectHistoryRequest => {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => !['subject', 'locale', 'reader', 'cursor'].includes(key)) ||
      typeof value.subject !== 'string' ||
      !uuidPattern.test(value.subject) ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35 ||
      (value.reader !== undefined &&
        value.reader !== null &&
        (typeof value.reader !== 'string' || !value.reader || value.reader.length > 128)) ||
      (typeof value.cursor === 'string' && value.cursor.length > cursorLimit)
    )
      throw notFound();
    return {
      subject: value.subject,
      locale: value.locale,
      reader: value.reader as string | null | undefined,
      cursor: validateViewCursor(value.cursor),
    };
  })
  .handler(async ({ data }) => {
    const { subjectKernelClient } = await import('./subject-queries');
    setResponseHeader('cache-control', 'private, no-store');
    const { client, authorization } =
      data.reader === null
        ? { client: (await import('../../kernel/client')).kernelClient(data.locale), authorization: undefined }
        : await subjectKernelClient(data.locale, undefined, data.reader);
    return readSubjectHistory(client, data, authorization, getRequest().signal);
  });
