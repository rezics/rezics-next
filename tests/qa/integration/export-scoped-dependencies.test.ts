import { expect, test } from 'bun:test';
import { GRAPHS } from '../../../services/main/src/modules/work/activate.ts';
import { scopedExportFixture, type Page } from './export-scoped-support.ts';
import type { Opinion } from './scoped-judgments-support.ts';

test('personal export retains unavailable Context and private frame rows with residuals', async () => {
  const f = await scopedExportFixture();
  try {
    const another = await f.question();
    await f.grant(f.owner, `rating:observe:${another.context}`, 'rating.observation.set');
    const own = await f.json<Opinion>(
      await f.call(
        f.owner,
        'POST',
        '/v1/rating-observations',
        f.ratingBody(f.owner, another.context, f.projection.id, 6),
      ),
      201,
    );
    const invalidContext = await f.question();
    await f.grant(f.owner, `rating:observe:${invalidContext.context}`, 'rating.observation.set');
    const invalid = await f.json<Opinion>(
      await f.call(
        f.owner,
        'POST',
        '/v1/rating-observations',
        f.ratingBody(f.owner, invalidContext.context, f.projection.id, 7),
      ),
      201,
    );
    // Owner fault: a retained personal rating outlives public Context availability.
    await f.stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <${GRAPHS.current}> {
        <${f.context.context}> rv:protectionHead <urn:rezics:test:private-context> .
        <${invalidContext.context}> rv:acceptedFrameDimension "invalid-dimension" .
      } }`);
    const unavailable = await f.json<Page>(await f.libraryPage());
    const row = unavailable.rows.find(
      (row) => row.raw.observationRevision === f.own.observationRevision,
    );
    expect(row).toMatchObject({
      target: f.projection.id,
      raw: {
        ratingContext: f.context.context,
        ratingAvailability: 'available',
        ratingValue: 8,
        residuals: [expect.objectContaining({ kind: 'context_unavailable' })],
      },
    });
    expect(row?.raw).not.toHaveProperty('annotation');
    expect(
      unavailable.rows.find((row) => row.raw.observationRevision === invalid.observationRevision)
        ?.raw,
    ).toMatchObject({
      ratingValue: 7,
      residuals: [expect.objectContaining({ kind: 'context_unavailable' })],
    });
    expect(
      unavailable.rows.find((row) => row.raw.observationRevision === own.observationRevision)?.raw
        .annotation,
    ).toMatchObject({ 'oa:hasBody': { 'rv:value': 6 } });
    await f.stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <${GRAPHS.current}> { <${f.work.work}> rv:protectionHead <urn:rezics:test:private-frame> } }`);
    const privateFrame = await f.json<Page>(await f.libraryPage());
    const retained = privateFrame.rows.find(
      (row) => row.raw.observationRevision === own.observationRevision,
    );
    expect(retained?.raw).toMatchObject({
      annotation: { 'oa:hasTarget': { id: f.projection.id }, 'oa:hasBody': { 'rv:value': 6 } },
      residuals: [expect.objectContaining({ kind: 'private_dependency' })],
    });
    expect(JSON.stringify(retained)).not.toContain(f.subject);
    expect(JSON.stringify(retained)).not.toContain(f.work.work);
  } finally {
    await f.stop();
  }
}, 180_000);
