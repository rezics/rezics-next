import { expect, test } from 'bun:test';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BootstrapApiError, HttpBootstrapApi, type BootstrapApi } from '../bootstrap/api.ts';
import { BootstrapJournal, digest } from '../bootstrap/journal.ts';
import { checkedPlan, loadPlan } from '../bootstrap/plan.ts';
import { executeBootstrap, resource, verifyBootstrap } from '../bootstrap/execute.ts';
import { baselineTarget } from '../../../services/main/src/modules/access/baseline.ts';
import { relationLexiconSeed } from '../../dev/seed/relation-lexicon-data.ts';

const root = resolve(import.meta.dir, '../../..');
const native = (name: string) => resource('test', name);
async function fixture() {
  const { plan, zones } = await loadPlan(root, 'tests/fixtures/launch/plan.yaml', false);
  plan.namespace = `g-724-${crypto.randomUUID().slice(0, 8)}`;
  plan.operators[0]!.accountSubject = 'operator';
  const journal = new BootstrapJournal(
    {
      profile: 'launch-bootstrap-journal-v1',
      planDigest: digest({ plan, zones }),
      actor: plan.operators[0]!.actingSubject,
      entries: {},
    },
    async () => {},
  );
  const headers = new Map<
    string,
    {
      revision: string;
      mounts: { target: string }[];
      name: string;
      language: string;
      configuration: unknown;
    }
  >();
  const collections = new Map<
    string,
    { structure: string; revision: string; occurrences: { target: string }[] }
  >();
  const definitions = new Map<string, { definition: string }>();
  let writes = 0,
    searches = 0,
    stop = false,
    loseResponse = false,
    conflict = false;
  const remoteWorks = new Map<string, unknown>();
  const workDescriptions = new Map<string, unknown>();
  const requests: { method: string; path: string; body: Record<string, unknown>; key: string }[] =
    [];
  const api: BootstrapApi = {
    async read<T>(path: string): Promise<T> {
      path = new URL(path, 'https://main.example').pathname;
      if (path === '/v1/types')
        return {
          profile: 'types-v1',
          digest: 'c'.repeat(64),
          types: [{ type: 'https://schema.org/VideoGame', base: 'work' }],
        } as T;
      if (path.startsWith('/v1/lexicon/definitions/'))
        return definitions.get(path.split('/').at(-1)!) as T;
      if (path.startsWith('/v1/addresses/resolve?')) {
        const id = new URL(path,'https://main.test').searchParams.get('key')!;
        return { capabilities: { zone: resource(plan.namespace, `zone:${id}`) } } as T;
      }
      if (path.startsWith('/v1/zones/')) {
        if (path.includes('/presentation')) return {} as T;
        return headers.get(path.split('/')[3]!) as T;
      }
      if (path.startsWith('/v1/collections/'))
        return { ...collections.get(path.split('/')[3]!)!, next: null } as T;
      if (path.startsWith('/v1/works/'))
        return {
          id: native('imported-work'),
          verification: 'verified',
          description: workDescriptions.get(native('imported-work')),
        } as T;
      return {} as T;
    },
    async write<T>(method: 'POST' | 'PUT', path: string, value: unknown, key: string): Promise<T> {
      const body = value as Record<string, unknown>;
      requests.push({ method, path, body, key });
      if (path.endsWith('/metadata')) {
        const state = body.state as { localized: { description: string; language: string }[] };
        workDescriptions.set(native('imported-work'), {
          value: state.localized[0]!.description,
          language: state.localized[0]!.language,
        });
        return { revision: native('metadata'), receipt: native('metadata-receipt') } as T;
      }
      if (path === '/v1/catalogue/candidates') {
        searches++;
        return {
          candidateReceipt: '00000000-0000-4000-a000-000000000001',
          candidates: conflict ? [{ work: native('candidate') }] : [],
        } as T;
      }
      if (stop && path === '/v1/works') {
        stop = false;
        throw new Error('Interrupted after intake and candidate search');
      }
      if (path === '/v1/works' && remoteWorks.has(key)) return remoteWorks.get(key) as T;
      writes++;
      if (path === '/v1/spaces')
        return { realm: native(`realm:${body.name}`), space: native(`space:${body.name}`) } as T;
      if (path === '/v1/zones') {
        headers.set(String(body.zone).slice(-36), {
          revision: native('zone-head'),
          mounts: [],
          name: '',
          language: 'en',
          configuration: { defaultRealm: null, official: null, presentation: {} },
        });
        return { revision: native('zone-head') } as T;
      }
      if (path === '/v1/collections') {
        const saved = {
          structure: native(`structure:${body.collection}`),
          revision: native('collection-head'),
          occurrences: [],
        };
        collections.set(String(body.collection).slice(-36), saved);
        return saved as T;
      }
      if (path.includes('/mounts')) {
        headers.get(path.split('/')[3]!)!.mounts.push({ target: body.target as string });
        return {} as T;
      }
      if (path.includes('/configuration')) {
        const header = headers.get(path.split('/')[3]!)!;
        Object.assign(header, {
          name: body.name,
          language: body.language,
          configuration: {
            defaultRealm: body.defaultRealm,
            official: body.official,
            presentation: body.presentation,
          },
        });
        return { revision: native('configuration-head') } as T;
      }
      if (path === '/v1/semantic/changes') {
        const state = body.state as { notation: string };
        const component = native(state.notation);
        definitions.set(state.notation, { definition: component });
        return { component, revision: native(`${state.notation}:revision`) } as T;
      }
      if (path === '/v1/lexicon/presentations')
        return { component: native(key), revision: native(`${key}:revision`) } as T;
      if (path === '/v1/sources/intakes')
        return { observation: { observation: native('observation') } } as T;
      if (path === '/v1/works') {
        const confirmed = {
          work: native('imported-work'),
          workRevision: native('work-revision'),
          mainVersion: native('main'),
          mainRevision: native('main-revision'),
        };
        remoteWorks.set(key, confirmed);
        workDescriptions.set(confirmed.work, body.description);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('Response lost after confirmed creation');
        }
        return confirmed as T;
      }
      if (path.includes('/catalogue-verifications'))
        return { receipt: `urn:rezics:receipt:${'d'.repeat(64)}` } as T;
      if (path.includes('/changes')) {
        const page = collections.get(path.split('/')[3]!)!;
        const operations = body.operations as { target: string }[];
        page.occurrences.push(...operations.map((item) => ({ target: item.target })));
        return { revision: native('members-head') } as T;
      }
      throw new Error(`Unexpected API write ${path}`);
    },
  };
  return {
    root,
    plan,
    zones,
    api,
    journal,
    requests,
    collections,
    counts: () => ({ writes, searches }),
    interrupt: () => {
      stop = true;
    },
    loseCreationResponse: () => {
      loseResponse = true;
    },
    conflict: () => {
      conflict = true;
    },
    remoteWorkCount: () => remoteWorks.size,
    close: () =>
      rm(join(root, '.temp/bootstrap', plan.namespace), { recursive: true, force: true }),
  };
}

