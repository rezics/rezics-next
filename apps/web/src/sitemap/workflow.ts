import { sitemapStepRetryPolicy, type SitemapObject, type SitemapStepRunner, type SitemapStore } from './export.ts';

const retentionMs = 7 * 24 * 60 * 60 * 1_000;
const groupSize = 100;
type Run = {
  id: string;
  cursor: string | null;
  latest: number;
  publishedAt?: number;
  deleting?: boolean;
  page?: SitemapObject[];
};
type CleanupState = {
  phase: 'index' | 'mark' | 'shards' | 'runs' | 'release';
  cursor: string | null;
  page?: SitemapObject[];
  manifests?: string[];
  offset?: number;
  lastRun?: string;
  run?: Run;
  indexEtag: string | null;
  cutoff: number;
};

function metadata<T>(body: Uint8Array | null, key: string): T {
  if (!body) throw new Error(`Missing sitemap export metadata ${key}`);
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

function publication(body: Uint8Array | null, key: string): { time: number; types: string[] } {
  const value = metadata<{ publishedAt: string; types: string[] }>(body, key);
  const time = Date.parse(value.publishedAt);
  if (!Number.isFinite(time) || !Array.isArray(value.types) || value.types.some((type) => !/^[a-z]+$/.test(type)))
    throw new Error(`Invalid sitemap publication metadata ${key}`);
  return { time, types: value.types };
}

/** Each transition reads at most one native page and deletes or marks at most 100 keys. */
async function cleanupStep(store: SitemapStore, runId: string, state: CleanupState): Promise<CleanupState | null> {
  const refs = `runs/${runId}/cleanup/refs/`;
  const cutoff = state.cutoff;
  if (state.phase === 'index') {
    const body = await store.get('index.xml');
    if (!body) throw new Error('Missing current sitemap index');
    const xml = new TextDecoder().decode(body);
    const locations = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)];
    if (!xml.includes('<sitemapindex ') || locations.length === 0 || locations.length > 50_000)
      throw new Error('Invalid current sitemap index');
    const keys = locations.map((location) => {
      const match = /^https:\/\/[^/]+\/sitemap-([a-z]+)-([0-9a-f]{24})\.xml\.gz$/.exec(location[1]!);
      if (!match) throw new Error('Invalid current sitemap index location');
      return `shards/${match[1]}-${match[2]}.xml.gz`;
    });
    const offset = state.offset ?? 0;
    for (const key of keys.slice(offset, offset + groupSize)) await store.put(`${refs}${key}`, '');
    state.offset = offset + groupSize;
    if (state.offset >= keys.length) {
      state.phase = 'mark';
      delete state.offset;
    }
    return state;
  }
  if (state.phase === 'mark') {
    if (state.manifests?.length) {
      const key = state.manifests[0]!;
      const files = metadata<{ key: string }[]>(await store.get(key), key);
      if (!Array.isArray(files) || files.length > 50_000) throw new Error(`Invalid sitemap inventory ${key}`);
      const offset = state.offset ?? 0;
      for (const file of files.slice(offset, offset + groupSize)) await store.put(`${refs}${file.key}`, '');
      state.offset = offset + groupSize;
      if (state.offset >= files.length) {
        state.manifests.shift();
        state.offset = 0;
      }
      return state;
    }
    if (state.page?.length) {
      const key = state.page.shift()!.key!;
      const published = publication(await store.get(key), key);
      const id = key.slice('runs/'.length, -'/published.json'.length);
      if (id === runId || published.time > cutoff)
        state.manifests = published.types.map((type) => `runs/${id}/${type}.json`);
      return state;
    }
    if (state.page && state.cursor === null) {
      state.phase = 'shards';
      delete state.page;
      return state;
    }
    const page = await store.list('runs/', state.cursor);
    state.page = page.objects.filter((object) => /^runs\/[^/]+\/published\.json$/.test(object.key ?? ''));
    state.cursor = page.cursor;
    return state;
  }

  if (state.phase === 'shards') {
    // A later publication takes over retention. Its new inventory must never be swept using our earlier marks.
    if ((await store.head('index.xml'))?.etag !== state.indexEtag) return null;
    if (state.page?.length) {
      for (const shard of state.page.splice(0, groupSize)) {
        const time = Date.parse(shard.uploaded);
        if (Number.isFinite(time) && time <= cutoff && !(await store.head(`${refs}${shard.key!}`)))
          await store.delete(shard.key!);
      }
      return state;
    }
    if (state.page && state.cursor === null) {
      state.phase = 'runs';
      delete state.page;
      return state;
    }
    const page = await store.list('shards/', state.cursor);
    state.page = page.objects;
    state.cursor = page.cursor;
    return state;
  }

  if (state.phase === 'runs') {
    if (state.run) {
      const run = state.run;
      const prefix = `runs/${run.id}/`;
      if (run.deleting) {
        if (run.page?.length) {
          for (const object of run.page.splice(0, groupSize)) await store.delete(object.key!);
        } else if (run.page && run.cursor === null) {
          delete state.run;
        } else {
          const page = await store.list(prefix, run.cursor);
          run.page = page.objects;
          run.cursor = page.cursor;
        }
      } else {
        const page = await store.list(prefix, run.cursor);
        for (const object of page.objects) {
          const time = Date.parse(object.uploaded);
          if (!Number.isFinite(time)) throw new Error(`Invalid sitemap upload time ${object.key}`);
          run.latest = Math.max(run.latest, time);
          if (object.key === `${prefix}published.json`)
            run.publishedAt = publication(await store.get(object.key), object.key).time;
        }
        run.cursor = page.cursor;
        if (page.cursor === null) {
          if ((run.publishedAt ?? run.latest) <= cutoff) run.deleting = true;
          else delete state.run;
        }
      }
      return state;
    }
    if (state.page?.length) {
      const id = /^runs\/([^/]+)\//.exec(state.page.shift()!.key ?? '')?.[1];
      if (id && id !== runId && id !== state.lastRun) state.run = { id, cursor: null, latest: 0 };
      if (id) state.lastRun = id;
      else delete state.lastRun;
      return state;
    }
    if (state.page && state.cursor === null) {
      state.phase = 'release';
      delete state.page;
      return state;
    }
    const page = await store.list('runs/', state.cursor);
    // Ordered listing lets adjacent pages share a run without retaining every historical run id.
    state.page = page.objects.filter((object, index) => {
      const id = /^runs\/([^/]+)\//.exec(object.key ?? '')?.[1];
      return id !== /^runs\/([^/]+)\//.exec(page.objects[index - 1]?.key ?? '')?.[1];
    });
    state.cursor = page.cursor;
    return state;
  }

  if (state.page?.length) {
    for (const object of state.page.splice(0, groupSize)) await store.delete(object.key!);
    return state;
  }
  if (state.page && state.cursor === null) {
    await store.delete(`runs/${runId}/cleanup-state.json`);
    return null;
  }
  const page = await store.list(refs, state.cursor);
  state.page = page.objects;
  state.cursor = page.cursor;
  return state;
}

