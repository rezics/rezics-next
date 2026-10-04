import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { LibraryBundleExporter } from '../../../services/main/src/modules/library-export/bundle.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import type { CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import type { ExportPlan } from '../../../services/main/src/modules/export/planner.ts';
import { GRAPHS } from '../../../services/main/src/modules/work/activate.ts';
import { scopedJudgmentsFixture, nativeId } from './scoped-judgments-support.ts';

test('scoped exports preserve exact projection coordinates, withheld aggregates and private owner annotations', async () => {
  const f = await scopedJudgmentsFixture();
  try {
    const people = [f.owner, f.outsider];
    const app = createMainApp(f.stack.fuseki, {
      environment: f.stack.env,
      access: f.stack.access,
      content: f.stack.content,
      media: f.stack.media,
      mediaAccess: f.stack.mediaAccess,
      account: {
        verify: async (request) => {
          const person = people.find(
            (person) => request.headers.get('authorization') === `Bearer ${person.token}`,
          );
          if (!person) throw new Error('Unknown test principal');
          const principal = { ...person.principal, emailVerified: true };
          return { ...principal, currentAssertion: async () => principal };
        },
      },
      exports: new ExportStore(f.stack.contentPool),
      libraryBundle: new LibraryBundleExporter(f.stack.contentPool, f.stack.accessPool),
      targetRatingInventory: new TargetRatingInventoryStore(f.stack.accessPool),
    });
    const call = (
      person: typeof f.owner,
      method: string,
      path: string,
      body?: object,
      key = crypto.randomUUID(),
    ) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            authorization: `Bearer ${person.token}`,
            'idempotency-key': key,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const subject = await f.semantic('Subject of scoped exports');
    const projection = await f.project(subject, [f.work.work]);
    const context = await f.question();
    for (const person of people)
      await f.grant(person, `rating:observe:${context.context}`, 'rating.observation.set');
    const own = await f.json<{ observationRevision: string; observation: string }>(
      await f.call(
        f.owner,
        'POST',
        '/v1/rating-observations',
        f.ratingBody(f.owner, context.context, projection.id, 8),
      ),
      201,
    );
    const other = await f.json<{ observationRevision: string }>(
      await f.call(
        f.outsider,
        'POST',
        '/v1/rating-observations',
        f.ratingBody(f.outsider, context.context, projection.id, 3),
      ),
      201,
    );
    const secondContext = await f.question();
    await f.grant(f.owner, `rating:observe:${secondContext.context}`, 'rating.observation.set');
    await f.json(
      await f.call(
        f.owner,
        'POST',
        '/v1/rating-observations',
        f.ratingBody(f.owner, secondContext.context, projection.id, 6),
      ),
      201,
    );
    const view = await f.json<{ items: Array<{ id: string; revision: string }> }>(
      await f.call(
        f.owner,
        'GET',
        `/v1/projections?subject=${encodeURIComponent(subject)}&actingSubject=${encodeURIComponent(f.owner.actor)}`,
      ),
    );
    expect(view.items).toContainEqual(expect.objectContaining({ id: projection.id }));
    // The projection's pin is its own revision position, independent of later ratings.
    const revisionRows =
      (
        await f.stack.fuseki
          .query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?epoch ?sequence WHERE {
      GRAPH <${GRAPHS.revisions}> { <${projection.revision}> rv:dataEpoch ?epoch ; rv:sequence ?sequence } }`)
      ).results?.bindings ?? [];
    const expectedPosition = {
      dataEpoch: revisionRows[0]!.epoch!.value,
      sequence: revisionRows[0]!.sequence!.value,
    };
    await f.grant(f.owner, `export:${projection.revision}`, 'export.create');
    type Manifest = { manifestId: string; plan: ExportPlan };
    const exported = await f.json<Manifest>(
      await call(f.owner, 'POST', '/v1/exports', {
        profile: 'export-create-v1',
        actingSubject: f.owner.actor,
        useScope: 'evaluation',
        selection: {
          kind: 'projection-revision',
          resource: projection.id,
          reference: projection.revision,
          expectedPosition,
        },
      }),
      201,
    );
    expect(exported.plan.members[0]!.data?.representation).toMatchObject({
      id: projection.id,
      'prov:specializationOf': { id: subject },
      'rv:frame': [{ 'rv:coordinate': { id: f.work.work }, 'rv:dimension': 'work' }],
    });
    expect((await call(f.owner, 'GET', `/v1/exports/${exported.manifestId}`)).status).toBe(200);
    expect((await call(f.outsider, 'GET', `/v1/exports/${exported.manifestId}`)).status).toBe(404);

    const aggregate = await f.json<{ sourcePosition: { dataEpoch: string; sequence: string } }>(
      await f.call(f.owner, 'POST', '/v1/rating-aggregates', {
        profile: 'realm-target-latest-mean-v1',
        context: context.context,
        target: projection.id,
        actingSubject: f.owner.actor,
      }),
    );
    await f.grant(f.owner, `export:${context.context}`, 'export.create');
    const aggregateExport = await f.json<Manifest>(
      await call(f.owner, 'POST', '/v1/exports', {
        profile: 'export-create-v1',
        actingSubject: f.owner.actor,
        useScope: 'evaluation',
        selection: {
          kind: 'rating-aggregate',
          reference: context.context,
          target: projection.id,
          expectedPosition: {
            dataEpoch: aggregate.sourcePosition.dataEpoch,
            sequence: aggregate.sourcePosition.sequence,
          },
        },
      }),
      201,
    );
    expect(aggregateExport.plan.members[0]!.data?.representation).toMatchObject({
      type: 'dqv:QualityMeasurement',
      'dqv:computedOn': { id: projection.id },
      'rv:count': 2,
      'rv:displayThreshold': 10,
    });
    expect(aggregateExport.plan.members[0]!.data?.representation).not.toHaveProperty('dqv:value');
    expect(JSON.stringify(aggregateExport.plan)).not.toContain('"mean":');
    expect((await call(f.owner, 'GET', `/v1/exports/${aggregateExport.manifestId}`)).status).toBe(
      200,
    );
    const rollupExport = await f.json<Manifest>(
      await call(f.owner, 'POST', '/v1/exports', {
        profile: 'export-create-v1',
        actingSubject: f.owner.actor,
        useScope: 'evaluation',
        selection: {
          kind: 'rating-rollup',
          reference: context.context,
          targets: [projection.id, nativeId()],
          formula: 'pooled',
          expectedPosition: {
            dataEpoch: aggregate.sourcePosition.dataEpoch,
            sequence: aggregate.sourcePosition.sequence,
          },
        },
      }),
      201,
    );
    expect(rollupExport.plan.members[0]!.data?.representation).toMatchObject({
      'rv:origin': 'derived',
      'rv:formula': 'pooled',
      'rv:coverage': { members: 2, available: 1, meetingThreshold: 0 },
    });
    expect(rollupExport.plan.members[0]!.data?.representation).not.toHaveProperty('dqv:value');
    expect(rollupExport.plan.residuals).toContainEqual(
      expect.objectContaining({ kind: 'unavailable' }),
    );
    expect((await call(f.owner, 'GET', `/v1/exports/${rollupExport.manifestId}`)).status).toBe(200);
    expect(
      (
        await call(f.owner, 'POST', '/v1/exports', {
          profile: 'export-create-v1',
          actingSubject: f.owner.actor,
          useScope: 'evaluation',
          selection: {
            kind: 'projection-revision',
            resource: projection.id,
            reference: projection.revision,
            expectedPosition: { ...expectedPosition, sequence: '0' },
          },
        })
      ).status,
    ).toBe(409);

    type Page = { rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
    const page = (person = f.owner, cursor?: string | null, snapshot?: string) =>
      call(
        person,
        'GET',
        `/v1/me/library-export?${new URLSearchParams({
          actingSubject: person.actor,
          limit: '1',
          ...(cursor ? { cursor } : {}),
          ...(snapshot ? { snapshot } : {}),
        })}`,
      );
    const first = await f.json<Page>(await page());
    const rows = [...first.rows];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await f.json<Page>(await page(f.owner, cursor, first.snapshot));
      rows.push(...next.rows);
      cursor = next.nextCursor;
    }
    expect(rows.filter((row) => row.raw.annotation)).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const annotation = rows.find((row) => row.raw.observationRevision === own.observationRevision)
      ?.raw.annotation;
    expect(annotation).toMatchObject({
      id: own.observationRevision,
      type: 'oa:Annotation',
      'oa:hasTarget': { id: projection.id, 'prov:specializationOf': { id: subject } },
      'oa:hasBody': { 'rv:value': 8, 'rv:scale': { min: 1, max: 10, step: 1 } },
    });
    expect(JSON.stringify(rows)).not.toContain(other.observationRevision);
    expect(
      (
        await call(
          f.outsider,
          'GET',
          `/v1/me/library-export?actingSubject=${encodeURIComponent(f.owner.actor)}`,
        )
      ).status,
    ).toBe(403);
    const foreign = await f.json<Page>(await page(f.outsider));
    expect(JSON.stringify(foreign.rows)).not.toContain(own.observationRevision);
    await f.json(
      await f.call(
        f.owner,
        'POST',
        '/v1/rating-observations',
        f.ratingBody(f.owner, context.context, projection.id, 9, own.observationRevision),
      ),
      201,
    );
    expect((await page(f.owner, first.nextCursor, first.snapshot)).status).toBe(409);
  } finally {
    await f.stop();
  }
}, 180_000);
