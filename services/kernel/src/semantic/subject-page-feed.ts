import type { Pool } from 'pg';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { preparePublicSubjectPageCandidates, type PublicSubjectPageCandidate } from './subject-page-navigation.ts';
import type { KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { PageCursorError } from './page.ts';
import { pageSubjectPageCandidates } from './subject-page-candidates.ts';
import { createSubjectPagePublicationStore, type PublicationEntry } from './subject-page-publication-store.ts';
import type { SubjectPagePublication } from './subject-page-publication.ts';

/** The crawler advances one raw source home, including omitted candidates. */
export function createSubjectPageFeed(config: {
  pool: Pool;
  access: Access;
  clock: KernelClock;
  routeKey: Uint8Array;
  tokens: KeyRing;
  publication: SubjectPagePublication;
}) {
  const store = createSubjectPagePublicationStore(config);
  return {
    async page(options: { limit?: number; cursor?: string }) {
      return withRequestDeadline(deadlineFor(2000), async () => {
        const limit = options.limit ?? 20;
        const binding = { operation: 'subject-pages.list', parameters: { limit } };
        let partition = 0;
        let sourceCursor: string | undefined;
        if (options.cursor !== undefined) {
          const decoded = decodeCursor(config.tokens, binding, options.cursor, config.clock().getTime());
          if (!decoded.ok) throw new PageCursorError(decoded.reason);
          const [home, cursor] = decoded.after;
          if (
            decoded.after.length !== 2 ||
            typeof home !== 'number' ||
            !Number.isInteger(home) ||
            home < 0 ||
            home > 4095 ||
            typeof cursor !== 'string'
          )
            throw new PageCursorError('invalid');
          partition = home;
          sourceCursor = cursor || undefined;
        }
        const window = await pageSubjectPageCandidates(config.pool, config.tokens, {
          partition,
          size: limit,
          clock: config.clock,
          ...(sourceCursor ? { cursor: sourceCursor } : {}),
        });
        const subjectPages: (PublicationEntry & { target: PublicSubjectPageCandidate['target']; views: string[] })[] =
          [];
        // Every raw key, including rejected/duplicate work, belongs to the original candidate window.
        for (let offset = 0; offset < window.candidates.length; offset += 100) {
          const batch = window.candidates.slice(offset, offset + 100);
          const navigation = await preparePublicSubjectPageCandidates(
            { ...config, actor: { kind: 'anonymous' }, deadline: deadlineFor(2000) },
            batch.map((subject) => subject.id),
          );
          const entries: PublicationEntry[] = [];
          for (const subject of batch) {
            const entry = await store.readCurrent(subject);
            if (entry) entries.push(entry);
            else {
              const snapshot = await store.read(subject);
              if (!snapshot || snapshot.readiness !== 'ready') await config.publication.requestRebuild(subject);
            }
          }
          const current = await navigation.finish();
          for (const entry of entries) {
            const candidate = current.get(entry.id);
            if (candidate) subjectPages.push({ ...entry, target: candidate.target, views: [...candidate.views] });
          }
        }
        const next =
          window.next !== null || partition < 4095
            ? encodeCursor(
                config.tokens,
                binding,
                {
                  epoch: window.component.epoch,
                  after: window.next === null ? [partition + 1, ''] : [partition, window.next],
                },
                config.clock().getTime(),
              )
            : null;
        return { subjectPages, next };
      });
    },
  };
}
export type SubjectPageFeed = ReturnType<typeof createSubjectPageFeed>;
