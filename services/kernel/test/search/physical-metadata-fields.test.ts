import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createDiscoveryIndex,
  discoveryIndexName,
  discoveryIndexUuid,
  readDiscoveryPhysicalIdentity,
  readSubjectIndexUuid,
  subjectIndexDefinition,
  subjectIndexName,
} from '../../src/search/indices.ts';
import { listPhysicalSubjectGenerations } from '../../src/search/generation-inventory.ts';
import {
  readIdentityIndexIncarnation,
  readSearchWriterPhysicalTarget,
} from '../../src/search/identity-epoch-participant-physical.ts';
import { createOpenSearch, OpenSearchError, type OpenSearch } from '../../src/search/opensearch.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error('OPENSEARCH_URL must name the native test node');
const search = createOpenSearch(url);

function measured() {
  const calls: { path: string; bytes: number; body?: unknown }[] = [];
  const client: OpenSearch = {
    ...search,
    async request<T>(
      method: Parameters<OpenSearch['request']>[0],
      path: string,
      body?: unknown,
      options?: Parameters<OpenSearch['request']>[3],
    ) {
      const call: (typeof calls)[number] = { path, bytes: 0 };
      calls.push(call);
      const response = await search.request<T>(method, path, body, {
        ...options,
        work: {
          deadline: Date.now() + 10_000,
          bytes: 4 * 1024 * 1024,
          settle(bytes) {
            call.bytes += bytes;
          },
        },
      });
      call.body = response.body;
      return response;
    },
  };
  return { calls, client };
}

test('exact physical reads retain the UUID and all aliases at fixed wire cost as unrelated settings and mappings grow', async () => {
  const prefix = 'fields-' + randomUUID().slice(0, 8) + '-';
  const readAlias = prefix + 'shared';
  const definition = subjectIndexDefinition() as {
    settings: { analysis: { analyzer: Record<string, unknown> } };
    mappings: { properties: Record<string, unknown> };
  };
  const created: string[] = [];
  const sizes: { settings: number; physical: number; uuid: number; writer: number }[] = [];
  try {
    for (const [i, width] of [1, 8, 64].entries()) {
      const index = subjectIndexName(prefix, i + 1);
      const writer = index + '-writer-' + randomUUID().replaceAll('-', '');
      const dynamic = structuredClone(definition);
      for (let j = 0; j < width; j++) {
        dynamic.settings.analysis.analyzer['additional_' + j] = { type: 'standard' };
        dynamic.mappings.properties['additional_' + j] = { type: 'keyword' };
      }
      await search.request('PUT', '/' + index, {
        ...dynamic,
        aliases: {
          [writer]: { is_write_index: true },
          [readAlias]: {},
          [prefix + 'filtered']: { filter: { term: { type: 'Book' } } },
        },
      });
      created.push(index);
      const { client, calls } = measured();
      const settings = await client.request<Record<string, { settings: { index: { uuid: string } } }>>(
        'GET',
        '/' + index + '/_settings',
      );
      const physical = await client.request<Record<string, { aliases: Record<string, unknown> }>>('GET', '/' + index);
      const uuid = settings.body[index]!.settings.index.uuid;
      expect(await readIdentityIndexIncarnation(client, index)).toBe(uuid);
      expect(await discoveryIndexUuid(client, index)).toBe(uuid);
      expect(await readSearchWriterPhysicalTarget(client, index)).toEqual({ incarnation: uuid, writeAlias: writer });
      expect(calls.map((call) => call.path)).toEqual([
        '/' + index + '/_settings',
        '/' + index,
        '/' + index + '/_settings',
        '/' + index + '/_settings',
        '/' + index,
      ]);
      expect(await readSubjectIndexUuid(client, prefix, i + 1)).toBe(uuid);
      const identity = { settings: { index: { uuid } } };
      expect(calls[2]!.body).toEqual({ [index]: identity });
      expect(calls[5]!.body).toEqual({ [index]: identity });
      expect(calls[3]!.body).toEqual({ [index]: identity });
      expect(calls[4]!.body).toEqual({ [index]: { ...identity, aliases: physical.body[index]!.aliases } });
      expect(Object.keys(physical.body[index]!.aliases)).toHaveLength(3);
      sizes.push({
        settings: calls[0]!.bytes,
        physical: calls[1]!.bytes,
        uuid: calls[2]!.bytes,
        writer: calls[4]!.bytes,
      });
    }
    expect(sizes.map((s) => s.uuid)).toEqual(Array(3).fill(sizes[0]!.uuid));
    expect(sizes.map((s) => s.writer)).toEqual(Array(3).fill(sizes[0]!.writer));
    for (const [i, size] of sizes.entries()) {
      expect(size.settings).toBeGreaterThan(size.uuid);
      expect(size.physical).toBeGreaterThan(size.writer);
      if (i > 0) {
        expect(size.settings).toBeGreaterThan(sizes[i - 1]!.settings);
        expect(size.physical).toBeGreaterThan(sizes[i - 1]!.physical);
      }
    }
    const inventory = await listPhysicalSubjectGenerations(search, prefix);
    expect(inventory?.map((x) => x.physicalTarget)).toEqual(created);
    await expect(discoveryIndexUuid(search, readAlias)).rejects.toThrow();
    await expect(readDiscoveryPhysicalIdentity(search, readAlias)).rejects.toThrow();
    const duplicate = created[0] + '-writer-' + randomUUID().replaceAll('-', '');
    await search.request('POST', '/_aliases', { actions: [{ add: { index: created[0], alias: duplicate } }] });
    await expect(readSearchWriterPhysicalTarget(search, created[0]!)).rejects.toThrow();
  } finally {
    for (const index of created) await search.request('DELETE', '/' + index);
  }
});

test('a fresh Discovery physical read observes replacement and the original missing-index error', async () => {
  const prefix = 'inc-' + randomUUID().slice(0, 8) + '-';
  const index = discoveryIndexName(prefix, 1);
  const allocation = randomUUID();
  const { client, calls } = measured();
  try {
    await createDiscoveryIndex(search, prefix, 1, allocation);
    const original = await readDiscoveryPhysicalIdentity(client, index);
    expect(original?.incarnation).toBe(allocation);
    expect(calls[0]!.body).toEqual({
      [index]: { settings: { index: { uuid: original!.uuid } }, mappings: { _meta: { incarnation: allocation } } },
    });
    await search.request('DELETE', '/' + index);
    expect(await readDiscoveryPhysicalIdentity(client, index)).toBeNull();
    const getError = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        if (error instanceof OpenSearchError) return { status: error.status, body: error.body };
        throw error;
      }
      throw Error('Expected a missing physical index');
    };
    const full = await getError(() => search.request('GET', '/' + index + '/_settings'));
    expect(full.status).toBe(404);
    expect(full.body).toMatchObject({
      status: 404,
      error: { type: 'index_not_found_exception', root_cause: expect.any(Array) },
    });
    expect(await getError(() => discoveryIndexUuid(search, index))).toEqual(full);
    await createDiscoveryIndex(search, prefix, 1);
    const replacement = await readDiscoveryPhysicalIdentity(client, index);
    expect(replacement?.incarnation).toBeNull();
    expect(replacement?.uuid).toBeString();
    expect(replacement?.uuid).not.toBe(original?.uuid);
  } finally {
    try {
      await search.request('DELETE', '/' + index);
    } catch (error) {
      if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
    }
  }
});