/** Continues retention in the existing export Workflow, with bounded durable transitions and segment checkpoints. */
export async function cleanupSitemapExportSegment(
  store: SitemapStore,
  runner: SitemapStepRunner,
  runId: string,
  now: Date,
  segment: number,
  maxSteps = 4_990,
): Promise<boolean> {
  const stateKey = `runs/${runId}/cleanup-state.json`;
  let state: CleanupState | null = await runner.do(
    `cleanup:${segment}:load`,
    async () =>
      segment === 0
        ? {
            phase: 'index',
            cursor: null,
            indexEtag: (await store.head('index.xml'))?.etag ?? null,
            cutoff: now.valueOf() - retentionMs,
          }
        : metadata<CleanupState>(await store.get(stateKey), stateKey),
    sitemapStepRetryPolicy(),
  );
  for (let step = 0; step < maxSteps; step += 1) {
    const previous: CleanupState = state!;
    state = await runner.do(
      `cleanup:${segment}:${step}`,
      (): Promise<CleanupState | null> => cleanupStep(store, runId, structuredClone(previous)),
      sitemapStepRetryPolicy(),
    );
    if (state === null) return true;
  }
  await runner.do(
    `cleanup:${segment}:checkpoint`,
    () => store.put(stateKey, JSON.stringify(state)),
    sitemapStepRetryPolicy(),
  );
  return false;
}
