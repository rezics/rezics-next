import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { seed, type GrowthDatabase, type Population, type ReportSample } from '../support/growth.ts';
import { leafFixture, nativeRelease, routeKey } from './scope-leaf-evidence-fixture.ts';

// Exhausted continuation is the last public-issued next page (next is null); the public keyset never issues a 0-row cursor. Ineligible is hideSubject; missing is a routed unknown UUID; malformed cursor is PageCursorError before listing SQL.

export const pageLimit = 8;
export const scales = [1, 8, 64] as const;
export const historyPerScale = 32;
export const unrelatedPerScale = 128;
export const unrelatedSubjects = 8;
export const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
export const axes = ['history', 'unrelated'] as const;
export type GrowthAxis = (typeof axes)[number];

export type RevisionPage = {
  readonly revisions: readonly { readonly revision: number }[];
  readonly next: string | null;
};

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(91)]]) };

export async function revisionHistoryRefusalFixture(db: GrowthDatabase) {
  const leaf = await leafFixture(db.pool, db.admin);
  const kernel = createKernel({
    pool: db.pool,
    access: leaf.real.access,
    tokens,
    routeKey,
    writeRate: leaf.real.writeRate,
  });

  async function list(
    subject: string,
    options: { cursor?: string; bearer?: string | null; status?: number } = {},
  ): Promise<{ status: number; body: Record<string, any> }> {
    const headers: Record<string, string> = {};
    if (options.bearer !== null)
      headers.authorization = `Bearer ${options.bearer ?? leaf.real.bearer('reader')}`;
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const response = await kernel.handle(
      new Request(`http://kernel.test/v1/subjects/${subject}/revisions?${query}`, { method: 'GET', headers }),
    );
    const body = (await response.json()) as Record<string, any>;
    expect(response.status).toBe(options.status ?? 200);
    return { status: response.status, body };
  }

  async function growSelectedHistory(subject: string, previous: number, scale: number) {
    const previousRows = previous * historyPerScale;
    const currentRows = scale * historyPerScale;
    if (currentRows <= previousRows) return;
    const route = routeOf(subject);
    if (route === null) throw new Error('Selected subject route is missing');
    await db.admin.query(
      `INSERT INTO semantic.revision
           (route, subject_id, revision, kind, release, recorded_transaction_id, source)
         SELECT $1, $2, revision, 'propose', $3, gen_random_uuid(), NULL
         FROM generate_series($4::integer, $5::integer) AS revision`,
      [route, subject, nativeRelease.digest, previousRows + 2, currentRows + 1],
    );
  }

  function unrelatedPopulation(name: string, subjects: readonly string[], accountId: string): Population {
    const route = routeOf(subjects[0]!);
    if (route === null) throw new Error('Unrelated subject route is missing');
    return {
      name,
      hotPartition: partitionOf(route),
      hotShare: 1,
      rows: ({ ordinal }) => {
        const subject = subjects[ordinal % subjects.length]!;
        const subjectRoute = routeOf(subject)!;
        const revision = Math.floor(ordinal / subjects.length) + 2;
        const transaction = randomUUID();
        return {
          'semantic.revision': [
            {
              route: subjectRoute,
              subject_id: subject,
              revision,
              kind: 'propose',
              release: nativeRelease.digest,
              recorded_transaction_id: transaction,
              source: null,
            },
          ],
          'core.receipt': [
            {
              partition_no: partitionOf(subjectRoute),
              principal_kind: 'account',
              principal_id: accountId,
              command_kind: 'statement.propose',
              idempotency_key: `${name}-${ordinal}`,
              request_digest: createHash('sha256').update(`${name}-${ordinal}`).digest(),
              epoch: 1,
              position:
                1_500_000_000 +
                (createHash('sha256').update(name).digest().readUInt32BE(0) % 1_000_000) * 10_000 +
                ordinal,
              transaction_id: transaction,
              response: { subject, revision },
            },
          ],
        };
      },
    };
  }

  async function growUnrelated(name: string, subjects: readonly string[], previous: number, scale: number) {
    await seed(db, unrelatedPopulation(name, subjects, leaf.editor.accountId), {
      from: previous * unrelatedPerScale,
      to: scale * unrelatedPerScale,
    });
  }

  async function issuedPages(subject: string): Promise<readonly RevisionPage[]> {
    const pages: RevisionPage[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 10_000; step++) {
      const { body } = await list(subject, cursor === undefined ? {} : { cursor });
      const page = body as RevisionPage;
      expect(Array.isArray(page.revisions)).toBe(true);
      pages.push(page);
      if (page.next === null) return pages;
      cursor = page.next;
    }
    throw new Error('Public revision cursors did not exhaust');
  }

  function deepIssued(pages: readonly RevisionPage[]): { cursor: string; page: RevisionPage } {
    if (pages.length < 3) throw new Error('Deep revision page was not prepared');
    const index = Math.min(pages.length - 2, Math.max(1, Math.floor((pages.length - 1) * 0.75)));
    const cursor = pages[index - 1]?.next;
    if (typeof cursor !== 'string') throw new Error('Deep revision cursor was not issued');
    return { cursor, page: pages[index]! };
  }

  function exhaustedIssued(pages: readonly RevisionPage[]): { cursor: string; page: RevisionPage } {
    if (pages.length < 2) throw new Error('Exhausted revision page was not prepared');
    const cursor = pages.at(-2)?.next;
    if (typeof cursor !== 'string') throw new Error('Exhausted revision cursor was not issued');
    return { cursor, page: pages.at(-1)! };
  }

  return { leaf, list, growSelectedHistory, growUnrelated, issuedPages, deepIssued, exhaustedIssued };
}