test('G-724 refuses unowned production sources and pins data before mutation', async () => {
  const h = await fixture();
  try {
    expect(() => checkedPlan(h.plan, true)).toThrow('named steward');
    h.plan.sources[0]!.steward = 'Launch catalogue operator';
    h.plan.sources[0]!.backup = 'Backup catalogue operator';
    expect(checkedPlan(h.plan, true)).toEqual(h.plan);
    h.plan.sources[0]!.sliceSha256 = '0'.repeat(64);
    h.journal.state.planDigest = digest({ plan: h.plan, zones: h.zones });
    await expect(executeBootstrap(h)).rejects.toThrow('slice differs');
    expect(h.counts()).toEqual({ writes: 0, searches: 0 });
  } finally {
    await h.close();
  }
});

test('G-724 one API journey creates empty mounts, vocabulary and bounded intake; replay is a no-op', async () => {
  const h = await fixture();
  try {
    const first = await executeBootstrap(h);
    await verifyBootstrap(h.api, first, h.zones);
    expect(first.zones).toHaveLength(3);
    expect(first.definitions).toHaveLength(relationLexiconSeed.length);
    expect(first.counts).toEqual({ 'https://schema.org/VideoGame': 1 });
    expect(first.outcome.status).toBe('completed');
    expect(first.outcome.items[0]!.receipt).toMatch(/^urn:rezics:receipt:/);
    const before = h.counts();
    const replay = await executeBootstrap(h);
    expect(replay).toEqual(first);
    expect(h.counts()).toEqual(before);
    const intake = h.requests.find((request) => request.path === '/v1/sources/intakes')!;
    const searchIndex = h.requests.findIndex(
      (request) => request.path === '/v1/catalogue/candidates',
    );
    const createIndex = h.requests.findIndex((request) => request.path === '/v1/works');
    expect(searchIndex).toBeGreaterThan(h.requests.indexOf(intake));
    expect(createIndex).toBeGreaterThan(searchIndex);
    const creation = h.requests[createIndex]!.body;
    expect(creation.authoring).toBe('catalogue');
    expect(creation.grain).toBe('new-creative-scope');
    expect(creation.candidateReceipt).toBeTruthy();
    expect(JSON.stringify(creation.description)).toContain('VNDB contributors');
    expect(JSON.stringify(creation.description)).toContain('observation');
    expect(h.requests.filter((request) => request.path === '/v1/works')).toHaveLength(1);
    const wiki = first.zones.find((zone) => zone.id === 'franchise-wiki')!;
    expect(Object.keys(wiki.collections)).toEqual(['franchise', 'characters', 'places', 'events', 'chapters']);
    for (const collection of Object.values(wiki.collections))
      expect(h.collections.get(collection.slice(-36))!.occurrences).toEqual([]);
  } finally {
    await h.close();
  }
});

