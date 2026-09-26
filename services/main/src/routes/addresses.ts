import { Elysia, t } from 'elysia';
import { claimAdmittedWorkAddress } from '../modules/address/claim-admitted.ts';
import { renameAdmittedWorkAddress } from '../modules/address/rename-admitted.ts';
import { disposeAdmittedWorkAddress } from '../modules/address/dispose-admitted.ts';
import { exactWorkRoute, resolveWorkRoute, reverseWorkAddress }
  from '../modules/address/resolution.ts';
import { pendingOperation } from '../api-contract.ts';
import { readProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupGeneration, groupUuid } from './shared.ts';

const addressSlug = t.String({ minLength: 1, maxLength: 64,
  pattern: '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$' });

const addressClaimBody = t.Object({ profile: t.Literal('work-address-claim-v1'),
  work: groupAgent, slug: addressSlug, actingSubject: groupAgent },
{ additionalProperties: false });

const addressResult = t.Object({ profile: t.Literal('work-address-v1'),
  state: t.Literal('current'),
  namespace: t.Literal('work'), normalization: t.Literal('ascii-lower-v1'),
  slug: t.String(), address: groupAgent, revision: groupAgent, work: groupAgent,
  mainVersion: groupAgent });

const addressRedirectResult = t.Object({ profile: t.Literal('work-address-redirect-v1'),
  state: t.Literal('redirected'), namespace: t.Literal('work'),
  normalization: t.Literal('ascii-lower-v1'), slug: t.String(), address: groupAgent,
  revision: groupAgent, originalWork: groupAgent, targetWork: groupAgent,
  canonical: t.Object({ address: groupAgent, revision: groupAgent,
    slug: t.String(), href: t.String() }) });

const addressRetiredResult = t.Object({ profile: t.Literal('work-address-retired-v1'),
  state: t.Literal('retired'), namespace: t.Literal('work'),
  normalization: t.Literal('ascii-lower-v1'), slug: t.String(), address: groupAgent,
  revision: groupAgent, originalWork: groupAgent });

const addressReverseResult = t.Object({ profile: t.Literal('work-address-reverse-v1'),
  namespace: t.Literal('work'), work: groupAgent, mainVersion: groupAgent,
  canonical: t.Union([t.Null(), t.Object({ address: groupAgent, revision: groupAgent,
    slug: t.String(), href: t.String() })]) });

const addressExactResult = t.Object({ profile: t.Literal('work-address-revision-v1'),
  namespace: t.Literal('work'), normalization: t.Literal('ascii-lower-v1'),
  slug: t.String(), address: groupAgent, revision: groupAgent, work: groupAgent,
  state: t.Union([t.Literal('current'), t.Literal('redirected'), t.Literal('retired')]),
  redirectWork: t.Optional(groupAgent),
  disposition: t.Optional(t.Union([t.Literal('merged'), t.Literal('retired')])) });

const addressClaimResult = t.Object({ profile: t.Literal('work-address-claim-v1'),
  namespace: t.Literal('work'), normalization: t.Literal('ascii-lower-v1'),
  slug: t.String(), address: groupAgent, revision: groupAgent, work: groupAgent,
  sourcePosition: t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(),
    sequence: groupGeneration }), replayed: t.Boolean() });

const addressRenameBody = t.Object({ profile: t.Literal('work-address-rename-v1'),
  work: groupAgent, slug: addressSlug, newSlug: addressSlug,
  expectedRevision: groupAgent, actingSubject: groupAgent }, { additionalProperties: false });

const addressRenameResult = t.Object({ profile: t.Literal('work-address-rename-v1'),
  namespace: t.Literal('work'), normalization: t.Literal('ascii-lower-v1'),
  oldSlug: t.String(), slug: t.String(), sourceAddress: groupAgent,
  sourceRevision: groupAgent, address: groupAgent, revision: groupAgent,
  work: groupAgent, sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: groupGeneration }), replayed: t.Boolean() });

const addressDispositionBody = t.Union([
  t.Object({ profile: t.Literal('work-address-disposition-v1'),
    operation: t.Literal('merge'), work: groupAgent, slug: addressSlug,
    expectedRevision: groupAgent, targetWork: groupAgent, actingSubject: groupAgent },
  { additionalProperties: false }),
  t.Object({ profile: t.Literal('work-address-disposition-v1'),
    operation: t.Literal('retire'), work: groupAgent, slug: addressSlug,
    expectedRevision: groupAgent, actingSubject: groupAgent },
  { additionalProperties: false }),
]);