export type RevisionHistoryRefusalFixture = Awaited<ReturnType<typeof revisionHistoryRefusalFixture>>;

export async function neighborhood(
  fixture: RevisionHistoryRefusalFixture,
): Promise<{ subject: string; unrelated: string[] }> {
  const subject = await fixture.leaf.create('schema:Book');
  const unrelated = await Promise.all(
    Array.from({ length: unrelatedSubjects }, () => fixture.leaf.create('schema:Book')),
  );
  return { subject, unrelated };
}

export function revisionListing(sample: ReportSample): readonly string[] {
  return sample.occurrenceRepetitions.flatMap((run) =>
    run.statements
      .filter(({ statement }) => /semantic\.revision/i.test(statement) && /revision\s*</i.test(statement))
      .map(({ statement }) => statement),
  );
}

export function reportGrowth(report: {
  readonly name: string;
  readonly samples: readonly ReportSample[];
}): void {
  console.info(
    `REVISION_HISTORY_REFUSAL_GROWTH ${JSON.stringify({
      name: report.name,
      samples: report.samples.map((sample) => ({
        scale: sample.scale,
        statements: sample.cost.statements,
        rows: sample.cost.rows,
        blocks: sample.cost.blocks,
        sharedHit: sample.cost.sharedHit,
        sharedRead: sample.cost.sharedRead,
        revision: sample.cost.relations['semantic.revision'],
        backgroundStatements: sample.cost.backgroundStatements,
        backgroundRows: sample.cost.backgroundRows,
        listings: revisionListing(sample).length,
      })),
    })}`,
  );
}

export function expectNoHistoryListing(sample: ReportSample): void {
  expect(sample.cost.relations['semantic.revision']).toBeUndefined();
  expect(revisionListing(sample)).toEqual([]);
}

export function expectHistoryPage(sample: ReportSample): void {
  const revision = sample.cost.relations['semantic.revision'];
  expect(revision).toBeDefined();
  expect(revision!.rows).toBeGreaterThan(0);
  expect(revision!.rows).toBeLessThanOrEqual(2 * (pageLimit + 1));
  expect(revisionListing(sample).length).toBeGreaterThan(0);
}

export { newId, routeOf };
