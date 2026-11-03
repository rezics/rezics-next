import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { readSubject } from '../semantic/subject.ts';
import { summaryAuthorization } from '../semantic/summaries.ts';
import { readStatementAs } from '../semantic/statement-disclosure.ts';
import { readLibraryProfileAnchor, sameLibraryProfileAnchor } from './profile-source.ts';

export type EpisodeSourceDependencies = {
  pool: Pool;
  access: Access;
  actor: Actor;
  at: AuthoritativeTime;
  deadline: number;
  routeKey: Uint8Array;
};
export type EpisodeSource = {
  id: string;
  membership: 'member' | 'detached';
  ordinal: string | null;
};

/** Minimal consumer adapter over Semantic's selected, disclosed Subject authority.
 * This is neither a catalogue index nor a vocabulary activation path. */
export async function readEpisodeSource(
  deps: EpisodeSourceDependencies,
  parentId: string,
  episodeId: string,
): Promise<EpisodeSource | null> {
  const parent = await readLibraryProfileAnchor(deps, parentId);
  if (!parent || parent.subjectId !== parentId) return null;
  const before = await readLibraryProfileAnchor(deps, episodeId);
  if (!before || before.subjectId !== episodeId) return null;
  const active = await activeRelease(deps.pool);
  if (!active) throw new ProblemError('semantic_not_ready');
  const type = active.release.types[before.acceptingType];
  const relation = active.release.properties['schema:isPartOf'];
  // Missing released structure is explicit, rather than guessed from source numbers.
  if (
    !type ||
    relation?.relation?.group !== 'membership' ||
    relation.datatype !== 'wikibase-item' ||
    !type.properties.includes('schema:isPartOf') ||
    !relation.targets?.some(
      (target) => target === parent.acceptingType || active.release.types[parent.acceptingType]?.bases.includes(target),
    )
  )
    return null;
  if (before.acceptingType !== 'schema:Episode' && !type.bases.includes('schema:Episode')) return null;
  const authorize = async (id: string) => {
    const route = routeOf(id)!;
    return accessCheck(
      deps.access,
      deps.actor,
      'subject:read',
      {
        route,
        id,
        eligibility: subjectReadEligibility({ route, id }),
      },
      { pool: deps.pool, deadline: deps.deadline, time: deps.at },
    );
  };
  const check = await authorize(episodeId);
  let value;
  try {
    value = await readSubject(deps.pool, episodeId, (client) => check(client, deps.at), GLOBAL_CONTEXT, deps.routeKey, {
      deadline: deps.deadline,
      readAs: (read) => readStatementAs(deps.pool, deps.access, deps.actor, deps.deadline, read),
      prepareAuthorization: () => authorize(episodeId),
      prepareAuthorize: authorize,
      authorize: summaryAuthorization(authorize),
    });
  } catch (error) {
    if (error instanceof SubjectRedirectError) return null;
    throw error;
  }
  if (!value) return null;
  const [after, finalParent, finalRelease] = await Promise.all([
    readLibraryProfileAnchor(deps, episodeId),
    readLibraryProfileAnchor(deps, parentId),
    activeRelease(deps.pool),
  ]);
  if (
    !sameLibraryProfileAnchor(before, after) ||
    !sameLibraryProfileAnchor(parent, finalParent) ||
    finalRelease?.digest !== active.digest
  )
    throw new ProblemError('semantic_not_ready');
  const members = (value.subject.statements['schema:isPartOf'] ?? []).filter((s) => s.rank !== 'deprecated');
  const ordinal = value.subject.statements['schema:episodeNumber']?.find(
    (s) => s.rank !== 'deprecated' && s.value.type === 'value',
  )?.value;
  return {
    id: episodeId,
    membership:
      members.length === 1 &&
      value.subject.resolution['schema:isPartOf'] === undefined &&
      members.some((s) => s.value.type === 'value' && s.value.content === parentId)
        ? 'member'
        : 'detached',
    ordinal:
      ordinal?.type === 'value' && (typeof ordinal.content === 'string' || typeof ordinal.content === 'number')
        ? String(ordinal.content)
        : null,
  };
}
