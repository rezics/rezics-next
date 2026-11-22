import type { CatalogPackage, CatalogRelease, PackageKind, Page, ReleaseRef } from '@rezics/launcher-contract';
import * as v from 'valibot';

const packageId = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9][a-z0-9._-]{0,95}$/u));
const releaseId = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/u));
const releaseRef = v.object({ packageId, releaseId });
const url = v.pipe(v.string(), v.url());
const identifier = v.object({
  id: packageId,
  kind: v.picklist(['overlay-panel', 'minecraft-mod']),
  publisher: v.string(),
  title: v.string(),
  summary: v.string(),
  subjectId: v.exactOptional(v.string()),
});
const release = v.object({
  id: releaseId,
  packageId,
  version: v.string(),
  compatibility: v.variant('kind', [
    v.object({ kind: v.literal('overlay-panel'), launcherRange: v.string() }),
    v.object({ kind: v.literal('minecraft-mod'), gameVersion: v.string(), loader: v.literal('fabric') }),
  ]),
  artifact: v.object({
    url,
    size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    sha256: v.pipe(v.string(), v.regex(/^[a-fA-F0-9]{64}$/)),
  }),
  requires: v.pipe(v.array(releaseRef), v.maxLength(64)),
});
const packagePage = v.object({ items: v.array(identifier), nextCursor: v.nullable(v.string()) });
const releasePage = v.object({ items: v.array(release), nextCursor: v.nullable(v.string()) });

export class CatalogRequestError extends Error {
  constructor(readonly status: number) {
    super(`Catalog request failed (${status}).`);
  }
}

/** Bound remote metadata without buffering a potentially unbounded response. */
export async function getJson(fetcher: typeof fetch, url: URL, cancellation?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
    signal: cancellation ? AbortSignal.any([cancellation, timeout]) : timeout,
    redirect: 'error',
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new CatalogRequestError(response.status);
  }
  let bytes = 0;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let json = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 5_242_880) throw new Error('The catalog response is too large.');
      json += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class Catalog {
  private readonly base: string;

  constructor(
    endpoint: string,
    private readonly fetcher = fetch,
  ) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid REZICS catalog origin.');
    }
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/launcher/packages`;
    this.base = url.href;
  }

  async list(kind: PackageKind, q?: string, cursor?: string): Promise<Page<CatalogPackage>> {
    const url = new URL(this.base);
    url.searchParams.set('kind', kind);
    if (q?.trim()) url.searchParams.set('q', q.trim());
    if (cursor) url.searchParams.set('cursor', cursor);
    return v.parse(packagePage, await getJson(this.fetcher, url));
  }

  private packageUrl(id: string, tail = '') {
    return new URL(`${this.base}/${encodeURIComponent(v.parse(packageId, id))}${tail}`);
  }

  async package(packageId: string, signal?: AbortSignal): Promise<CatalogPackage> {
    const found = v.parse(identifier, await getJson(this.fetcher, this.packageUrl(packageId), signal));
    if (found.id !== packageId) throw new Error('The catalog returned a different package.');
    return found;
  }

  async releases(packageId: string, cursor?: string): Promise<Page<CatalogRelease>> {
    const url = this.packageUrl(packageId, '/releases');
    if (cursor) url.searchParams.set('cursor', cursor);
    return v.parse(releasePage, await getJson(this.fetcher, url));
  }

  async exact(ref: ReleaseRef, signal?: AbortSignal): Promise<CatalogRelease> {
    const path = `/releases/${encodeURIComponent(v.parse(releaseId, ref.releaseId))}`;
    const found = v.parse(release, await getJson(this.fetcher, this.packageUrl(ref.packageId, path), signal));
    if (found.id !== ref.releaseId || found.packageId !== ref.packageId) {
      throw new Error('The catalog returned a different release.');
    }
    return found;
  }
}