test('G-724 interruption retains the exact candidate receipt and does not repeat confirmed effects', async () => {
  const h = await fixture();
  try {
    h.interrupt();
    await expect(executeBootstrap(h)).rejects.toThrow('Interrupted');
    const attempted = h.requests.find((request) => request.path === '/v1/works')!;
    const recovered = await executeBootstrap(h);
    expect(recovered.outcome.status).toBe('completed');
    expect(h.counts().searches).toBe(1);
    const attempts = h.requests.filter((request) => request.path === '/v1/works');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempted);
  } finally {
    await h.close();
  }
});

test('G-724 denial remains unconfirmed; 202 and 429 preserve command key and principal', async () => {
  const calls: RequestInit[] = [],
    sleeps: number[] = [];
  const statuses = [202, 429, 201];
  const api = new HttpBootstrapApi(
    'https://main.example',
    () => 'operator-token',
    async (_url, init = {}) => {
      calls.push(init);
      return Response.json(
        { receipt: 'confirmed' },
        { status: statuses.shift()!, headers: { 'retry-after': '1' } },
      );
    },
    async (ms) => {
      sleeps.push(ms);
    },
  );
  expect(
    await api.write<{ receipt: string }>(
      'POST',
      '/v1/works',
      { title: 'Captured title' },
      'stable',
    ),
  ).toEqual({ receipt: 'confirmed' });
  expect(calls).toHaveLength(3);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[2]).toEqual(calls[0]);
  expect(sleeps).toEqual([1000, 1000]);
  const denied = new HttpBootstrapApi(
    'https://main.example',
    () => 'operator-token',
    async () =>
      Response.json({ code: 'authority_denied', detail: 'secret-cookie' }, { status: 403 }),
  );
  try {
    await denied.write('POST', '/v1/works', {}, 'stable');
    throw new Error('Expected denial');
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapApiError);
    expect(String(error)).toContain('authority_denied');
    expect(String(error)).not.toContain('secret-cookie');
  }
});

