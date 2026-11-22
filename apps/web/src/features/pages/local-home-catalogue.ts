import type { KernelClient } from '@rezics/client';
import type { SubjectSummary } from '../../media/summary';

export type LocalHomeSubject = NonNullable<SubjectSummary> & { label: { value: string; language: string } };

const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The local preview only names candidates. Kernel still admits every current public card. */
export async function readLocalHomeCatalogue(
  client: KernelClient,
  candidates: unknown,
  signal: AbortSignal,
): Promise<LocalHomeSubject[]> {
  if (typeof candidates !== 'string') return [];
  const ids = [
    ...new Set(
      candidates
        .split(',')
        .map((id) => id.trim())
        .filter((id) => subjectId.test(id)),
    ),
  ].slice(0, 36);
  const subjects: LocalHomeSubject[] = [];
  for (let offset = 0; offset < ids.length && !signal.aborted; offset += 6) {
    const reads = await Promise.allSettled(
      ids.slice(offset, offset + 6).map(async (id) => {
        const response = await client.subjects({ id }).get({
          fetch: { signal, cache: 'no-store', redirect: 'manual' },
        });
        if (response.status !== 200 || response.error) return;
        const summary = response.data?.summary;
        if (summary?.id !== id || !summary.label?.value) return;
        return { ...summary, label: summary.label } satisfies LocalHomeSubject;
      }),
    );
    for (const read of reads) if (read.status === 'fulfilled' && read.value) subjects.push(read.value);
  }
  return subjects;
}
