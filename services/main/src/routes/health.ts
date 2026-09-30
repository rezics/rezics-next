import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { assertCommandProfiles } from '../infrastructure/profile.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { assertPublicTextReady } from '../modules/work/search-readiness.ts';
import { assertPublicContentSearchReady } from '../modules/content-publication/search.ts';
import { mainSchemaReady } from '../schema-ready.ts';
import type { MainWorkDependencies } from './dependencies.ts';

export function healthRoutes(fuseki: FusekiClient, work?: MainWorkDependencies) {
  return new Elysia()
    .get('/health/live', {
      response: t.Object({ status: t.Literal('ok') }),
    }, () => ({ status: 'ok' as const }))
    .get('/health/ready', {
      response: {
        200: t.Object({ status: t.Literal('ready') }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      try {
        const result = await fuseki.query('ASK {}');
        if (result.boolean !== true) throw new Error('unexpected Fuseki result');
        if (process.env.NODE_ENV === 'production') await mainSchemaReady();
        if (work) {
          await assertCommandProfiles(fuseki);
          await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        }
        return { status: 'ready' as const };
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