test('G-724 lost creation response resumes the same owner receipt without duplicate native Works', async () => {
  const h = await fixture();
  try {
    h.loseCreationResponse();
    await expect(executeBootstrap(h)).rejects.toThrow('Response lost');
    expect(h.remoteWorkCount()).toBe(1);
    const result = await executeBootstrap(h);
    expect(h.remoteWorkCount()).toBe(1);
    expect(h.counts().searches).toBe(1);
    expect(result.outcome.status).toBe('completed');
    const attempts = h.requests.filter((request) => request.path === '/v1/works');
    expect(attempts[1]).toEqual(attempts[0]);
  } finally {
    await h.close();
  }
});

test('G-724 observed placement still replays an unconfirmed command to recover its owner receipt', async () => {
  const h = await fixture();
  try {
    await executeBootstrap(h);
    const label = `bootstrap:${h.plan.namespace}:mount:light-novels:catalogue`;
    const pending = h.journal.state.entries[label]!;
    delete pending.response;
    const firstAttempt = h.requests.find((request) => request.key === label)!;
    await executeBootstrap(h);
    const attempts = h.requests.filter((request) => request.key === label);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(firstAttempt);
    expect(h.journal.state.entries[label]!.response).toBeDefined();
  } finally {
    await h.close();
  }
});

test('G-724 existing candidates require adjudication and do not create a native Work', async () => {
  const h = await fixture();
  try {
    h.conflict();
    await expect(executeBootstrap(h)).rejects.toThrow('candidate adjudication');
    expect(h.remoteWorkCount()).toBe(0);
    expect(h.requests.some((request) => request.path === '/v1/works')).toBe(false);
  } finally {
    await h.close();
  }
});

test('G-724 a mapping that contradicts retained source bytes fails before any writes', async () => {
  const h = await fixture();
  try {
    h.plan.sources[0]!.records[0]!.title.value = 'A title absent from the dump';
    h.journal.state.planDigest = digest({ plan: h.plan, zones: h.zones });
    await expect(executeBootstrap(h)).rejects.toThrow('mapping differs');
    expect(h.counts().writes).toBe(0);
  } finally {
    await h.close();
  }
});

test('G-724 bootstrap class guard excludes database writes and demo seed steps', async () => {
  const dir = resolve(import.meta.dir, '../bootstrap');
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(join(dir, file), 'utf8');
    expect(source).not.toMatch(
      /from\s+['"](?:pg|postgres|.*(?:operator|official-authority|state|vn-catalogue-step|franchises-step))['"]/,
    );
    expect(source).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+access\.|DELETE\s+FROM|new\s+Pool)\b/i);
    const imports = [...source.matchAll(/from\s+['"]([^'"]*dev\/seed\/[^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    expect(
      imports.every(
        (path) =>
          path?.endsWith('/relation-lexicon.ts') || path?.endsWith('/relation-lexicon-data.ts'),
      ),
    ).toBe(true);
  }
  expect(
    baselineTarget('lexicon.presentation.review', `semantic:edit:${native('definition')}`),
  ).toBeNull();
});

test('G-724 a reported partial operation and an exhausted preparation budget never become confirmation', async () => {
  const partial = new HttpBootstrapApi(
    'https://main.example',
    () => 'operator-token',
    async () =>
      Response.json({
        operationId: 'import',
        status: 'partial',
        continuation: 'import',
        items: [
          {
            ordinal: 1,
            target: native('pending'),
            state: 'uncertain',
            receipt: null,
            continuation: 'import',
            error: 'unknown-response',
          },
        ],
      }),
  );
  await expect(partial.write('POST', '/v1/works', {}, 'stable')).rejects.toThrow(
    'operation_unconfirmed',
  );
  let requests = 0;
  const exhausted = new HttpBootstrapApi(
    'https://main.example',
    () => 'operator-token',
    async () => {
      requests++;
      return Response.json({ receipt: 'never-dispatched' });
    },
    async () => {},
    0,
  );
  await expect(exhausted.write('POST', '/v1/works', {}, 'stable')).rejects.toThrow(
    'preparation budget',
  );
  expect(requests).toBe(0);
});
