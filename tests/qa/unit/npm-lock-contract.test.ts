import { expect, test } from 'bun:test';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';

test('PKG03/PKG12/PKG13: npm contract exposes private immutable topology receipts and empty failure graphs', async () => {
  const spec = JSON.parse(await buildMainOpenApi());
  const write = spec.paths['/v1/package-resolutions/npm'].post;
  const read = spec.paths['/v1/package-resolutions/npm/{resolution}'].get;
  for (const operation of [write, read]) {
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    for (const code of ['401', '403', '503']) expect(operation.responses[code]).toBeDefined();
  }
  expect(read.responses['404']).toBeDefined();
  expect(write.parameters.some((parameter: { name: string; required: boolean }) =>
    parameter.name === 'Idempotency-Key' && parameter.required)).toBe(true);
  for (const code of ['200', '201', '409', '422']) expect(write.responses[code]).toBeDefined();
  const request = write.requestBody.content['application/json'].schema;
  expect(request.additionalProperties).toBe(false);
  expect(request.properties.profile.const).toBe('npm-lock-v3-topology-v1');
  expect(request.properties.lock.properties.bytesBase64.maxLength).toBe(349528);
  const receipt = read.responses['200'].content['application/json'].schema;
  expect(receipt.properties.profile.const).toBe('npm-lock-topology-receipt-v1');
  const outcomes = receipt.properties.outcome.anyOf;
  expect(outcomes[0].properties.status.const).toBe('validated');
  expect(outcomes[0].properties.lockfileVersion.const).toBe(3);
  expect(outcomes[0].properties.instances.items.properties.peerHosts.items.required)
    .toEqual(['name', 'specifier', 'host', 'path']);
  for (const outcome of outcomes.slice(1)) {
    expect(outcome.properties.instances.maxItems).toBe(0);
    expect(outcome.properties.edges.maxItems).toBe(0);
  }
});
