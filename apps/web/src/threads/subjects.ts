import type { KernelClient } from '@rezics/client';
import type { CoverSummary } from '@rezics/ui/cover';

type SubjectRead = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['get']>>['data']>;

/** A thread shows at most this many of its subjects, so a page never reads more than this many. */
export const THREAD_SUBJECT_LIMIT = 4;

/** What a thread page needs to draw one attached subject: its title in every language and its cover summary. */
export type ThreadSubject = {
  id: string;
  types: string[];
  /** The kernel's chosen label, when the read carries a summary. */
  label: string | null;
  labels: Record<string, string>;
  cover: CoverSummary | null;
};

/**
 * Reads the first subjects attached to a thread, one subject read each and all started together. A subject that
 * cannot be read is left out; the thread stays readable without it.
 */
export async function readThreadSubjects(
  client: KernelClient,
  subjectIds: readonly string[],
): Promise<ThreadSubject[]> {
  const reads = await Promise.all(
    subjectIds.slice(0, THREAD_SUBJECT_LIMIT).map(async (id): Promise<ThreadSubject | null> => {
      try {
        const result = await client.subjects({ id }).get();
        const read: SubjectRead | null | undefined = result.error ? null : result.data;
        if (!read?.subject) return null;
        const { subject, summary } = read;
        return {
          id: subject.id,
          types: summary?.types.length ? summary.types : [subject.type],
          label: summary?.label?.value ?? null,
          labels: subject.labels,
          cover: summary?.cover ?? null,
        };
      } catch {
        return null;
      }
    }),
  );
  return reads.filter((subject): subject is ThreadSubject => subject !== null);
}

/** The title to show in `locale`: the subject's label for it, else the kernel's label, else English or any language. */
export function subjectTitle(subject: Pick<ThreadSubject, 'label' | 'labels'>, locale: string): string | null {
  return subject.labels[locale] ?? subject.label ?? subject.labels.en ?? Object.values(subject.labels)[0] ?? null;
}
