import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { assertCommandProfiles } from '../infrastructure/profile.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { assertPublicTextReady } from '../modules/work/search-readiness.ts';
import { assertPublicContentSearchReady } from '../modules/content-publication/search.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { mainSchemaReady } from '../schema-ready.ts';

export function healthRoutes(fuseki: FusekiClient, work?: MainWorkDependencies) {
  return new Elysia()
    .get('/health/live', {
      response: t.Object({ status: t.Literal('ok') }),
    }, () => ({ status: 'ok' as const }))
    .get('/health/ready', {
      response: {
        200: t.Object({ status: t.Literal('ready'), storage: t.Literal('ready'),
          schemaHeads: t.Record(t.String(), t.String()), dataEpoch: t.Optional(t.String()),
          indexGeneration: t.Optional(t.String()) }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      try {
        const result = await fuseki.query('ASK {}');
        if (result.boolean !== true) throw new Error('unexpected Fuseki result');
        const schema = await mainSchemaReady();
        let dataEpoch: string | undefined;
        let indexGeneration: string | undefined;
        if (work) {
          await assertCommandProfiles(fuseki);
          await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
          if (work.contentProjection) {
            const { content, cursor, consumer } = work.contentProjection;
            const projection = await assertPublicContentSearchReady(work.environment, content, cursor, consumer);
            dataEpoch = projection.graphPosition.dataEpoch;
            indexGeneration = projection.indexGeneration;
          } else {
            const index = await assertPublicTextReady(fuseki, work.environment.lineage);
            dataEpoch = index.dataEpoch;
            indexGeneration = index.generation;
          }
        } else if (process.env.NODE_ENV === 'production') {
          throw new Error('Graph lineage is required');
        }
        return { status: 'ready' as const, ...schema, dataEpoch, indexGeneration };
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    })
    .get('/health/search-ready', {
      response: {
        200: t.Object({ status: t.Literal('ready'), dataEpoch: t.String(),
          sequence: t.String(), indexGeneration: t.String() }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      if (!work) return status(503, { status: 'unavailable' as const });
      try {
        if (work.contentProjection) {
          const { content, cursor, consumer } = work.contentProjection;
          const projection = await assertPublicContentSearchReady(work.environment, content, cursor, consumer);
          return { status: 'ready' as const, dataEpoch: projection.graphPosition.dataEpoch,
            sequence: projection.graphPosition.sequence, indexGeneration: projection.indexGeneration };
        }
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const index = await assertPublicTextReady(fuseki, work.environment.lineage);
        return { status: 'ready' as const, dataEpoch: index.dataEpoch,
          sequence: index.sequence, indexGeneration: index.generation };
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    });
}
