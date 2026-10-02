import type { PoolClient } from 'pg';
import { admittedTypes } from '../types/registry.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import {
  WorkReadInvalid,
  WorkReadMissing,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import type { FollowDescription } from './store.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';

export interface SpaceIdentity {
  space: string;
  realm: string;
  aliases: string[];
}
/** Bounded capability projection, never a disclosure grant. */
export async function followSpace(
  session: Pick<WorkReadSession, 'query'>,
  target: string,
): Promise<SpaceIdentity | null> {
  const rows = await session.query(
    `SELECT DISTINCT ?space ?realm ?zone WHERE { GRAPH ${iri(GRAPHS.current)} {
    { BIND(${iri(target)} AS ?space) ?space a rv:Space ; rv:realmCapability ?realm }
    UNION { BIND(${iri(target)} AS ?realm) ?realm a rv:Realm ; rv:space ?space . ?space rv:realmCapability ?realm }
    UNION { BIND(${iri(target)} AS ?zone) ?space rv:zoneCapability ?zone ; rv:realmCapability ?realm }
    ?space a rv:Space . ?realm a rv:Realm ; rv:space ?space . OPTIONAL { ?space rv:zoneCapability ?zone }
  } } LIMIT 3`,
    2,
  );
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.space || !rows[0].realm)
    throw new WorkReadUnavailable('Space identity is ambiguous');
  const row = rows[0];
  return {
    space: row.space!.value,
    realm: row.realm!.value,
    aliases: [row.space!.value, row.realm!.value, ...(row.zone ? [row.zone.value] : [])],
  };
}
export async function registerFollowSpace(client: PoolClient, identity: SpaceIdentity) {
  await client.query(
    `INSERT INTO access.follow_space_alias(alias,space,realm)
    SELECT alias,$2,$3 FROM unnest($1::text[]) alias ON CONFLICT(alias) DO UPDATE SET
    space=EXCLUDED.space,realm=EXCLUDED.realm`,
    [identity.aliases, identity.space, identity.realm],
  );
}
/** Structural owners choose a grain; extensible descriptive types use the
 * current type registry. A hint can assert identity, never admit a new kind. */
export async function resolveFollowIdentity(
  session: WorkReadSession,
  target: string,
  hint?: string,
): Promise<FollowDescription> {
  if (target.startsWith('urn:rezics:saved-view:')) return { target, kind: 'saved-view' };
  if (target.startsWith('open-library:')) return { target, kind: 'external-author' };
  const space = await followSpace(session, target);
  if (space) {
    if (hint && !['realm', 'zone', 'space'].includes(hint))
      throw new WorkReadInvalid('Follow kind does not match target');
    return { target: space.space, kind: 'space', space };
  }
  const rows = await session.query(
    `SELECT ?type WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(target)} a ?type } } LIMIT 65`,
    64,
  );
  const types = rows.flatMap((row) => (row.type ? [row.type.value] : []));
  const registered = admittedTypes
    .filter((entry) => types.includes(entry.type))
    .sort((a, b) => a.priority - b.priority || a.type.localeCompare(b.type));
  let kind = types.includes(`${RV}Agent`)
    ? 'agent'
    : types.includes(`${RV}Concept`) ||
        types.includes('http://www.w3.org/2004/02/skos/core#Concept')
      ? 'concept'
      : types.includes('https://schema.org/CreativeWork') ||
          registered.some((entry) => entry.base === 'work')
        ? 'work'
        : types.includes(`${RV}Collection`)
          ? 'collection'
          : types.includes(`${RV}Release`) || types.includes(`${RV}FixedRelease`)
            ? 'release'
            : registered[0]?.type;
  if (!kind) {
    const [{ readResourceSummaries }, { targetSummaryReader }] = await Promise.all([
      import('../media/summary.ts'),
      import('../target/resolve.ts'),
    ]);
    const summary = (
      await readResourceSummaries(
        session.deps.environment,
        session.deps.media?.store,
        targetSummaryReader(session),
        {
          resources: [target],
          context: DEFAULT_MEDIA_CONTEXT,
          language: session.options.language ?? null,
          includeCollections: true,
        },
      )
    ).summaries[0];
    if (summary?.status !== 'available')
      throw new WorkReadMissing('Follow target has no admitted type');
    kind = summary.type;
  }
  if (hint && hint !== kind) throw new WorkReadInvalid('Follow kind does not match target');
  return { target, kind };
}
