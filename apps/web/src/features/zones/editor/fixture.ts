import { createKernelClient } from '@rezics/client';
import type { Release } from '../../../subject/definitions';
import { staticZoneHomeFake } from '../../../zones/static-fakes';
import { collections, loadConfiguration, mutate, preview } from './api';
import type { Loaded, Transport, Visibility, ZoneConfigureInput, ZoneConfigurationResponse } from './model';

/** Contract-shaped fake API for isolated UI outcomes; it does not prove native authorization. */
export function zoneEditorFixture() {
  const id = staticZoneHomeFake.zone.id;
  const authorization = 'Bearer current-zone-reader';
  let resource: ZoneConfigurationResponse = {
    zone: {
      ...structuredClone(staticZoneHomeFake.zone),
      revision: '900719925474099312345',
      visibility: 'private',
      ownerId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99',
      deletedAt: null,
      restoreUntil: null,
    },
    configuration: {
      labels: structuredClone(staticZoneHomeFake.zone.labels),
      pages: [{ route: '', document: structuredClone(staticZoneHomeFake.document) }],
      scope: [],
    },
    mounts: [],
  };
  const release: Release = {
    digest: 'fixture-release',
    types: {},
    properties: {},
    filters: { 'books/fiction': { filter: { type: 'schema:Book' } } },
  };
  const calls: Pick<Request, 'url' | 'headers' | 'method' | 'json'>[] = [];
  const mode = {
    mutationStatus: 0,
    previewStatus: 200,
    readStatus: 200,
    configure: true,
    publish: true,
    actionsAvailable: true,
    actionsStatus: 200,
    optionsAvailable: true,
  };
  const receipts = new Map<string, { signature: string; value: ZoneConfigurationResponse['zone'] }>();
  function advance() {
    resource.zone.revision = (BigInt(resource.zone.revision) + 1n).toString();
  }
  function response(body: unknown, status = 200) {
    return Response.json(body, { status, headers: { 'cache-control': 'private, no-store', 'retry-after': '1' } });
  }
  function problem(status: number, code: string) {
    return response({ status, code }, status);
  }
  const client = createKernelClient('https://kernel.fixture.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      const url = new URL(request.url);
      if (request.headers.get('authorization') !== authorization) return problem(401, 'unauthorized');
      if (url.pathname === '/v1/zones' && request.method === 'POST') {
        const body = (await request.json()) as ZoneConfigureInput;
        resource.configuration = structuredClone(body.configuration);
        resource.mounts = [...body.mounts];
        resource.zone.labels = { ...body.configuration.labels };
        if (body.configuration.primaryLanguage) resource.zone.primaryLanguage = body.configuration.primaryLanguage;
        else delete resource.zone.primaryLanguage;
        resource.zone.revision = '1';
        return response({ zone: resource.zone }, 201);
      }
      if (url.pathname === '/v1/viewerActions' && mode.actionsStatus !== 200)
        return problem(mode.actionsStatus, 'invalid_request');
      if (url.pathname === '/v1/viewerActions')
        return mode.actionsAvailable
          ? response({
              resources: [
                {
                  type: 'semantic.zone',
                  id,
                  viewerActions: [
                    ...(mode.configure ? [{ action: 'zone:configure', operations: ['zone.configure'] }] : []),
                    ...(mode.publish ? [{ action: 'zone:publish', operations: ['zone.publish'] }] : []),
                  ],
                },
              ],
            })
          : problem(503, 'dependency_unavailable');
      if (url.pathname === '/v1/collections')
        return mode.optionsAvailable
          ? response({
              collections: [{ id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e88', title: 'Reading list' }],
              next: null,
            })
          : problem(503, 'semantic_not_ready');
      if (url.pathname === `/v1/zones/${id}/configuration` && request.method === 'GET')
        return mode.readStatus === 200
          ? response(resource)
          : problem(mode.readStatus, mode.readStatus === 404 ? 'not_found' : 'forbidden');
      if (url.pathname === `/v1/zones/${id}:readPage`) {
        const body = (await request.json()) as { target: { route: string } };
        if (mode.previewStatus === 202) return response({ next: 'opaque-continuation' }, 202);
        if (mode.previewStatus !== 200)
          return problem(
            mode.previewStatus,
            mode.previewStatus === 503
              ? 'semantic_not_ready'
              : mode.previewStatus === 404
                ? 'not_found'
                : 'platform_closed',
          );
        const page = resource.configuration.pages.find((page) => page.route === body.target.route);
        if (!page) return problem(404, 'not_found');
        const { ownerId: _owner, deletedAt: _deleted, restoreUntil: _restore, ...zone } = resource.zone;
        return response({
          zone,
          profile: staticZoneHomeFake.profile,
          template: { scope: 'route', key: page.route },
          document: page.document,
          reads: {},
        });
      }
      if (request.method === 'DELETE' && url.pathname === `/v1/zones/${id}`) {
        if (mode.mutationStatus)
          return problem(
            mode.mutationStatus,
            mode.mutationStatus === 412 ? 'precondition_failed' : 'dependency_unavailable',
          );
        const key = request.headers.get('idempotency-key') ?? '';
        const signature = JSON.stringify([url.pathname, request.headers.get('if-match'), 'delete']);
        const receipt = receipts.get(key);
        if (receipt)
          return receipt.signature === signature
            ? response({ zone: receipt.value })
            : problem(422, 'idempotency_conflict');
        if (request.headers.get('if-match') !== `"${resource.zone.revision}"`)
          return problem(412, 'precondition_failed');
        resource.zone.deletedAt = '2026-11-06T00:00:00.000Z';
        resource.zone.restoreUntil = '2026-12-06T00:00:00.000Z';
        advance();
        receipts.set(key, { signature, value: structuredClone(resource.zone) });
        return response({ zone: resource.zone });
      }
      if (
        request.method === 'POST' &&
        (url.pathname === `/v1/zones/${id}:restore` || url.pathname === `/v1/zones/${id}/$restore`)
      ) {
        if (mode.mutationStatus)
          return problem(
            mode.mutationStatus,
            mode.mutationStatus === 412 ? 'precondition_failed' : 'dependency_unavailable',
          );
        const key = request.headers.get('idempotency-key') ?? '';
        const signature = JSON.stringify([url.pathname, request.headers.get('if-match'), 'restore']);
        const receipt = receipts.get(key);
        if (receipt)
          return receipt.signature === signature
            ? response({ zone: receipt.value })
            : problem(422, 'idempotency_conflict');
        if (request.headers.get('if-match') !== `"${resource.zone.revision}"`)
          return problem(412, 'precondition_failed');
        resource.zone.deletedAt = null;
        resource.zone.restoreUntil = null;
        advance();
        receipts.set(key, { signature, value: structuredClone(resource.zone) });
        return response({ zone: resource.zone });
      }
      if (request.method === 'PUT' || url.pathname === `/v1/zones/${id}:publish`) {
        if (mode.mutationStatus)
          return problem(
            mode.mutationStatus,
            mode.mutationStatus === 412 ? 'precondition_failed' : 'dependency_unavailable',
          );
        if (request.method === 'PUT' && !mode.configure) return problem(403, 'forbidden');
        const key = request.headers.get('idempotency-key') ?? '';
        const body = (await request.json()) as ZoneConfigureInput & { visibility: Visibility };
        const signature = JSON.stringify([url.pathname, request.headers.get('if-match'), body]);
        const receipt = receipts.get(key);
        if (receipt)
          return receipt.signature === signature
            ? response({ zone: receipt.value })
            : problem(422, 'idempotency_conflict');
        if (request.headers.get('if-match') !== `"${resource.zone.revision}"`)
          return problem(412, 'precondition_failed');
        if (request.method === 'PUT') {
          resource.configuration = body.configuration;
          resource.mounts = body.mounts;
          resource.zone.labels = body.configuration.labels;
          if (body.configuration.primaryLanguage) resource.zone.primaryLanguage = body.configuration.primaryLanguage;

          resource.zone.navigation = body.configuration.pages.map((page: { route: string }) => ({ route: page.route }));
        } else resource.zone.visibility = body.visibility;
        advance();
        receipts.set(key, { signature, value: structuredClone(resource.zone) });
        return response({ zone: resource.zone });
      }
      return problem(404, 'not_found');
    }) as typeof fetch,
  });
  const readRelease = async () => {
    if (!mode.optionsAvailable) throw new Error('Definitions unavailable');
    return release;
  };
  const transport: Transport = {
    load: () => loadConfiguration(client, id, authorization, readRelease),
    mutate: (input) => mutate(client, authorization, input),
    lifecycle: async (input) => {
      if (mode.mutationStatus)
        return {
          kind: 'failure',
          status: mode.mutationStatus,
          code: mode.mutationStatus === 412 ? 'precondition_failed' : 'dependency_unavailable',
        };
      const signature = JSON.stringify([input.operation, input.revision, input.id]);
      const receipt = receipts.get(input.key);
      if (receipt)
        return receipt.signature === signature
          ? {
              kind: 'ready',
              value: {
                revision: receipt.value.revision,
                deletedAt: receipt.value.deletedAt,
                restoreUntil: receipt.value.restoreUntil,
              },
            }
          : { kind: 'failure', status: 422, code: 'idempotency_conflict' };
      if (input.revision !== resource.zone.revision)
        return { kind: 'failure', status: 412, code: 'precondition_failed' };
      if (input.operation === 'delete') {
        resource.zone.deletedAt = '2026-11-06T00:00:00.000Z';
        resource.zone.restoreUntil = '2026-12-06T00:00:00.000Z';
      } else {
        resource.zone.deletedAt = null;
        resource.zone.restoreUntil = null;
      }
      advance();
      receipts.set(input.key, { signature, value: structuredClone(resource.zone) });
      return {
        kind: 'ready',
        value: {
          revision: resource.zone.revision,
          deletedAt: resource.zone.deletedAt,
          restoreUntil: resource.zone.restoreUntil,
        },
      };
    },
    preview: (route) => preview(client, authorization, id, route, 'en'),
    collections: (cursor) => collections(client, authorization, cursor),
  };
  const initial: Loaded = {
    resource: { kind: 'ready', value: structuredClone(resource) },
    permissions: { configure: true, publish: true, available: true },
    options: {
      scopes: { kind: 'ready', value: { release: release.digest!, ids: Object.keys(release.filters!) } },
      collections: {
        kind: 'ready',
        value: { items: [{ id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e88', title: 'Reading list' }], next: null },
      },
    },
  };
  return {
    id,
    client,
    authorization,
    calls,
    mode,
    transport,
    initial,
    current: () => structuredClone(resource),
    externalChange: () => {
      advance();
      resource.configuration.labels.en = 'Changed elsewhere';
    },
  };
}
