import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri } from '../modules/work/activate.ts';
import { createAdmittedTextContribution } from '../modules/contribution/create-admitted.ts';
import { readExactContributionDraft } from '../modules/contribution/history.ts';
import { editAdmittedTextContribution } from '../modules/contribution/edit-admitted.ts';
import { EmptyTextPublicationBody } from '../modules/contribution/publish.ts';
import { publishAdmittedTextContribution } from '../modules/contribution/publish-admitted.ts';
import { StaleContributionDraftHead } from '../modules/contribution/edit.ts';
import { readContributionHead } from '../modules/studio/contribution-head.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, contributionDraftReadResult, contributionEditWriteResult,
  contributionPublicationWriteResult, contributionWriteResult, writeProblems }
  from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { authoredBodySchema } from '../api-document.ts';
import type { DocumentSnapshot } from '@rezics/document';
import { readWorkContributions } from '../modules/contribution/list.ts';
import { pageFields, pageQuery, readId, readUuid } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export function contributionRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/works/:id/contributions', {
      params: t.Object({ id: readUuid }),
      query: t.Object({ ...pageQuery, actingSubject: readId }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/contributions"].get, { 200: t.Object({ items: t.Array(t.Object({ contribution: readId, work: readId,
        language: t.String(), author: readId, draftHead: readId, publicationHead: t.Nullable(readId) }),
      { maxItems: 20 }), ...pageFields, complete: t.Boolean() }), ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, { ...query, localBasis: true },
          session => readWorkContributions(session, `https://rezics.com/id/${params.id}`)),
        { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return workReadError(error); }
    })
    .get('/v1/contributions/:contribution', {
      params: t.Object({ contribution: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/contributions/{contribution}"].get, { 200: t.Object({ contribution: t.String(), work: t.String(),
        language: t.String(), author: t.String(), draftHead: t.String(),
        publicationHead: t.Nullable(t.String()) }), ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const contribution = `https://rezics.com/id/${params.contribution}`;
        if (!await work.access.canReadContributionDraft(principal, query.actingSubject, contribution)) {
          return problem(404, 'contribution_unavailable', 'Contribution is unavailable');
        }
        const head = await readContributionHead(work.environment, contribution);
        if (!head) return problem(404, 'contribution_unavailable', 'Contribution is unavailable');
        return Response.json(head, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/contribution-publications', {
      body: t.Object({
        profile: t.Literal('text-publication-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedDraftHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedPublicationHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        rightsBasis: t.Literal('original-contribution'),
        disclosure: t.Literal('public'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/contribution-publications"].post, { 200: contributionPublicationWriteResult,
        201: contributionPublicationWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) }, 'POST'),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await publishAdmittedTextContribution(work.environment, work.account,
          work.access, request, { contribution: body.contribution,
            expectedDraftHead: body.expectedDraftHead,
            expectedPublicationHead: body.expectedPublicationHead,
            rightsBasis: body.rightsBasis, disclosure: body.disclosure,
            actingSubject: body.actingSubject, idempotencyKey }, work.rights?.store);
        return Response.json({ contribution: receipt.contribution,
          publicationDecision: receipt.publicationDecision,
          selectedDraft: receipt.selectedDraft, predecessor: receipt.predecessor,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        if (error instanceof EmptyTextPublicationBody) return problem(422, 'empty_body', error.message);
        return commandError(error);
      }
    })
    .post('/v1/contribution-edits', {
      body: authoredBodySchema({
        profile: t.Literal('text-contribution-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }),
      response: transportResponses(openApiOperations["/v1/contribution-edits"].post, { 200: contributionEditWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await editAdmittedTextContribution(work.environment, work.account,
          work.access, request, { contribution: body.contribution, expectedHead: body.expectedHead,
            ...('document' in body ? { document: body.document as DocumentSnapshot } : { body: body.body }),
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          draftRevision: receipt.draftRevision, predecessor: receipt.expectedHead,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: 200, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        if (error instanceof StaleContributionDraftHead) {
          const head = await readContributionHead(work.environment, body.contribution);
          return problem(409, 'stale_head', 'Expected Contribution draft revision is stale',
            undefined, { currentHead: head?.draftHead ?? null });
        }
        return commandError(error);
      }
    })
    .post('/v1/contributions', {
      body: authoredBodySchema({
        profile: t.Literal('text-contribution-v1'),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        language: t.String({ minLength: 2, maxLength: 35,
          pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }),
      response: transportResponses(openApiOperations["/v1/contributions"].post, { 200: contributionWriteResult, 201: contributionWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedTextContribution(work.environment, work.account,
          work.access, request, { work: body.work, language: body.language,
            ...('document' in body ? { document: body.document as DocumentSnapshot } : { body: body.body }),
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          draftRevision: receipt.draftRevision, work: receipt.work,
          language: receipt.language, author: receipt.author,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/contributions/:contribution/drafts/:revision', {
      params: t.Object({ contribution: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/contributions/{contribution}/drafts/{revision}"].get, { 200: contributionDraftReadResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const contribution = `https://rezics.com/id/${params.contribution}`;
        // A baseline member's contribution proof is its own graph ASK. The exact-draft
        // budget counts only the current-Work ASK, the revision anchor, and the identity read.
        const readable = await work.access.canReadContributionDraft(
          principal, query.actingSubject, contribution);
        const revision = await readExactContributionDraft(work.environment, contribution,
          `https://rezics.com/id/${params.revision}`, async target => {
            if (!readable) return false;
            const current = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
              PREFIX schema: <https://schema.org/> ASK {
                GRAPH <urn:rezics:graph:current> {
                  ${iri(target)} a rv:TextContribution ; rv:work ?work .
                  ?work a schema:CreativeWork .
                }
              }`);
            return current.boolean === true;
          });
        return Response.json(revision, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}

export const openApiOperations = {
  '/v1/works/{id}/contributions': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/contributions/{contribution}/drafts/{revision}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/v1/contributions': { post: { exposure: 'public', rateLimitFamily: 'write' } },
  '/v1/contribution-edits': { post: { exposure: 'public', rateLimitFamily: 'write' } },
  '/v1/contribution-publications': { post: { exposure: 'public', rateLimitFamily: 'write' } },
  '/v1/contributions/{contribution}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
} as const;
