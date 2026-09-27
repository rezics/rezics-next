import { createHash } from 'node:crypto';
import type { ModCapture } from '../../../services/main/src/modules/package/mod-profile.ts';

interface LiveCapture extends ModCapture {
  capturedAt: string;
  responseHeaders: { contentType: string | null; etag: string | null; lastModified: string | null };
  failureBytesBase64?: string;
  failureSha256?: string;
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Fetch each current provider surface once per test run and reuse its exact bytes. */
async function acquire(identity: string, surface: string, url: string,
  init?: RequestInit): Promise<LiveCapture> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 65_536) throw new Error(`oversized ${surface} provider response`);
  return { identity, surface, status: response.ok ? 'observed' : 'inaccessible',
    bytesBase64: response.ok ? bytes.toString('base64') : null,
    sha256: response.ok ? digest(bytes) : null, sourceUrl: url, httpStatus: response.status,
    ...(response.ok ? {} : { failureBytesBase64: bytes.toString('base64'),
      failureSha256: digest(bytes) }),
    capturedAt: new Date().toISOString(), responseHeaders: {
      contentType: response.headers.get('content-type'), etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified') } };
}

export async function acquireLiveModProviders() {
  const modrinthUrl = 'https://api.modrinth.com/v2/version/p3OA9KJx';
  const modrinth = await acquire('p3OA9KJx', 'version', modrinthUrl,
    { headers: { 'User-Agent': 'REZICS/0.1 (mod-profile-qa)' } });
  if (modrinth.httpStatus !== 200 || !modrinth.bytesBase64) {
    throw new Error(`Modrinth embedded candidate unavailable: HTTP ${modrinth.httpStatus}`);
  }
  const version = JSON.parse(Buffer.from(modrinth.bytesBase64, 'base64').toString('utf8')) as {
    dependencies: Array<{ dependency_type: string; version_id: string | null;
      project_id: string | null }> };
  const embedded = version.dependencies.find(dep => dep.dependency_type === 'embedded'
    && dep.version_id && dep.project_id);
  if (!embedded?.version_id) throw new Error('Modrinth candidate has no qualified embedded dependency');
  const child = await acquire(embedded.version_id, 'version',
    `https://api.modrinth.com/v2/version/${embedded.version_id}`,
    { headers: { 'User-Agent': 'REZICS/0.1 (mod-profile-qa)' } });
  if (child.httpStatus !== 200) throw new Error(`Modrinth embedded child unavailable: HTTP ${child.httpStatus}`);
  const childVersion = JSON.parse(Buffer.from(child.bytesBase64!, 'base64').toString('utf8')) as {
    id: string; project_id: string };
  if (childVersion.id !== embedded.version_id || childVersion.project_id !== embedded.project_id) {
    throw new Error('Modrinth embedded version and project identity disagree');
  }

  const collectionId = '1175117161';
  const collection = await acquire(collectionId, 'collection-details',
    'https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/',
    { method: 'POST', body: new URLSearchParams({ collectioncount: '1',
      'publishedfileids[0]': collectionId }) });
  if (collection.httpStatus !== 200) throw new Error(`Steam Collection unavailable: HTTP ${collection.httpStatus}`);
  const itemId = '2370295313';
  const item = await acquire(itemId, 'details-public',
    'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
    { method: 'POST', body: new URLSearchParams({ itemcount: '1',
      'publishedfileids[0]': itemId }) });
  if (item.httpStatus !== 200) throw new Error(`Steam item unavailable: HTTP ${item.httpStatus}`);
  const itemBody = JSON.parse(Buffer.from(item.bytesBase64!, 'base64').toString('utf8')) as {
    response?: { publishedfiledetails?: Array<Record<string, unknown>> } };
  const itemDetails = itemBody.response?.publishedfiledetails?.[0];
  if (itemDetails?.publishedfileid !== itemId || itemDetails.result !== 1
    || 'children' in itemDetails || 'num_children' in itemDetails) {
    throw new Error('Steam public item children coverage changed');
  }
  // This public method omits the children surface even for an item with Workshop required items.
  const itemChildren: ModCapture = { identity: itemId, surface: 'ugc-children',
    status: 'inaccessible', bytesBase64: null, sha256: null,
    sourceUrl: item.sourceUrl, httpStatus: item.httpStatus };

  const nexusIdentity = '1';
  const nexusPublic = await acquire(nexusIdentity, 'graphql-public',
    'https://api.nexusmods.com/v2/graphql', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename games { nodes { id } } }' }) });
  if (nexusPublic.httpStatus !== 200) throw new Error(`Nexus public GraphQL unavailable: HTTP ${nexusPublic.httpStatus}`);
  const nexusRange = await acquire(nexusIdentity, 'file-version-range',
    'https://api.nexusmods.com/v3/mod-file-versions/1/dependencies/ranges');
  if (nexusRange.httpStatus !== 401 && nexusRange.httpStatus !== 403) {
    throw new Error(`Nexus unauthenticated range response changed: HTTP ${nexusRange.httpStatus}`);
  }
  const captures = { modrinth: [modrinth, child], steamCollection: [collection],
    steamItem: [item, itemChildren], nexus: [nexusPublic, nexusRange] };
  await Bun.write('.temp/goal/mod-provider-live-captures.json', JSON.stringify({
    profile: 'mod-provider-live-captures-v1', capturedAt: new Date().toISOString(),
    captures }, null, 2));
  return { captures, embedded };
}
