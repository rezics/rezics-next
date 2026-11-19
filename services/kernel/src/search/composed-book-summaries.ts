import type { AdmissionYield } from '../http/request.ts';
import type { SubjectSummary } from '../semantic/summaries.ts';
import { withRequestDeadline } from '../request/deadline.ts';

type Summaries = Map<string, SubjectSummary | null>;

export type BookSummaryRead = {
  /** The native page's shared Subject authority and catalogue adapter. */
  owner: object;
  release: string;
  languages: readonly string[];
  ids: readonly string[];
  deadline: number;
  read: (ids: readonly string[], deadline: number) => Promise<Summaries>;
  admit: AdmissionYield;
  answer: PromiseWithResolvers<Summaries>;
};

/** Hydrate the union of the selected output slots before each list closes its own withdrawal proof. */
export async function readBookSummaries(waiting: BookSummaryRead[], check: () => void) {
  const resume = new Map<BookSummaryRead, () => void>();
  for (const members of Map.groupBy(waiting, (member) => member.owner).values()) {
    for (const group of Map.groupBy(members, (member) => JSON.stringify([member.release, member.languages])).values()) {
      try {
        check();
        const ids = [...new Set(group.flatMap((member) => member.ids))];
        const deadline = Math.min(...group.map((member) => member.deadline));
        const first = group[0]!;
        const summaries = await first.admit(() => withRequestDeadline(deadline, () => first.read(ids, deadline)));
        for (const member of group) {
          const selected = new Map(member.ids.map((id) => [id, summaries.get(id) ?? null]));
          resume.set(member, () => member.answer.resolve(selected));
        }
      } catch (error) {
        for (const member of group) resume.set(member, () => member.answer.reject(error));
      }
    }
  }
  return resume;
}
