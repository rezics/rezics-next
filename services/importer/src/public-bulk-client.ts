import type { ReviewedSubjectRead } from './import-client.ts';

export const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type PublicBulkClient = Readonly<{
  readSubject(id: string, signal?: AbortSignal): Promise<ReviewedSubjectRead>;
}>;

/** A viewer read with no account token or review context attached. */
export function createPublicBulkClient(options: { origin: string; fetch?: typeof fetch }): PublicBulkClient {
  const origin = new URL(options.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
    throw new TypeError('Invalid public API origin');
  const fetcher = options.fetch ?? fetch;

  return {
    async readSubject(id, signal) {
      if (!subjectId.test(id)) throw new TypeError('Invalid public subject identity');
      const url = new URL(`/v1/subjects/${id}`, origin);
      url.searchParams.set('context', GLOBAL_CONTEXT);
      const response = await fetcher(url, {
        headers: { accept: 'application/json' },
        ...(signal ? { signal } : {}),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Public subject read returned ${response.status}`);
      const body = (await response.json()) as ReviewedSubjectRead;
      const subject = body?.subject as { id?: unknown } | undefined;
      if (!subject || subject.id !== id) throw new TypeError('Public subject read returned a different identity');
      return body;
    },
  };
}
