import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri } from '../modules/work/activate.ts';
import { createAdmittedTextContribution } from '../modules/contribution/create-admitted.ts';
import { readExactContributionDraft } from '../modules/contribution/history.ts';
import { editAdmittedTextContribution } from '../modules/contribution/edit-admitted.ts';
import { publishAdmittedTextContribution } from '../modules/contribution/publish-admitted.ts';
import { StaleContributionDraftHead } from '../modules/contribution/edit.ts';
import { readContributionHead } from '../modules/studio/contribution-head.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, contributionDraftReadResult, contributionEditWriteResult,
  contributionPublicationWriteResult, contributionWriteResult, writeProblems }
  from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export function contributionRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/contributions/:contribution', {
      params: t.Object({ contribution: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: t.Object({ contribution: t.String(), work: t.String(),
        language: t.String(), author: t.String(), draftHead: t.String(),
        publicationHead: t.Nullable(t.String()) }), ...authorizedReadProblems },
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
      response: { 200: contributionPublicationWriteResult,
        201: contributionPublicationWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) },
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
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          publicationDecision: receipt.publicationDecision,
          selectedDraft: receipt.selectedDraft, predecessor: receipt.predecessor,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/contribution-edits', {
      body: t.Object({
        profile: t.Literal('text-contribution-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        body: t.String({ minLength: 1, maxLength: 65536 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contributionEditWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await editAdmittedTextContribution(work.environment, work.account,
          work.access, request, { contribution: body.contribution, expectedHead: body.expectedHead,
            body: body.body, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          draftRevision: receipt.draftRevision, predecessor: receipt.expectedHead,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: 200, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        if (error instanceof StaleContributionDraftHead) {
          const head = await readContributionHead(work.environment, body.contribution);
          return Response.json({ type: 'https://rezics.com/problems/stale_head',
            title: 'Expected Contribution draft revision is stale', status: 409,
            code: 'stale_head', currentHead: head?.draftHead ?? null,
          }, { status: 409, headers: { 'cache-control': 'no-store' } });
        }
        return commandError(error);
      }
    })
    .post('/v1/contributions', {
      body: t.Object({
        profile: t.Literal('text-contribution-v1'),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        language: t.String({ minLength: 2, maxLength: 35,
          pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }),
        body: t.String({ minLength: 1, maxLength: 65536 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contributionWriteResult, 201: contributionWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedTextContribution(work.environment, work.account,
          work.access, request, { work: body.work, language: body.language,
            body: body.body, actingSubject: body.actingSubject, idempotencyKey });
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
      response: { 200: contributionDraftReadResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const contribution = `https://rezics.com/id/${params.contribution}`;
        const revision = await readExactContributionDraft(work.environment, contribution,
          `https://rezics.com/id/${params.revision}`, async target => {
            if (!await work.access.canReadContributionDraft(
              principal, query.actingSubject, target)) return false;
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
