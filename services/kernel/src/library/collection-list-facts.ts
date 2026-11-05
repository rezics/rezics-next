import type { Pool } from 'pg';
import { within } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import type { Fact } from '../search/hits.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/read.ts';
import { readListPresentationFacts } from '../semantic/list-presentation.ts';
import { readSubjectSummaries, type SubjectSummary } from '../semantic/summaries.ts';

export type CollectionListFactsDependencies = {
  pool: Pool;
  access: Access;
  actor: Actor;
  routeKey: Uint8Array;
  deadline: number;
};

/**
 * Shared FULL shelf/Collection and future preview attachment boundary. Pass the complete raw prefix,
 * duplicates included, <=100 rows.
 * `revalidate` must reauthorize and compare the caller's current source/membership fence after foreign reads.
 * No checkout may be held when calling this helper. Null/denied subjects are omitted, never given sibling facts.
 * Preview producers must use this same helper once over their globally bounded prefix, not once per Collection.
 */
export async function attachCollectionListFacts<T extends { subjectId: string }>(
  deps: CollectionListFactsDependencies,
  members: readonly T[],
  options: { languages?: readonly string[]; revalidate: () => Promise<void> },
): Promise<(T & { subject: SubjectSummary; facts: Record<string, Fact[]> })[]> {
  if (members.length > 100) throw new RangeError('Collection list facts accept at most 100 raw members');
  const originals = members.map((member) => member.subjectId);
  return withRequestDeadline(deps.deadline, () =>
    within(deps.deadline, async () => {
      requireAccessDeadline(deps.deadline);
      const valid = [...new Set(originals)].filter((id) => routeOf(id) !== null);
      // Mappings are lookup hints until the native fact batch and final equality check prove the association.
      const mappings = await readIdentityMappings(deps.pool, valid);
      const terminals = [...new Set(mappings.flatMap((m) => (m.state === 'mapped' ? [m.terminal] : [])))];
      // Preserve the shared summary/cover projection and its independent legacy 256-ID bound.
      const languages = options.languages === undefined ? {} : { languages: options.languages };
      const summaries = await readSubjectSummaries(deps, terminals, languages);
      // Exactly one actual native fact batch, retaining raw multiplicity for the helper's independent 100 bound.
      const facts = await readListPresentationFacts(deps, originals, languages);
      await options.revalidate();
      const disclosed = valid.filter((id) => facts.get(id) != null);
      const current = await readIdentityMappings(deps.pool, disclosed);
      for (const [index, original] of disclosed.entries()) {
        const before = mappings[valid.indexOf(original)];
        const after = current[index];
        const value = facts.get(original)!;
        if (
          before?.state !== 'mapped' ||
          after?.state !== 'mapped' ||
          before.epoch !== after.epoch ||
          before.terminal !== after.terminal ||
          after.original !== original ||
          after.terminal !== value.id
        )
          throw new ProblemError('semantic_not_ready');
      }
      requireAccessDeadline(deps.deadline);
      return members.flatMap((member) => {
        const value = facts.get(member.subjectId);
        const subject = value ? summaries.get(value.id) : null;
        return value && subject && subject.id === value.id ? [{ ...member, subject, facts: value.facts }] : [];
      });
    }),
  );
}
