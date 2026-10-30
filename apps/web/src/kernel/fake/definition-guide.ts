import { createKernelClient } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import historical from '../../../../../packages/definitions/test/fixtures/bundled-historical-construction.json';
import definitions from '../recorded/definitions-release.json';
import {
  fetchGuideRelease,
  readGuide,
  type GuideAddress,
  type GuideTransport,
} from '../../features/catalogue/definition-guide';
import type { FakeRoute } from '../fake-modules';

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
      if (path === '/v1/definitions/active') return Response.json({ digest: definitions.digest, head: 1 });
      if (path === `/v1/definitions/releases/${historicalGuideDigest}`)
        return Response.json({ digest: historicalGuideDigest, release: historical as Release });
      if (path === `/v1/definitions/releases/${definitions.digest}`) {
        if (scenario === 'invalid') return Response.json({ digest: 'wrong-release', release: definitions.release });
        return Response.json(
          scenario === 'empty' ? { digest: definitions.digest, release: { types: {}, properties: {} } } : definitions,
        );
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
  const transport: GuideTransport = { read: () => readGuide(address, (digest) => fetchGuideRelease(client, digest)) };
  return { client, transport, address, calls };
}

export const routes: FakeRoute[] = [];
