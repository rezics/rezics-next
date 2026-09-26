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
  const requests = write.requestBody.content['application/json'].schema.anyOf;
  const request = requests[0];
  expect(request.additionalProperties).toBe(false);
  expect(request.properties.profile.const).toBe('npm-lock-v3-topology-v1');
  expect(request.properties.lock.properties.bytesBase64.maxLength).toBe(349528);
  const receipts = read.responses['200'].content['application/json'].schema.anyOf;
  const receipt = receipts[0];
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
  expect(requests[1].properties.profile.const).toBe('npm-lock-v3-topology-v2');
  expect(requests[1].required).toContain('target');
  expect(requests[1].properties.target.additionalProperties).toBe(false);
  expect(receipts[1].properties.profile.const).toBe('npm-lock-topology-receipt-v2');
  const platform = receipts[1].properties.outcome.anyOf;
  expect(platform[0].properties.instances.items.required).toContain('optional');
  expect(platform[0].properties.instances.items.properties.peerHosts.items.required).toContain('optional');
  for (const outcome of platform.slice(1)) for (const field of [
    'instances', 'edges', 'activeInstances', 'activeEdges', 'omittedInstances', 'omittedEdges']) {
    expect(outcome.properties[field].maxItems).toBe(0);
  }
  expect(requests[2].properties.profile.const).toBe('npm-lock-v3-topology-v3');
  expect(requests[2].required).toContain('workspaces');
  expect(requests[2].properties.workspaces.maxItems).toBe(16);
  expect(requests[2].properties.workspaces.items.additionalProperties).toBe(false);
  expect(receipts[2].properties.profile.const).toBe('npm-lock-topology-receipt-v3');
  const identity = receipts[2].properties.outcome.anyOf;
  expect(identity[0].properties.instances.items.required).toEqual(expect.arrayContaining(['kind', 'slotName', 'linkTarget', 'peerHosts']));
  expect(identity[0].properties.edges.items.required).toContain('requestedName');
  for (const outcome of identity.slice(1)) for (const field of ['instances', 'edges']) {
    expect(outcome.properties[field].maxItems).toBe(0);
  }
  expect(requests[3].properties.profile.const).toBe('npm-lock-v3-topology-v4');
  expect(requests[3].required).toEqual(expect.arrayContaining(['workspaces', 'target']));
  expect(requests[3].additionalProperties).toBe(false);
  expect(receipts[3].properties.profile.const).toBe('npm-lock-topology-receipt-v4');
  const composition = receipts[3].properties.outcome.anyOf;
  expect(composition[0].properties.instances.items.required)
    .toEqual(expect.arrayContaining(['kind', 'slotName', 'linkTarget', 'peerHosts', 'optional', 'os', 'cpu']));
  expect(composition[0].properties.omittedEdges.items.required).toEqual(expect.arrayContaining(['requestedName', 'causePath']));
  expect(composition[0].properties.cost.properties.graphVisits.maximum).toBe(65537);
  for (const outcome of composition.slice(1)) for (const field of [
    'instances', 'edges', 'activeInstances', 'activeEdges', 'omittedInstances', 'omittedEdges']) {
    expect(outcome.properties[field].maxItems).toBe(0);
  }
});
