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
      const visited = new Set<string>();
      let current = id;
      while (!visited.has(current)) {
        visited.add(current);
        const url = new URL(`/v1/subjects/${current}`, origin);
        url.searchParams.set('context', GLOBAL_CONTEXT);
        const response = await fetcher(url, {
          headers: { accept: 'application/json' },
          ...(signal ? { signal } : {}),
          redirect: 'manual',
          cache: 'no-store',
        });
        if (response.status === 308) {
          const body = (await response.json()) as { redirect?: { from?: unknown; to?: unknown } };
          if (
            body.redirect?.from !== current ||
            typeof body.redirect.to !== 'string' ||
            !subjectId.test(body.redirect.to)
          )
            throw new TypeError('Invalid public subject redirect');
          // Native identity redirects address Subjects on this API, never a foreign Location URL.
          current = body.redirect.to;
          continue;
        }
        if (!response.ok) throw new Error(`Public subject read returned ${response.status}`);
        const body = (await response.json()) as ReviewedSubjectRead;
        if (body?.subject?.id !== current) throw new TypeError('Public subject read returned a different identity');
        return body;
      }
      throw new TypeError('Cyclic public subject redirect');
    },
  };
}
