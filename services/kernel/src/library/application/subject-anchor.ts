import {
  LIBRARY_SUBJECT_PAGE_LIMIT,
  SubjectIdentityUnavailableError,
  type ResolvedSubject,
  type SubjectIdentityObservation,
  type SubjectIdentityCapability,
  type SubjectPresentationCapability,
} from '../contract/index.ts';
import { mapPresentationBounded } from './presentation-bounds.ts';

type AnchoredSubject = Readonly<{ resolved: ResolvedSubject; epoch: bigint }>;

export function createSubjectAnchorApplication<Context, Mapping extends SubjectIdentityObservation>(
  identity: SubjectIdentityCapability<Context, Mapping>,
) {
  async function resolveMapped(context: Context, id: string, mapping: Mapping): Promise<AnchoredSubject | null> {
    if (mapping.state === 'unavailable') throw new SubjectIdentityUnavailableError(mapping.reason);
    if (mapping.state !== 'mapped') return null;
    if (!identity.validId(mapping.terminal)) return null;
    // Prepare both permissions outside either native reference snapshot.
    const original = await identity.prepareReference(context, id);
    const terminal = await identity.prepareReference(context, mapping.terminal);
    const source = await original();
    if (source.state === 'redirect') {
      if (source.from !== id || source.to !== mapping.terminal) return null;
    } else if (source.state === 'absent' || mapping.terminal !== id) return null;
    const final = await terminal();
    if (final.state === 'redirect') throw identity.redirected(final.from, final.to);
    if (final.state === 'absent') return null;
    return {
      resolved: { subjectId: mapping.terminal, requestedSubjectId: mapping.terminal === id ? null : id },
      epoch: mapping.epoch,
    };
  }
  async function observe(context: Context, id: string): Promise<AnchoredSubject | null> {
    if (!identity.validId(id)) return null;
    const [mapping] = await identity.readMappings(context, [id]);
    return resolveMapped(context, id, mapping!);
  }
  return {
    observe,
    async resolve(context: Context, id: string): Promise<ResolvedSubject | null> {
      return (await observe(context, id))?.resolved ?? null;
    },
    async readable(context: Context, ids: readonly string[]): Promise<string[]> {
      if (ids.length > LIBRARY_SUBJECT_PAGE_LIMIT)
        throw new RangeError(`Subject page must contain at most ${LIBRARY_SUBJECT_PAGE_LIMIT} IDs`);
      const unique = [...new Set(ids)].filter(identity.validId);
      const mappings = await identity.readMappings(context, unique);
      const resolved = await mapPresentationBounded(
        unique.map((id, index) => ({ id, mapping: mappings[index]! })),
        ({ id, mapping }) => resolveMapped(context, id, mapping),
      );
      return unique.filter((_, index) => resolved[index] !== null);
    },
  };
}

/** One summary observation for the complete related-key set, never one hydration per row. */
export function createSubjectPresentationApplication<Context, Mapping extends SubjectIdentityObservation, Summary>(
  identity: SubjectIdentityCapability<Context, Mapping>,
  presentation: SubjectPresentationCapability<Summary>,
) {
  const anchors = createSubjectAnchorApplication(identity);
  return async (context: Context, ids: readonly string[], withholdChangedSource: boolean) => {
    const unique = [...new Set(ids)];
    if (unique.length > LIBRARY_SUBJECT_PAGE_LIMIT)
      throw new RangeError(`Subject page must contain at most ${LIBRARY_SUBJECT_PAGE_LIMIT} IDs`);
    const initial = await mapPresentationBounded(unique, (id) => anchors.observe(context, id));
    const terminals = [...new Set(initial.flatMap((value) => (value ? [value.resolved.subjectId] : [])))];
    const result = new Map<string, Summary | null>(unique.map((id) => [id, null]));
    if (terminals.length === 0) return { value: result, current: async () => true };
    const observed = await presentation.observe(terminals);
    for (const [index, id] of unique.entries()) {
      const before = initial[index];
      if (before) result.set(id, observed.summaries.get(before.resolved.subjectId) ?? null);
    }
    return {
      value: result,
      async current() {
        const currentObservation = await observed.current();
        await mapPresentationBounded(
          unique.map((id, index) => ({ id, before: initial[index] })),
          async ({ id, before }) => {
            if (!before) return;
            const after = await anchors.observe(context, id);
            if (
              !currentObservation ||
              !after ||
              after.epoch !== before.epoch ||
              after.resolved.subjectId !== before.resolved.subjectId
            ) {
              if (!withholdChangedSource) throw presentation.unavailable();
              result.set(id, null);
            }
          },
        );
        return true;
      },
    };
  };
}
