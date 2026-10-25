import { expect, test } from 'bun:test';

type Operation = Record<string, unknown>;
const contract = (await Bun.file(new URL('../../../../contracts/openapi.json', import.meta.url)).json()) as {
  paths: Record<string, Record<string, Operation>>;
};
const semantic = (path: string) =>
  ['/v1/subjects', '/v1/definitions', '/v1/contexts'].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}:`),
  );

test('every semantic write route declares its write rate cost', () => {
  const writes = Object.entries(contract.paths)
    .filter(([path]) => semantic(path))
    .flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([method, operation]) => {
          const action = operation['x-action'];
          return method !== 'get' && typeof action === 'string' && !action.endsWith(':read');
        })
        .map(([method, operation]) => ({
          route: `${method} ${path}`,
          limit: operation['x-rate-limit'],
          expected: { family: 'write', units: operation['x-action'] === 'subject:batch_write' ? 'commands' : 1 },
        })),
    );
  expect(writes.length).toBeGreaterThan(0);
  for (const { route, limit, expected } of writes) expect({ route, limit }).toEqual({ route, limit: expected });
});
