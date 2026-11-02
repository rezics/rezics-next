import { createKernelClient } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import historical from '../../../../../packages/definitions/test/fixtures/bundled-historical-construction.json';
import definitions from '../recorded/definitions-release.json';
import {
  definitionText,
  fetchGuideRelease,
  readGuideDirectory,
  readGuideType,
  readGuide,
  type GuideAddress,
  type GuideLocale,
  type GuideTransport,
} from '../../features/catalogue/definition-guide';
import type { FakeRoute } from '../fake-modules';

const activeRelease = definitions.release as Release;

// Digest of the existing immutable historical fixture, not a fabricated historical label for the active bundle.
export const historicalGuideDigest = 'sha256:eb8bc8b685e4f8e12897e0e9ac0ab978a8eff60102053081bd95ef4af0688702';
export type GuideScenario =
  | 'active'
  | 'pinned'
  | 'missing-meaning'
  | 'empty'
  | 'loading'
  | 'denied'
  | 'invalid'
  | 'unavailable';

/** Isolated native-shaped definition responses for page stories and focused request tests; never installed at runtime. */
export function definitionGuideFixture(scenario: GuideScenario = 'active') {
  const calls: { path: string; method: string; authorization: string | null }[] = [];
  let attempts = 0;
  const client = createKernelClient('https://guide.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = decodeURIComponent(new URL(request.url).pathname);
      calls.push({ path, method: request.method, authorization: request.headers.get('authorization') });
      if (scenario === 'loading') return new Promise<Response>(() => {});
      if (scenario === 'denied') return Response.json({ code: 'invalid_credentials' }, { status: 401 });
      if (scenario === 'unavailable' && attempts++ === 0) return Response.json({ code: 'overloaded' }, { status: 503 });
      if (path === `/v1/definitions/releases/${historicalGuideDigest}`)
        return Response.json({ digest: historicalGuideDigest, release: historical as Release });
      if (path === `/v1/definitions/releases/${definitions.digest}`) {
        if (scenario === 'invalid') return Response.json({ digest: 'wrong-release', release: definitions.release });
        return Response.json(
          scenario === 'empty' ? { digest: definitions.digest, release: { types: {}, properties: {} } } : definitions,
        );
      }
      if (path === '/v1/definitionTypes') {
        const locale = (new URL(request.url).searchParams.get('locale') ?? 'en') as GuideLocale;
        const search = new URL(request.url).searchParams;
        const prefix = search.get('query') ?? '';
        const offset = Number(search.get('cursor') ?? 0);
        const all = Object.entries(scenario === 'empty' ? {} : activeRelease.types)
          .map(([typeId, definition]) => {
            const label = definitionText(definition.labels, locale);
            const description = definitionText(definition.descriptions, locale);
            return {
              typeId,
              releaseDigest: scenario === 'invalid' ? 'wrong-release' : definitions.digest,
              label: label.text || typeId,
              language: label.lang,
              parents: [],
              description: description.text || null,
              descriptionLanguage: description.lang,
            };
          })
          .sort((left, right) =>
            left.label === right.label
              ? left.typeId < right.typeId
                ? -1
                : left.typeId > right.typeId
                  ? 1
                  : 0
              : left.label < right.label
                ? -1
                : 1,
          )
          .filter((entry) => entry.label.startsWith(prefix));
        const limit = Number(search.get('limit') ?? 20);
        const types = all.slice(offset, offset + limit);
        return Response.json({ types, next: offset + limit < all.length ? String(offset + limit) : null });
      }
      if (path.startsWith('/v1/definitionTypes/')) {
        const typeId = path.slice('/v1/definitionTypes/'.length);
        const definition = activeRelease.types[typeId];
        if (!definition) return Response.json({ code: 'not_found' }, { status: 404 });
        const locale = (new URL(request.url).searchParams.get('locale') ?? 'en') as GuideLocale;
        const label = definitionText(definition.labels, locale);
        const description = definitionText(definition.descriptions, locale);
        return Response.json({
          typeId,
          releaseDigest: scenario === 'invalid' ? 'wrong-release' : definitions.digest,
          label: label.text || typeId,
          language: label.lang,
          parents: [],
          description: description.text || null,
          descriptionLanguage: description.lang,
          definition,
          properties: Object.fromEntries(definition.properties.map((id) => [id, activeRelease.properties[id]])),
        });
      }
      return Response.json({ code: 'not_found' }, { status: 404 });
    }) as typeof fetch,
  });
  const address: GuideAddress = {
    type: scenario === 'missing-meaning' || scenario === 'pinned' ? 'schema:Recipe' : 'schema:Book',
    ...(scenario === 'missing-meaning' || scenario === 'pinned' ? { property: 'schema:cookTime' } : {}),
    ...(scenario === 'pinned' ? { release: historicalGuideDigest } : {}),
  };
  if (scenario === 'empty') delete address.type;
  const transport: GuideTransport = {
    read: (selectedLocale = 'en') =>
      readGuide(
        address,
        (digest) => fetchGuideRelease(client, digest),
        () => readGuideDirectory(client, selectedLocale),
        (typeId) => readGuideType(client, typeId, selectedLocale),
      ),
    directory: (locale, query, cursor) => readGuideDirectory(client, locale, query, cursor),
    exact: (locale, typeId) => readGuideType(client, typeId, locale),
  };
  return { client, transport, address, calls };
}

export const routes: FakeRoute[] = [];
