import type { Release, RelationGroup } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { SubjectNotFoundError } from './candidates.ts';
import { redirectOf, SubjectRedirectError } from './merges.ts';
import readVisibility from './read-visibility.sql';
import readSubjectCounts from './read-subject-counts.sql';
import { withReadTransaction } from './read.ts';

export type SubjectRelationCounts = {
  properties: Record<string, { out?: number; in?: number }>;
  groups: Record<string, { out: number; in: number }>;
  content: null;
};

type ProvenPropertyDirections = { out: number; in?: number } | { out?: number; in: number };
type ProvenGroupDirections = { out: number; in?: number } | { out?: number; in: number };

export type SubjectRelationCountResponse = {
  properties?: Record<string, ProvenPropertyDirections>;
  groups?: Record<string, ProvenGroupDirections>;
  content: null;
};

type CountRow = { direction: 'out' | 'in'; property: string; value: string };

export async function readSubjectRelationCounts(
  pool: Pool,
  options: {
    subject: string;
    release: Release;
    authorize: (client: PoolClient) => Promise<boolean>;
  },
): Promise<{
  counts: SubjectRelationCounts;
  component: { partition: number; epoch: number; position: bigint };
}> {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();

  return withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    const state = (await readVisibility.run(client, { route, subject_id: options.subject })) as {
      visibility: string;
    } | null;
    if (!partition || state?.visibility !== 'visible' || !(await options.authorize(client)))
      throw new SubjectNotFoundError();
    const redirect = await redirectOf(client, options.subject);
    if (redirect) throw new SubjectRedirectError(options.subject, redirect);

    await client.query('SET LOCAL enable_seqscan = off');
    const rows = (await readSubjectCounts.run(client, {
      route,
      subject_id: options.subject,
    })) as CountRow[];

    const properties = Object.create(null) as SubjectRelationCounts['properties'];
    const groups = Object.create(null) as SubjectRelationCounts['groups'];
    for (const row of rows) {
      const group = options.release.properties[row.property]?.relation?.group as RelationGroup | undefined;
      if (!group) continue;

      const value = Number(row.value);
      if (!Number.isFinite(value) || value <= 0) continue;
      const direction = row.direction;
      const propertyCounts = properties[row.property] ?? (properties[row.property] = {});
      propertyCounts[direction] = value;

      const groupCounts = groups[group] ?? (groups[group] = { out: 0, in: 0 });
      groupCounts[direction] += value;
    }

    return {
      counts: { properties, groups, content: null },
      component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
    };
  });
}
