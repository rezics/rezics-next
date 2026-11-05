import type { Pool } from 'pg';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { subjectReadEligibility } from './eligibility.ts';
import { withReadTransaction } from '../access/read-transaction.ts';
import related from './read-related.sql';

export type ConsentIdentity = {
  subject: { id: string; labels: Record<string, string> } | null;
  target: { id: string; labels: Record<string, string>; redirect?: string } | null;
};
export type ConsentIdentityReader = {
  access: Access;
  actor: Actor;
  deadline: number;
};

/** Each addressed identity has its own native admission and released home snapshot.
 * No source checkout or source authorization is used for these target reads.
 */
export async function readConsentTarget(
  pool: Pool,
  reader: ConsentIdentityReader,
  id: string,
): Promise<ConsentIdentity['target']> {
  async function observe(subject: string) {
    requireAccessDeadline(reader.deadline);
    const route = routeOf(subject);
    if (route === null) return null;
    const check = await accessCheck(
      reader.access,
      reader.actor,
      'subject:read',
      {
        route,
        id: subject,
        eligibility: subjectReadEligibility({ route, id: subject }),
      },
      { pool, deadline: reader.deadline },
    );
    return withReadTransaction(pool, async (client) => {
      const home = partitionOf(route);
      const partition = await readPartition(client, home);
      if (!partition) return null;
      if (partition.writeState === 'moved') throw new CommandUnavailableError('moved', home, partition.movedTo);
      if (partition.writeState !== 'active' || !(await check(client))) return null;
      const rows = await related.run(client, { partition_no: home, routes: [route], subject_ids: [subject] });
      const row = (Array.isArray(rows) ? rows : rows ? [rows] : [])[0];
      requireAccessDeadline(reader.deadline);
      return row?.visibility === 'visible' ? row : null;
    });
  }
  const original = await observe(id);
  if (!original) return null;
  if (!original.redirect) return { id, labels: original.labels as Record<string, string> };
  const survivor = await observe(original.redirect);
  if (!survivor || survivor.redirect) return null;
  // The original must still admit this reader after the survivor's staged read.
  const current = await observe(id);
  if (!current || current.redirect !== survivor.id || current.security_revision !== original.security_revision)
    return null;
  return { id, labels: survivor.labels as Record<string, string>, redirect: survivor.id };
}
