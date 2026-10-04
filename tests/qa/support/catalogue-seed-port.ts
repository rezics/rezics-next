import type { SeedPort } from '../../../scripts/dev/seed/vn-catalogue-step.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { catalogueFixture } from './catalogue-fixture.ts';

export interface SeedWork {
  key: string;
  title: string;
  language: string;
  semanticTypes: string[];
}

/** Keep the VN/release/Zone recipe, preparing its independent Work identities
 * with real public bulk receipts. Only the declared creation intents use those
 * receipts; all subsequent edits, publications, reads and replays use Main. */
export async function catalogueSeedPort(
  port: SeedPort,
  items: readonly SeedWork[],
): Promise<SeedPort> {
  const api = workProfileCorpusApi('http://main.local', 'seed-port', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const response = await port.request(
        'POST',
        new URL(request.url).pathname,
        await request.json(),
        request.headers.get('idempotency-key')!,
      );
      return Response.json(response.body, { status: response.status });
    }) as typeof fetch,
  });
  const works = await catalogueFixture(
    api,
    port.actingSubject,
    port.grant,
    items.map((item) => ({
      key: item.key,
      input: {
        profile: 'work-catalogue-import-v1',
        expectedWorkHead: null,
        title: item.title,
        language: item.language,
        semanticTypes: item.semanticTypes,
        aliases: [],
        credits: [],
        classifications: [],
        evidence: 'VNDB Zone integration catalogue fixture',
      },
    })),
  );
  const prepared = new Map(items.map((item, index) => [item.key, { item, work: works[index]! }]));
  return {
    ...port,
    async request(method, path, body, key) {
      const saved =
        key && method === 'POST' && path === '/v1/works' ? prepared.get(key) : undefined;
      if (!saved) return port.request(method, path, body, key);
      const expected = {
        profile: 'metadata-only-v1',
        title: saved.item.title,
        language: saved.item.language,
        semanticTypes: saved.item.semanticTypes,
        actingSubject: port.actingSubject,
        authoring: 'own-work',
      };
      const actual = body as Record<string, unknown>;
      if (
        !actual ||
        Object.keys(actual).length !== Object.keys(expected).length ||
        Object.entries(expected).some(
          ([field, value]) => JSON.stringify(actual[field]) !== JSON.stringify(value),
        )
      )
        throw new Error(`Prepared catalogue Work intent changed: ${key}`);
      return { status: 201, body: { ...saved.work, replayed: false } };
    },
  };
}
