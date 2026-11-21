import { AsyncLocalStorage } from 'node:async_hooks';
import { ProblemError } from '../http/problem-error.ts';
import type { PublicSearchPage, SearchPrincipal } from './service-contract.ts';

type Reader = {
  principal: SearchPrincipal;
  now: number;
  deadline: number;
  complete(page: PublicSearchPage): Promise<void>;
};
export type CompleteBookReads = (
  page: PublicSearchPage,
  kindCursor: (reader: Pick<Reader, 'principal' | 'now'>) => Promise<string | null>,
) => Promise<void>;
type Execute = (captured?: () => void, complete?: CompleteBookReads) => Promise<PublicSearchPage>;
type Member = Reader & { execute: Execute; answer: PromiseWithResolvers<PublicSearchPage> };
type Queue = { waiting: Member[]; capturing: boolean; active: number };

// Parked reads hold neither a checkout nor an HTTP permit. Bound them across
// definitions and limit simultaneous native pages for one registration.
const readerLimit = 192;
const waveLimit = 96;
const pageLimit = 2;

/** Freeze the readers before opening the immutable cut. The next capture can
 * start once native custody has transferred the previous registration claim.
 * Current viewer summaries precede the shared FINAL, even for empty pages.
 */
export function createBookRelevanceReads() {
  const queues = new Map<string, Queue>();
  let admitted = 0;

  function start(key: string, queue: Queue) {
    if (queue.capturing || queue.active >= pageLimit) return;
    const members = queue.waiting.splice(0, waveLimit).filter((reader) => {
      if (reader.deadline > Date.now()) return true;
      reader.answer.reject(new ProblemError('deadline_exceeded'));
      return false;
    });
    if (!members.length) {
      if (queue.waiting.length) start(key, queue);
      else if (!queue.active) queues.delete(key);
      return;
    }
    queue.active++;
    queue.capturing = true;
    let claimed = true;
    const captured = () => {
      if (!claimed) return;
      claimed = false;
      queue.capturing = false;
      start(key, queue);
    };
    void serve(members, captured).finally(() => {
      queue.active--;
      if (claimed) queue.capturing = false;
      start(key, queue);
    });
  }

  async function serve(members: Member[], captured: () => void) {
    const first = members.reduce((latest, member) => (member.deadline > latest.deadline ? member : latest));
    try {
      if (members.length === 1) {
        first.answer.resolve(await first.execute(captured));
        return;
      }
      const completed = new Map<Member, PromiseSettledResult<PublicSearchPage>>();
      await first.execute(captured, async (page, kindCursor) => {
        // A hit continuation owns mutable native traversal state. Each reader
        // that needs one gets an independent capture and signed continuation.
        const readers = page.next === null ? members : [first];
        let offset = 0;
        async function disclose() {
          for (let reader = readers[offset++]; reader; reader = readers[offset++]) {
            try {
              if (Date.now() >= reader.deadline) throw new ProblemError('deadline_exceeded');
              const own = structuredClone(page);
              if (own.kinds?.next && reader !== first) own.kinds.next = await kindCursor(reader);
              await reader.complete(own);
              completed.set(reader, { status: 'fulfilled', value: own });
            } catch (reason) {
              completed.set(reader, { status: 'rejected', reason });
            }
          }
        }
        // Each actor needs a native summary read. Keep room in HTTP admission
        // for new credentials and the page's final checks during that fan-out.
        await Promise.all(Array.from({ length: Math.min(8, readers.length) }, disclose));
      });
      for (const reader of members) {
        const result = completed.get(reader);
        if (!result) reader.answer.resolve(reader.execute());
        else if (result.status === 'rejected') reader.answer.reject(result.reason);
        else reader.answer.resolve(result.value);
      }
    } catch (error) {
      for (const reader of members) reader.answer.reject(error);
    }
  }

  return (key: string, reader: Reader, execute: Execute) => {
    if (admitted >= readerLimit) throw new ProblemError('overloaded', { headers: { 'retry-after': '1' } });
    const answer = Promise.withResolvers<PublicSearchPage>();
    const member = {
      ...reader,
      complete: AsyncLocalStorage.bind(reader.complete),
      execute: AsyncLocalStorage.bind(execute),
      answer,
    };
    admitted++;
    const queue = queues.get(key) ?? { waiting: [], capturing: false, active: 0 };
    queues.set(key, queue);
    queue.waiting.push(member);
    start(key, queue);
    return answer.promise.finally(() => {
      admitted--;
    });
  };
}
