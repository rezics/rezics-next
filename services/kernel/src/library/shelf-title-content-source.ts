import { createHash } from 'node:crypto';
import type { AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { ShelfOwner } from './shelf-maintenance-ops-contract.ts';
import { titleLanguages, type ShelfTitleLabels, type ShelfTitleSource } from './shelf-title-source.ts';

/** Content owns this observation; Library neither reads Subjects nor produces a source version.
 * The version covers the complete title/identity/disclosure/redirect/source-owner input, including
 * foreign owners, independently of `subjects`. It must change on every relevant change, even when
 * no requested subject changed. Unsettled ownership or incomplete observations return unavailable.
 * Each observation releases all source snapshots before returning. With no subjects it reads only
 * the bounded whole-source basis; otherwise it observes <=100 exact originals under that same basis.
 */
export interface ContentShelfTitleInputs {
  observe(input: {
    owner: ShelfOwner;
    languages: readonly string[];
    viewer: AccountActor;
    subjects: readonly string[];
  }): Promise<
    | { status: 'unavailable' }
    | {
        status: 'current';
        version: string;
        entries: readonly (
          | ({ state: 'disclosed' } & ShelfTitleLabels)
          | { state: 'unavailable'; subjectId: string }
        )[];
      }
  >;
}

const unavailable = { status: 'unavailable' as const };
const validVersion = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Exact adapter for the native Library port, installed only by trusted Content composition. */
export function createContentShelfTitleSource(inputs: ContentShelfTitleInputs): ShelfTitleSource {
  function request(owner: ShelfOwner, languages: readonly string[], viewer: AccountActor, subjects: readonly string[]) {
    if (routeOf(owner.accountId) !== owner.route || viewer.accountId !== owner.accountId)
      throw new TypeError('Invalid Content shelf title owner');
    if (
      subjects.length > 100 ||
      new Set(subjects).size !== subjects.length ||
      subjects.some((id) => routeOf(id) === null)
    )
      throw new RangeError('Content shelf titles require at most 100 exact subjects');
    return { owner: { ...owner }, languages: titleLanguages(languages), viewer, subjects: [...subjects] };
  }

  // The source version alone is not portable across owners, language policies or viewer lifetimes.
  function binding(input: ReturnType<typeof request>, version: string) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          'content-shelf-title-v1',
          input.owner,
          input.languages,
          input.viewer.accountId,
          input.viewer.clientId,
          input.viewer.requestedBy,
          input.viewer.authnEpoch,
          [...input.viewer.scopes].sort(),
          version,
        ]),
      )
      .digest('hex');
  }

  return {
    async basis(owner, languages, viewer) {
      const input = request(owner, languages, viewer, []);
      const observed = await inputs.observe(input);
      if (observed.status !== 'current' || !validVersion(observed.version) || observed.entries.length !== 0)
        return unavailable;
      return { status: 'current', version: binding(input, observed.version) };
    },
    async labels(owner, languages, basis, subjectIds, viewer) {
      const input = request(owner, languages, viewer, subjectIds);
      const observed = await inputs.observe(input);
      if (
        observed.status !== 'current' ||
        !validVersion(observed.version) ||
        binding(input, observed.version) !== basis
      )
        return unavailable;
      if (observed.entries.length !== subjectIds.length) return unavailable;
      const expected = new Set(subjectIds);
      const entries: ShelfTitleLabels[] = [];
      for (const row of observed.entries) {
        if (
          row.state !== 'disclosed' ||
          !expected.delete(row.subjectId) ||
          routeOf(row.sourceId) === null ||
          !validVersion(row.sourceBasis) ||
          !row.labels ||
          typeof row.labels !== 'object' ||
          Array.isArray(row.labels) ||
          Object.values(row.labels).some((value) => typeof value !== 'string') ||
          (row.originalLanguage !== undefined &&
            row.originalLanguage !== null &&
            typeof row.originalLanguage !== 'string')
        )
          return unavailable;
        const { state: _state, ...entry } = row;
        entries.push({ ...entry, labels: { ...entry.labels } });
      }
      return { status: 'current', entries };
    },
  };
}
