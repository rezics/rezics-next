import { withHeaders } from '@elysia/openapi';
import { AuthenticationError } from '../access/contract/authentication.ts';
import { customMethod } from '../http/route-metadata.ts';
import type { hostedPublicationActivationRoutes } from './hosted-publication-preparation-routes.ts';
import type { HostedCommandDependencies } from './hosted-chapters-commands.ts';
import { bindHostedChapterLanguage } from './hosted-chapter-language-commands.ts';
import { listHostedChapterLanguages } from './hosted-chapter-languages.ts';
import { resolveHostedOccurrenceBody } from './hosted-chapters-reads.ts';
import { strictContentSchema } from './schema-validation.ts';
import { HostedCommandSchema } from './hosted-chapters-schemas.ts';
import {
  HostedBindChapterLanguageSchema,
  HostedChapterLanguagesPageSchema,
  HostedChapterLanguagesQuerySchema,
  HostedLanguageOccurrenceQuerySchema,
  HostedOccurrenceBodySchema,
} from './hosted-chapter-language-schemas.ts';
import {
  commandContext,
  failures,
  headers,
  occurrenceParams,
  operation,
  readDetail,
  responseHeaders,
  writeDetail,
} from './hosted-chapter-http.ts';

export function hostedChapterLanguageRoutes(
  app: ReturnType<typeof hostedPublicationActivationRoutes>,
  deps: HostedCommandDependencies,
) {
  return app
    .post(
      customMethod('/v1/hostedCatalogues/:id/occurrences/:occurrenceId', 'bindLanguage'),
      {
        params: occurrenceParams(),
        headers,
        body: strictContentSchema(HostedBindChapterLanguageSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.bind_chapter_language' },
      },
      async ({ actor, params: { id, occurrenceId }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            bindHostedChapterLanguage(deps, actor, id, occurrenceId, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .get(
      '/v1/hostedCatalogues/:id/occurrences/:occurrenceId/languages',
      {
        params: occurrenceParams(),
        query: strictContentSchema(HostedChapterLanguagesQuerySchema),
        response: {
          200: withHeaders(strictContentSchema(HostedChapterLanguagesPageSchema), responseHeaders),
          ...failures(),
        },
        detail: { ...readDetail, operationId: 'hosted_catalogue.occurrence_languages' },
      },
      async ({ actor, params: { id, occurrenceId }, query, admission, job, session, set }) => {
        const { limit, ...selection } = query;
        const result = await operation(() =>
          admission.run('normal', job, () =>
            listHostedChapterLanguages(
              deps,
              id,
              occurrenceId,
              { ...selection, ...(limit === undefined ? {} : { limit: Number(limit) }) },
              { actor, deadline: job.deadline },
            ),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return { ...result.value, items: [...result.value.items] };
      },
    )
    .get(
      '/v1/hostedCatalogues/:id/occurrences/:occurrenceId/body',
      {
        params: occurrenceParams(),
        query: strictContentSchema(HostedLanguageOccurrenceQuerySchema),
        response: { 200: withHeaders(strictContentSchema(HostedOccurrenceBodySchema), responseHeaders), ...failures() },
        detail: { ...readDetail, operationId: 'hosted_catalogue.occurrence_body' },
      },
      async ({ actor, params: { id, occurrenceId }, query, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () =>
            resolveHostedOccurrenceBody(deps, id, occurrenceId, query, { actor, deadline: job.deadline }),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    );
}
