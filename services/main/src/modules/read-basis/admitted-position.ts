import { createHash } from 'node:crypto';
import { readDependencyToken, type ReadPosition, type WorkReadSession } from '../work/read-session.ts';

/** A relation without its own visible membership revision must derive one from
 * admitted rows. Stream bounded owner pages under the request's existing cost
 * and deadline; never retain the inventory or hash denied candidates/scan keys.
 * Hash each item separately so hidden rows cannot change batch boundaries. */
export async function admittedReadPosition(session: WorkReadSession, name: string,
  pages: (probe: WorkReadSession) => AsyncIterable<readonly unknown[]>): Promise<ReadPosition> {
  const dependencyToken = await session.selection(`continuation:${name}`, async probe => {
    const hash = createHash('sha256');
    for await (const items of pages(probe)) {
      probe.checkDeadline();
      for (const item of items) hash.update(readDependencyToken(item));
    }
    return hash.digest('hex');
  });
  return { ...session.position, dependencyToken };
}
