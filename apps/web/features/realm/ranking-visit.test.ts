import { expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import { rankingVisitHost } from './ranking-visit.tsx';

test('ranking visit carries Main address reads and personal BFF reads through one transport', async () => {
  const requests: Request[] = [];
  const credentials: (RequestCredentials | undefined)[] = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    credentials.push(init?.credentials);
    return Response.json({});
  }) as typeof fetch;
  const host = rankingVisitHost(send, true);
  await host.fetch('https://recorded.invalid/v1/addresses/resolve?scope=space&key=garden', {
    headers: { 'accept-language': 'ja', 'if-none-match': '"original"' },
  });
  await host.read('/v1/me/session-agent', true);
  expect(requests.map(request => new URL(request.url).pathname)).toEqual([
    '/api/main/v1/addresses/resolve', '/api/main/v1/me/session-agent',
  ]);
  expect(new URL(requests[0]!.url).searchParams.get('key')).toBe('garden');
  expect(credentials[0]).toBe('omit');
  expect(requests[0]!.headers.get('accept-language')).toBe('ja');
  expect(requests[0]!.headers.get('if-none-match')).toBe('"original"');
  expect(credentials[1]).toBe('same-origin');
});
