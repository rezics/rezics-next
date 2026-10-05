import { expect, test } from 'bun:test';
import { GRAPHS } from '../../../services/main/src/modules/work/activate.ts';
import { scopedExportFixture, type Page } from './export-scoped-support.ts';
import type { Opinion } from './scoped-judgments-support.ts';

test('personal export keeps an erased own rating as a rating_unavailable residual', async () => {
  const f = await scopedExportFixture();
  try {
    const kept = await f.question();
    await f.grant(f.owner, `rating:observe:${kept.context}`, 'rating.observation.set');
    const live = await f.json<Opinion>(
      await f.call(
        f.owner,
        'POST',
        '/v1/rating-observations',
        f.ratingBody(f.owner, kept.context, f.projection.id, 6),
      ),
      201,
    );
    // The person's head still names this revision; only its body is erased.
    await f.stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <${GRAPHS.revisions}> { <${f.own.observationRevision}> a rv:ErasedRevision } }`);
    const rows: Page['rows'] = [];
    let cursor: string | null = null;
    let snapshot: string | undefined;
    do {
      const page = await f.json<Page>(await f.libraryPage(cursor, snapshot));
      snapshot ??= page.snapshot;
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    const erased = rows.find((row) => row.raw.observationRevision === f.own.observationRevision);
    expect(erased).toMatchObject({
      kind: 'retained',
      target: f.projection.id,
      raw: {
        ratingContext: f.context.context,
        observationRevision: f.own.observationRevision,
        residuals: [expect.objectContaining({ kind: 'rating_unavailable' })],
      },
    });
    expect(erased?.raw).not.toHaveProperty('annotation');
    expect(erased?.raw).not.toHaveProperty('ratingValue');
    expect(
      rows.find((row) => row.raw.observationRevision === live.observationRevision)?.raw,
    ).toMatchObject({
      ratingAvailability: 'available',
      ratingValue: 6,
      annotation: { 'oa:hasBody': { 'rv:value': 6 } },
    });
  } finally {
    await f.stop();
  }
}, 180_000);
