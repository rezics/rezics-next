import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { createAccess } from '../../../src/access/index.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { newId, routeOf, partitionOf } from '../../../src/route/route.ts';
import { tupleRoute } from '../../../src/content/imported-contract.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import type { CollectionView } from '../../../src/library/collection-reads.ts';
import { openApiRuntime } from '../../imports/api-runtime.ts';
import { identitySupport } from '../../imports/identity-fixture.ts';

export const collectionScopes = [
  'collection:create',
  'collection:read',
  'collection:update',
  'collection:delete',
  'subject:create',
  'subject:read',
  'media:read',
  'offer:create',
  'offer:read',
  'library_entry:read',
  'library_entry:update',
];
const managementScopes = [
  ...collectionScopes,
  'access:grant',
  'exposure:open',
  'account:suspend',
  'moderation:hide',
  'moderation:takedown',
  'source_fence:takedown',
  'definitions:publish',
  'definitions:activate',
];

/** Real Auth issuance, Access governance and Content import/jobs; only HTTPS and object storage are external fixtures. */
export async function createCollectionPresentationFixture() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  try {
    const { identity, database } = runtime;
    const support = identitySupport(identity);
    const clientId = `collection-presentation-${randomUUID()}`;
    await identity.auth.internal.registerClient({ clientId, firstParty: true, scopes: managementScopes });
    const another = await support.host.workflows.register({
      key: randomUUID(),
      handle: 'collection_other',
      email: 'another@identity.test',
      password: 'private native identity fixture password',
    });
    async function credential(person: 'ordinary' | 'governance' | 'another', scopes = collectionScopes) {
      const signed = await support.request('/signin', {
        email: `${person}@identity.test`,
        password: 'private native identity fixture password',
        client_id: clientId,
        scope: scopes,
      });
      expect(signed.status).toBe(200);
      const headers = new Headers({
        cookie: signed.headers
          .getSetCookie()
          .map((item) => item.split(';')[0]!)
          .join('; '),
      });
      const issued = await support.request('/token', {}, headers);
      expect(issued.status).toBe(200);
      const { access_token: bearer } = (await issued.json()) as { access_token: string };
      return { bearer, accountId: person === 'another' ? another.accountId : identity[person].accountId };
    }
    const owner = await credential('ordinary');
    const other = await credential('another', collectionScopes);
    const manager = await credential('governance', managementScopes);
    // One connection suffices for the owner path. Any foreign checkout while it is held fails natively.
    database.pool.options.max = 1;
    const app = createKernel({
      pool: database.pool,
      routeKey: identity.routeKey,
      tokens: identity.tokenKeys,
      access: (configuration) => createAccess({ ...configuration, auth: identity.accessConfig.auth! }),
      content: { fetchConfig: { allowedHosts: ['lain.bgm.tv', 'covers.openlibrary.org'] } },
      writeRate: createWriteRateLimiter({
        secret: randomUUID(),
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } }),
      }),
    });
    const send = (bearer: string | null, method: string, path: string, body?: unknown, key = randomUUID()) =>
      app.handle(
        new Request(`https://collection.test${path}`, {
          method,
          headers: {
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
            'idempotency-key': JSON.stringify(key),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    expect((await send(manager.bearer, 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
    const grant = async (accountId: string, actions: string[]) => {
      const response = await send(manager.bearer, 'POST', '/v1/grants', {
        resource: { route: 0, id: '00000000-0000-8000-8000-000000000000' },
        subject: { kind: 'account', id: accountId },
        actions,
        valid: '(,)',
      });
      expect(response.status).toBe(201);
    };
    await grant(owner.accountId, ['subject:create', 'offer:create']);
    async function refresh() {
      owner.bearer = (await credential('ordinary')).bearer;
      other.bearer = (await credential('another')).bearer;
      manager.bearer = (await credential('governance', managementScopes)).bearer;
    }
    async function collection(body: Record<string, unknown> = {}, bearer = owner.bearer) {
      const response = await send(bearer, 'POST', '/v1/collections', {
        title: 'Selected presentation',
        visibility: 'private',
        ...body,
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { collection: CollectionView }).collection;
    }
    async function importedCover() {
      const created = await send(owner.bearer, 'POST', '/v1/subjects', {
        type: 'schema:Book',
        labels: { en: 'Native cover subject' },
      });
      expect(created.status).toBe(201);
      const subjectId = ((await created.json()) as { subject: { id: string } }).subject.id;
      expect(subjectId).toBeString();
      const externalId = randomUUID();
      const sourceUrl = `https://lain.bgm.tv/collection-${externalId}.jpg`;
      await runtime.mediaBoundary.source(sourceUrl);
      const input: MediaImportRequest = {
        containerId: subjectId,
        sourceUrl,
        credit: {
          rightsHolder: 'Native cover fixture',
          via: { name: 'Fixture catalogue', url: 'https://lain.bgm.tv/' },
          license: 'LicenseRef-unknown',
          obligations: [],
        },
        provenance: {
          source: 'collection_fixture',
          external_id: externalId,
          record_revision: '1',
          digest: 'b'.repeat(64),
          converter_revision: '1',
          field_group: 'cover',
          references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUrl } }] }],
        },
      };
      // The real importer identity, not the Collection editor, owns import authority.
      const importer = await support.issue(identity.bulk.accountId, identity.client.scopes);
      const imported = await runtime.request('/v1/media:importFromUrl', input, importer.bearer);
      expect(imported.status).toBe(202);
      const mediaId = ((await imported.json()) as { media: { id: string } }).media.id;
      await runtime.mediaBoundary.drain({ mediaIds: [mediaId], maxJobs: 16, signal: new AbortController().signal });
      const observation = await runtime.mediaBoundary.observe(mediaId);
      expect(observation.row.state).toBe('available');
      expect(observation.row.containerId).toBe(subjectId);
      expect(observation.variants.length).toBeGreaterThan(0);
      return { mediaId, subjectId, input, observation };
    }
    async function growCoverHistory(mediaId: string, scale: number, previous: number) {
      const ids = Array.from({ length: scale - previous }, () => newId(routeOf(mediaId)!));
      // Unrelated population only. None of these seeded keys is used to establish a positive outcome.
      await database.admin.query(
        `INSERT INTO content.media
        (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
         actual_byte_count,sha256,state,key,created_at,transaction_id,source_url,credit,provenance,
         width,height,thumbhash,average_color)
        SELECT media.route,noise.id,media.container_id,media.uploader_id,noise.id::text,'cover',
         media.media_type,media.byte_count,media.actual_byte_count,media.sha256,media.state,
         'm/'||noise.id::text||'/original',media.created_at,media.transaction_id,media.source_url,media.credit,
         jsonb_set(media.provenance,'{external_id}',to_jsonb(noise.id::text)),media.width,media.height,media.thumbhash,media.average_color
        FROM content.media media CROSS JOIN unnest($3::uuid[]) noise(id)
        WHERE media.route=$1 AND media.media_id=$2`,
        [routeOf(mediaId), mediaId, ids],
      );
      await database.admin.query(
        `INSERT INTO content.media_variant(route,media_id,format,width,height,key,sha256,byte_count,media_type)
        SELECT variant.route,noise.id,variant.format,variant.width,variant.height,
         'm/'||noise.id::text||'/'||variant.format||'-'||variant.width,variant.sha256,variant.byte_count,variant.media_type
        FROM content.media_variant variant CROSS JOIN unnest($3::uuid[]) noise(id)
        WHERE variant.route=$1 AND variant.media_id=$2`,
        [routeOf(mediaId), mediaId, ids],
      );
      const routes = ids.map((id) => tupleRoute(identity.routeKey, 'collection_fixture', id));
      await database.admin.query(
        `INSERT INTO content.source_fences(route,source,external_id,field_group,taken_down,security_revision)
        SELECT route,'collection_fixture',id,'cover',false,1 FROM unnest($1::integer[],$2::text[]) noise(route,id)`,
        [routes, ids],
      );
      await database.admin.query(
        `INSERT INTO core.receipt
        (partition_no,principal_id,principal_kind,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
        SELECT old.partition_no,old.principal_id,old.principal_kind,old.command_kind,'presentation-noise-'||id,
         old.request_digest,old.epoch,old.position,gen_random_uuid(),old.response
        FROM (SELECT * FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
          AND command_kind='library.collection.create' ORDER BY idempotency_key LIMIT 1) old
        CROSS JOIN unnest($3::text[]) noise(id)`,
        [partitionOf(routeOf(owner.accountId)!), owner.accountId, ids],
      );
    }
    return {
      growCoverHistory,
      refresh,
      grant,
      runtime,
      database,
      owner,
      other,
      manager,
      credential,
      send,
      collection,
      importedCover,
      close: runtime.close,
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
export type CollectionPresentationFixture = Awaited<ReturnType<typeof createCollectionPresentationFixture>>;
