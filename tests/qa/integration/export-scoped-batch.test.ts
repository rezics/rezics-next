import { expect, test } from 'bun:test';
import { LIBRARY_EXPORT_COST } from '../../../services/main/src/modules/library-export/bundle.ts';
import { PERSONAL_EVIDENCE_COST } from '../../../services/main/src/modules/export/personal-evidence.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { scopedExportFixture, type Page } from './export-scoped-support.ts';
import { RV } from './scoped-judgments-support.ts';

test('personal export hydrates a full scoped-rating page in bounded owner and projection batches', async () => {
  const f = await scopedExportFixture();
  try {
    const acceptedSubjectTypes = [
      `${RV}Character`,
      ...Array.from(
        { length: 31 },
        (_, index) => `https://example.org/type-${index}/${'界'.repeat(460)}`,
      ),
    ];
    // More than one page, with distinct Contexts and projections. The
    // requested page size must remain the export page size, not one opinion.
    for (let index = 0; index < 20; index++) {
      const context = await f.question({ acceptedSubjectTypes });
      const subject = await f.semantic(`Personal export subject ${index}`);
      const projection = await f.project(subject, [f.work.work]);
      await f.grant(f.owner, `rating:observe:${context.context}`, 'rating.observation.set');
      await f.json(
        await f.call(
          f.owner,
          'POST',
          '/v1/rating-observations',
          f.ratingBody(f.owner, context.context, projection.id, (index % 10) + 1),
        ),
        201,
      );
    }
    const query = f.stack.fuseki.query.bind(f.stack.fuseki),
      probes: string[] = [],
      batchBytes: number[] = [];
    f.stack.fuseki.query = (body, bytes) => {
      probes.push(body);
      return query(body, bytes).then((result) => {
        if (body.includes('AS ?ownerExportProbe'))
          batchBytes.push(Buffer.byteLength(JSON.stringify(result)));
        return result;
      });
    };
    const first = await f.json<Page>(await f.libraryPage());
    expect(first.rows.filter((row) => row.raw.annotation)).toHaveLength(LIBRARY_EXPORT_COST.page);
    expect(probes.length).toBeLessThan(LIBRARY_EXPORT_COST.graphPerPage);
    expect(probes.filter((body) => body.includes('AS ?ownerExportProbe'))).toHaveLength(
      PERSONAL_EVIDENCE_COST.graphBatches,
    );
    expect(Math.max(...batchBytes)).toBeGreaterThan(WORK_READ_COST.queryBytes);
    expect(batchBytes.reduce((total, bytes) => total + bytes, 0)).toBeLessThan(
      WORK_READ_COST.graphBytes,
    );
    expect(
      probes.filter((body) => body.includes('SELECT ?resource ?revision ?subject ?frame')),
    ).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    probes.length = 0;
    const second = await f.json<Page>(await f.libraryPage(first.nextCursor, first.snapshot));
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.rows, ...second.rows].map((row) => row.raw.observationRevision)).size,
    ).toBe(21);
    const retry = await f.json<Page>(await f.libraryPage(first.nextCursor, first.snapshot));
    expect(retry.rows).toEqual(second.rows);
  } finally {
    await f.stop();
  }
}, 180_000);
