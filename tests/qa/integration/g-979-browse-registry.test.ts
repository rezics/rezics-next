import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AdmittedTypeStore } from '../../../services/main/src/modules/types/store.ts';
import { compileQuery } from '../../../services/main/src/modules/query/compile.ts';
import { installRegisteredTypes } from '../../../services/main/src/modules/types/registry.ts';
import { TYPES_READ_COST } from '../../../services/main/src/modules/types/contract.ts';
import { browseCategories } from '../../../apps/web/features/catalogue/registry.ts';
import { clearTypes } from '../../../apps/web/features/catalogue/types.ts';
import { forgetServedTypes, readTypes } from '../../../apps/web/features/catalogue/types-read.ts';
import {
  browseQuery,
  emptyBrowse,
  parseBrowseState,
} from '../../../apps/web/features/discover/browse-state.ts';

test('G979: Main refreshes the real owner registry and serves cached categories that Discover maps to admitted Type Facets', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.FUSEKI_URL)
    throw new Error('Run through the isolated QA integration tier');
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const types = new AdmittedTypeStore(pool);
  const app = createMainApp(fuseki, { types } as MainWorkDependencies);
  const statuses: number[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const response = await app.handle(
      new Request('http://main.local/v1/types', { headers: init.headers }),
    );
    statuses.push(response.status);
    return response;
  }) as typeof fetch;
  clearTypes();
  forgetServedTypes();
  try {
    const registry = await readTypes(fetcher, () => 0);
    expect(statuses).toEqual([200]);
    expect(registry?.profile).toBe('types-v1');
    const categories = browseCategories();
    expect(categories.map((category) => category.id)).toEqual([
      'works',
      'communities',
      'sites',
      'people',
      'lists',
      'topics',
    ]);
    for (const category of categories) {
      const state = parseBrowseState({ tab: category.id })!;
      const query = browseQuery(state);
      const compiled = compileQuery(query);
      expect(compiled.template).toBe('resource-list');
      if (compiled.template !== 'resource-list') throw new Error('Wrong resource query template');
      expect(compiled.request.conditions).toEqual([
        { facet: 'type', operator: 'any', values: category.types },
      ]);
      expect(category.labels.ja).not.toBe('');
    }
    expect(compileQuery(browseQuery(emptyBrowse)).template).toBe('resource-list');
    expect(Buffer.byteLength(JSON.stringify(registry))).toBeLessThanOrEqual(
      TYPES_READ_COST.maxBytes,
    );
    const conditional = await readTypes(fetcher, () => 301_000);
    expect(statuses).toEqual([200, 304]);
    expect(conditional?.digest).toBe(registry?.digest);
    expect(browseCategories()).toEqual(categories);
  } finally {
    clearTypes();
    forgetServedTypes();
    installRegisteredTypes([]);
    await pool.end();
  }
}, 60_000);
