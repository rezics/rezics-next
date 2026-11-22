import { t } from 'elysia';
import type { Pool } from 'pg';
import { PLATFORM_RESOURCE } from '../access/bootstrap-governance.ts';
import type { createApp } from '../http/app.ts';
import { customMethod, defineRateLimit } from '../http/route-metadata.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { problemSchema, ProblemError } from '../http/problem.ts';
import { AuthenticationError } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { getLauncherPackage, getLauncherRelease, listLauncherPackages, listLauncherReleases } from './catalogue.ts';
import { publishLauncherRelease, withdrawLauncherRelease } from './commands.ts';
import {
  cataloguePackage,
  cataloguePage,
  catalogueRelease,
  packageId,
  packageQuery,
  publishedRelease,
  releaseQuery,
  releaseReference,
} from './contract.ts';

const packages = '/v1/launcher/packages';
const packagePath = `${packages}/:packageId`;
const releases = `${packagePath}/releases`;
const release = `${releases}/:releaseId`;

function readDetail(verb: 'list_packages' | 'read_package' | 'list_releases' | 'read_release') {
  return { operationId: `launcher.${verb}`, 'x-action': 'launcher:read', 'x-exposure': 'public', security: [{}] };
}

function writeDetail(verb: 'publish' | 'withdraw') {
  return {
    operationId: `launcher.${verb}`,
    'x-action': `launcher:${verb}`,
    'x-exposure': 'gate:launcher_distribution',
    'x-authority-resource-types': ['semantic.context'],
    'x-authority-resource-id': PLATFORM_RESOURCE.id,
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
    security: [{ bearerAuth: [] }],
  };
}

export function launcherDistributionRoutes(
  app: ReturnType<typeof createApp>,
  config: { pool: Pool; clock: () => Date; tokens: KeyRing },
) {
  const packageParams = t.Object({ packageId }, { additionalProperties: false });
  const failedRead = {
    400: problemSchema('invalid_request', 'invalid_cursor'),
    401: problemSchema('invalid_credentials'),
    404: problemSchema('not_found'),
    503: problemSchema('overloaded', 'deadline_exceeded', 'partition_unavailable', 'transaction_retry_exhausted'),
  };
  const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() });
  const failedWrite = {
    400: problemSchema('invalid_request'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden', 'platform_closed'),
    404: problemSchema('not_found'),
    409: problemSchema('conflict'),
    413: problemSchema('content_too_large'),
    422: problemSchema('idempotency_conflict'),
    429: problemSchema('rate_limited'),
    503: problemSchema(
      'overloaded',
      'deadline_exceeded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'rate_limit_unavailable',
    ),
  };
  return app
    .get(
      packages,
      {
        query: packageQuery,
        response: { 200: cataloguePage(cataloguePackage), ...failedRead },
        detail: readDetail('list_packages'),
      },
      async ({ query, job, admission, set }) => {
        set.headers['cache-control'] = 'no-store';
        return admission.run('normal', job, () => listLauncherPackages(config, query, job.deadline));
      },
    )
    .get(
      packagePath,
      { params: packageParams, response: { 200: cataloguePackage, ...failedRead }, detail: readDetail('read_package') },
      async ({ params, job, admission, set }) => {
        set.headers['cache-control'] = 'no-store';
        return admission.run('normal', job, () => getLauncherPackage(config, params.packageId, job.deadline));
      },
    )
    .get(
      releases,
      {
        params: packageParams,
        query: releaseQuery,
        response: { 200: cataloguePage(catalogueRelease), ...failedRead },
        detail: readDetail('list_releases'),
      },
      async ({ params, query, job, admission, set }) => {
        set.headers['cache-control'] = 'no-store';
        return admission.run('normal', job, () =>
          listLauncherReleases(config, params.packageId, query.cursor, job.deadline),
        );
      },
    )
    .get(
      release,
      {
        params: releaseReference,
        response: { 200: catalogueRelease, ...failedRead },
        detail: readDetail('read_release'),
      },
      async ({ params, job, admission, set }) => {
        set.headers['cache-control'] = 'no-store';
        return admission.run('normal', job, () =>
          getLauncherRelease(config, params.packageId, params.releaseId, job.deadline),
        );
      },
    )
    .post(
      releases,
      {
        headers,
        params: packageParams,
        body: publishedRelease,
        response: { 201: catalogueRelease, ...failedWrite },
        detail: { ...writeDetail('publish'), 'x-body-limit': 16_384 },
      },
      async ({ actor, headers, params, body, job, session, set, admission, authorizeCommand }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const authorization = await authorizeCommand(PLATFORM_RESOURCE, () => new ProblemError('forbidden'));
        const context = { actor, deadline: job.deadline, key, authorization };
        const outcome = await admission.run('normal', job, () =>
          publishLauncherRelease(config, context, params.packageId, body),
        );
        session.record(outcome);
        set.status = 201;
        return outcome.value;
      },
    )
    .post(
      customMethod(release, 'withdraw'),
      {
        headers,
        params: releaseReference,
        response: { 200: t.Object({ withdrawn: t.Literal(true) }, { additionalProperties: false }), ...failedWrite },
        detail: writeDetail('withdraw'),
      },
      async ({ actor, headers, params, job, session, admission, authorizeCommand }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const authorization = await authorizeCommand(PLATFORM_RESOURCE, () => new ProblemError('forbidden'));
        const context = { actor, deadline: job.deadline, key, authorization };
        const outcome = await admission.run('normal', job, () => withdrawLauncherRelease(config, context, params));
        session.record(outcome);
        return outcome.value;
      },
    );
}
