import type { Source } from '@rezics/definitions/bulk';
import type { CommandTransaction } from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { fenceKey, sourceTuple } from './fences.ts';
import insertSourceStatement from './subject-page-publication-source.sql';
import lockPointStatement from './subject-page-publication-lock.sql';
import publishPointStatement from './subject-page-publication-publish.sql';
import type { Point, SubjectKey } from './subject-page-publication-store.ts';

export function listed<T>(rows: T[] | T | null): T[] {
  return rows === null ? [] : Array.isArray(rows) ? rows : [rows];
}
export function bounded(length: number, maximum: number) {
  if (length > maximum) throw new RangeError(`Publication budget exceeds ${maximum}`);
}
/** The caller passes the live command's partition; every publication write must run in its subject's home. */
export function assertPublicationHome(partition: number, route: number) {
  if (partition !== partitionOf(route))
    throw new TypeError('Publication write must belong to its authoritative transaction home');
}
const insertSource = {
  run: async (...args: Parameters<typeof insertSourceStatement.run>) =>
    listed(await insertSourceStatement.run(...args)),
};
export const lockPoint = {
  run: async (...args: Parameters<typeof lockPointStatement.run>) => listed(await lockPointStatement.run(...args)),
};
export const publishPoint = {
  run: async (...args: Parameters<typeof publishPointStatement.run>) =>
    listed(await publishPointStatement.run(...args)),
};

/** Native creation proves an empty baseline without inventing a public time. */
export async function initializeSubjectPagePublicationAt(
  tx: CommandTransaction,
  partition: number,
  subject: SubjectKey,
): Promise<void> {
  assertPublicationHome(partition, subject.route);
  const point = (await lockPoint.run(tx, { route: subject.route, subject_id: subject.id }))[0]! as Point;
  await publishPoint.run(tx, {
    route: subject.route,
    subject_id: subject.id,
    generation: point.generation,
    readiness: 'ready',
    completed_position: point.completed_position,
    position: point.change_position,
    effective_at: null,
    witnesses: point.witnesses,
  });
}

/** Retain the canonical source-fence owner when imported identity is first installed. */
export async function retainSubjectPageSourceAt(
  tx: CommandTransaction,
  partition: number,
  input: { subject: SubjectKey; candidates: string[]; source: Source; routeKey: Uint8Array },
): Promise<void> {
  assertPublicationHome(partition, input.subject.route);
  bounded(input.candidates.length, 512);
  const tuple = sourceTuple(input.routeKey, input.source);
  for (const candidate of input.candidates)
    await insertSource.run(tx, {
      route: input.subject.route,
      subject_id: input.subject.id,
      candidate_id: candidate,
      owner_route: tuple.route,
      owner_key: fenceKey(tuple),
    });
}
