import type {
  PublicFilterCost,
  PublicFilterSubjectIdentities,
  PublicFilterSubjectIdentityRequest,
} from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterSource } from '../semantic/index.ts';
import type { AdmissionYield } from '../http/admission.ts';

export type BookIdentityRow = Extract<PublicFilterSubjectIdentities, { status: 'observed' }>['rows'][number];
export type BookIdentityRead = {
  source: PublicFilterSource;
  request: PublicFilterSubjectIdentityRequest;
  charge: (cost: PublicFilterCost) => void;
  admit: AdmissionYield;
  answer: PromiseWithResolvers<readonly BookIdentityRow[] | undefined>;
};

/** Only the first raw windows meet here. Refills read their own new window.
 * Read each set of shared originals once, under the exact same native anonymous
 * identity policy. Charge each native traversal only to reads asking for its roots. */
export async function readBookIdentities(waiting: BookIdentityRead[], check: () => void) {
  const settled = new Map<BookIdentityRead, () => void>();
  for (const [source, reads] of Map.groupBy(waiting, (r) => r.source)) {
    for (const group of Map.groupBy(reads, (read) => read.request.meaning.digest).values()) {
      try {
        if (source.readPublicFilterSubjectIdentityWindows) {
          check();
          const windows = await group[0]!.admit(() =>
            source.readPublicFilterSubjectIdentityWindows!(group.map((read) => read.request)),
          );
          if (windows.length !== group.length) throw new Error('Incomplete Book identity windows');
          const failures: unknown[] = [];
          group.forEach((read, i) => {
            const window = windows[i]!;
            try {
              read.charge(window.cost);
            } catch (error) {
              failures.push(error);
            }
            const byId = new Map(window.status === 'observed' ? window.rows.map((row) => [row.subject, row]) : []);
            const rows = read.request.subjects.map((id) => byId.get(id));
            const complete =
              window.status === 'observed' &&
              byId.size === new Set(read.request.subjects).size &&
              window.rows.length === byId.size &&
              rows.every((row) => row !== undefined);
            settled.set(read, () => read.answer.resolve(complete ? rows : undefined));
          });
          if (failures.length) throw failures[0];
          continue;
        }
        const owners = new Map<string, number[]>();
        const result = group.map(() => ({ rows: new Map<string, BookIdentityRow>(), spent: 0, complete: true }));
        group.forEach(({ request }, i) => {
          for (const id of new Set(request.subjects)) {
            const indices = owners.get(id);
            if (indices) indices.push(i);
            else owners.set(id, [i]);
          }
        });
        for (const entries of Map.groupBy([...owners], ([, indices]) => indices.join(',')).values()) {
          check();
          const indices = entries[0]![1];
          const subjects = entries.map(([id]) => id);
          const first = group[indices[0]!]!;
          const inputLimit = Math.min(...indices.map((i) => group[i]!.request.inputLimit - result[i]!.spent));
          if (inputLimit < subjects.length) {
            for (const i of indices) result[i]!.complete = false;
            continue;
          }
          const deadline = Math.min(...indices.map((i) => group[i]!.request.context.deadline));
          const observation = await first.admit(() =>
            source.readPublicFilterSubjectIdentities!({
              ...first.request,
              subjects,
              inputLimit,
              context: { deadline },
            }),
          );
          const failures: unknown[] = [];
          for (const [position, index] of indices.entries()) {
            // Integer shares sum to every counter, including failed lookups and redirect steps.
            // Use the full input count for each caller's subsequent admission.
            const share = Object.fromEntries(
              Object.entries(observation.cost).map(([key, n]) => [key, Math.floor((n + position) / indices.length)]),
            ) as PublicFilterCost;
            try {
              group[index]!.charge(share);
            } catch (error) {
              failures.push(error);
            }
            const current = result[index]!;
            current.spent += observation.cost.inputKeys;
            if (observation.status !== 'observed' || observation.rows.length !== subjects.length) {
              current.complete = false;
              continue;
            }
            for (const row of observation.rows) current.rows.set(row.subject, row);
          }
          if (failures.length) throw failures[0];
        }
        for (const [i, read] of group.entries()) {
          const current = result[i]!;
          const rows = read.request.subjects.map((id) => current.rows.get(id));
          const complete = current.complete && rows.every((row) => row !== undefined);
          settled.set(read, () => read.answer.resolve(complete ? rows : undefined));
        }
      } catch (error) {
        for (const read of group) settled.set(read, () => read.answer.reject(error));
      }
    }
  }
  return settled;
}
