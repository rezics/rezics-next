import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { noEffect, runCommand, type CommandEvent } from '../command/command.ts';
import type { Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { SUBJECT_PAGE_REPAIR_QUEUED, SUBJECT_PAGE_WORK_COMMITTED } from '../events/contracts/semantic.ts';
import { readSubjectPageNativeWindow, readSubjectPageNativeComponent } from './subject-page-publication-reader.ts';
import candidateWindow from './subject-page-candidates.sql';
import {
  claimSubjectPagePublicationWork,
  commitSubjectPageBootstrapPage,
  commitSubjectPageFanoutPage,
  commitSubjectPageRepairPage,
  enqueueSubjectPageRepair,
  readSubjectPageReplayWindow,
  readSubjectPageFanoutWindow,
  subjectPagePublicationHomes,
  type SubjectKey,
  type ComponentTransition,
  type EvidenceTime,
} from './subject-page-publication-store.ts';
export type SubjectPagePublication = {
  requestRebuild(subject: SubjectKey): Promise<void>;
  step(options: { limit: number }): Promise<{ processed: number; next: string | null; done: boolean }>;
};
const mounted = new WeakMap<object, SubjectPagePublication | (() => SubjectPagePublication)>();
/** Defer kernel construction until publication is used, after Access composition. */
export function mountSubjectPagePublication(
  app: object,
  runtime: SubjectPagePublication | (() => SubjectPagePublication),
): void {
  if (mounted.has(app)) throw new Error('Subject page publication already mounted');
  mounted.set(app, runtime);
}
export function subjectPagePublicationFor(app: object): SubjectPagePublication {
  const runtime = mounted.get(app);
  if (!runtime) throw new Error('Subject page publication is not mounted');
  if (typeof runtime === 'function') {
    const resolved = runtime();
    mounted.set(app, resolved);
    return resolved;
  }
  return runtime;
}
/** One committed step shares its source budget across phase changes. */
export function createSubjectPagePublication({
  pool,
  clock,
  routeKey,
}: {
  pool: Pool;
  access: Access;
  clock: KernelClock;
  routeKey: Uint8Array;
}): SubjectPagePublication {
  const worker = randomUUID();
  // Resume each invocation after the last partition it serviced. Re-sorting from
  // partition zero on every step would repeatedly walk earlier busy homes while
  // later homes wait for their first bounded page.
  let afterPartition = -1;
  let idleAttempt = 0;
  return {
    async requestRebuild(subject) {
      if (routeOf(subject.id) !== subject.route) throw new TypeError('Subject route mismatch');
      await runCommand(pool, { partition: partitionOf(subject.route), clock }, async (tx) => {
        await enqueueSubjectPageRepair(tx, { subject, cause: 'explicit' });
        return {
          value: null,
          events: [{ type: SUBJECT_PAGE_REPAIR_QUEUED, subject: subject.id, data: { subject, cause: 'explicit' } }],
        };
      });
    },
    async step({ limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 32)
        throw new RangeError('Publication step limit must be from 1 to 32');
      const homes = await subjectPagePublicationHomes(pool);
      const start = homes.findIndex((partition) => partition > afterPartition);
      const orderedHomes = start < 0 ? homes : [...homes.slice(start), ...homes.slice(0, start)];
      for (const partition of orderedHomes) {
        afterPartition = partition;
        const result = await runCommand(pool, { partition, clock }, async (tx) => {
          const work = await claimSubjectPagePublicationWork(tx, {
            partition,
            worker,
            leaseUntil: new Date(Date.now() + 30_000).toISOString(),
          });
          if (!work) return noEffect(null);
          const outbox: CommandEvent[] = [];
          let processed = 0;
          if (work.kind === 'bootstrap') {
            const found = await candidateWindow.run(tx, {
              partition_no: partition,
              after_route: work.after?.[0] ?? partition * 16,
              after_id: work.after?.[1] ?? '00000000-0000-0000-0000-000000000000',
              limit: limit + 1,
            });
            const page = found.slice(0, limit);
            processed = page.length;
            const last = page.at(-1);
            await commitSubjectPageBootstrapPage(tx, {
              partition,
              expectedVersion: work.version,
              after: last ? [last.route, last.id] : work.after,
              subjects: page,
              complete: found.length <= limit,
            });
          } else if (work.kind === 'fanout') {
            const page = await readSubjectPageFanoutWindow(tx, {
              owner: work.owner,
              after: work.after,
              limit,
              sentinel: true,
            });
            processed = page.edges.length;
            await commitSubjectPageFanoutPage(tx, {
              owner: work.owner,
              changeId: work.changeId,
              expectedVersion: work.version,
              after: page.edges.at(-1)?.sourceKey ?? work.after,
              subjects: page.edges.map((e) => e.subject),
              outbox,
              complete: !page.hasMore,
            });
          } else {
            const cp = { ...work.checkpoint };
            const components: (ComponentTransition & EvidenceTime)[] = [];
            const replayedChangeIds: string[] = [];
            let complete = false;
            let remaining = limit;
            while (remaining > 0 && cp.phase !== 'done') {
              if (cp.phase === 'replay') {
                const page = await readSubjectPageReplayWindow(tx, {
                  subject: work.subject,
                  after: cp.replayPosition,
                  limit: remaining,
                  sentinel: true,
                });
                processed += page.changes.length;
                remaining -= page.changes.length;
                for (const change of page.changes) {
                  if (change.component) {
                    const current = await readSubjectPageNativeComponent(tx, work.subject, change.component, routeKey);
                    if (
                      change.time.effectiveAt &&
                      (!current.effectiveAt || Date.parse(change.time.effectiveAt) > Date.parse(current.effectiveAt))
                    ) {
                      current.effectiveAt = change.time.effectiveAt;
                      current.evidence = change.time.evidence;
                    }
                    components.push(current);
                  } else replayedChangeIds.push(change.changeId);
                  cp.replayPosition = change.position;
                }
                // Completion needs a later empty replay window after this page commits.
                if (page.changes.length === 0) {
                  complete = true;
                  cp.phase = 'done';
                }
                if (page.changes.length > 0 || page.hasMore) break;
                continue;
              }
              const phase = cp.phase === 'bootstrap' ? 'descriptive' : cp.phase;
              const page = await readSubjectPageNativeWindow(tx, {
                subject: work.subject,
                phase,
                after: cp.sourceKey,
                limit: remaining,
                sentinel: true,
              });
              processed += page.keys.length;
              remaining -= page.keys.length;
              for (const key of page.keys)
                if (key.component.key)
                  components.push(await readSubjectPageNativeComponent(tx, work.subject, key.component, routeKey));
              cp.sourceKey = page.keys.at(-1)?.sourceKey ?? cp.sourceKey;
              if (!page.hasMore) {
                cp.phase = phase === 'descriptive' ? 'relations' : phase === 'relations' ? 'evidence' : 'replay';
                cp.sourceKey = [];
                continue;
              }
              break;
            }
            await commitSubjectPageRepairPage(tx, {
              subject: work.subject,
              expectedVersion: work.checkpoint.version,
              checkpoint: cp,
              components,
              outbox,
              replayedChangeIds,
              complete,
            });
          }
          // Checkpoint writes still need the ordinary command fence, even without dependency deltas.
          if (!outbox.length) outbox.push({ type: SUBJECT_PAGE_WORK_COMMITTED, data: { partition, kind: work.kind } });
          return { value: { processed, next: JSON.stringify(work) }, events: outbox };
        });
        if (result.value) {
          const done = (await subjectPagePublicationHomes(pool)).length === 0;
          return { processed: result.value.processed, next: done ? null : result.value.next, done };
        }
      }
      const done = homes.length === 0;
      idleAttempt++;
      return {
        processed: 0,
        next: done ? null : JSON.stringify({ afterPartition, idleAttempt }),
        done,
      };
    },
  };
}