const addressDispositionResult = t.Object({ profile: t.Literal('work-address-disposition-v1'),
  operation: t.Union([t.Literal('merge'), t.Literal('retire')]),
  namespace: t.Literal('work'), slug: t.String(), sourceAddress: groupAgent,
  revision: groupAgent, work: groupAgent, targetWork: t.Optional(groupAgent),
  sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: groupGeneration }), replayed: t.Boolean() });

export function addressRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/addresses/claims', {
      body: addressClaimBody,
      response: { 200: addressClaimResult, 201: addressClaimResult,
        202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await claimAdmittedWorkAddress(work.environment,
          work.account, work.access, request, { work: body.work, slug: body.slug,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ profile: 'work-address-claim-v1', namespace: 'work',
          normalization: 'ascii-lower-v1', slug: receipt.slug,
          address: receipt.address, revision: receipt.revision, work: receipt.work,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/addresses/renames', {
      body: addressRenameBody,
      response: { 200: addressRenameResult, 201: addressRenameResult,
        202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await renameAdmittedWorkAddress(work.environment,
          work.account, work.access, request, { work: body.work, slug: body.slug,
            newSlug: body.newSlug, expectedRevision: body.expectedRevision,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ profile: 'work-address-rename-v1', namespace: 'work',
          normalization: 'ascii-lower-v1', oldSlug: receipt.oldSlug, slug: receipt.slug,
          sourceAddress: receipt.sourceAddress, sourceRevision: receipt.sourceRevision,
          address: receipt.address, revision: receipt.revision, work: receipt.work,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/addresses/dispositions', {
      body: addressDispositionBody,
      response: { 200: addressDispositionResult, 201: addressDispositionResult,
        202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const input = { work: body.work, slug: body.slug,
          expectedRevision: body.expectedRevision, actingSubject: body.actingSubject,
          ...(body.operation === 'merge'
            ? { operation: 'merge' as const, targetWork: body.targetWork }
            : { operation: 'retire' as const }), idempotencyKey };
        const receipt = await disposeAdmittedWorkAddress(work.environment,
          work.account, work.access, request, input);
        return Response.json({ profile: 'work-address-disposition-v1',
          operation: receipt.operation, namespace: 'work', slug: receipt.slug,
          sourceAddress: receipt.sourceAddress, revision: receipt.revision,
          work: receipt.work, ...(receipt.targetWork ? { targetWork: receipt.targetWork } : {}),
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/addresses/work/:slug', {
      params: t.Object({ slug: addressSlug }),
      response: { 200: addressResult, 308: addressRedirectResult,
        410: addressRetiredResult, ...readProblems },
    }, async ({ params }) => {
      try {
        const resolved = await resolveWorkRoute(work.environment, params.slug);
        if (!resolved) return problem(404, 'address_not_found', 'Address is unavailable');
        if (resolved.state === 'retired') {
          return Response.json(resolved, { status: 410,
            headers: { 'cache-control': 'no-store' } });
        }
        if (resolved.state === 'redirected') {
          return Response.json(resolved, { status: 308, headers: {
            location: resolved.canonical.href, 'cache-control': 'no-store' } });
        }
        return Response.json(resolved, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/addresses/work/:slug/revisions/:revision', {
      params: t.Object({ slug: addressSlug, revision: groupUuid }),
      response: { 200: addressExactResult, ...readProblems },
    }, async ({ params }) => {
      try {
        const exact = await exactWorkRoute(work.environment, params.slug,
          `https://rezics.com/id/${params.revision}`);
        if (!exact) return problem(404, 'address_revision_not_found', 'Address revision is unavailable');
        return Response.json(exact, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/addresses', {
      params: t.Object({ id: groupUuid }),
      response: { 200: addressReverseResult, ...readProblems },
    }, async ({ params }) => {
      try {
        const result = await reverseWorkAddress(work.environment,
          `https://rezics.com/id/${params.id}`);
        if (!result) return problem(404, 'work_not_found', 'Work is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
