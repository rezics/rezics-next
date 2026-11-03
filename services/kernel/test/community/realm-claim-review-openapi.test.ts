import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { kernelContract } from '../../scripts/openapi.ts';

test('Kernel generates the Realm claim review operations from its mounted routes', async () => {
  const generated = await kernelContract();
  const output = resolve(import.meta.dir, '../../../../.temp/claim-review-openapi.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, generated);

  const document = JSON.parse(generated) as {
    paths?: Record<string, Record<string, { operationId?: string }>>;
  };
  expect(document.paths?.['/v1/realms/{realmId}/claimRequests']?.get?.operationId).toBe('realm.claim_requests');
  expect(document.paths?.['/v1/realms/{realmId}/claimRequests/mine']?.get?.operationId).toBe('realm.own_claim_request');
  expect(document.paths?.['/v1/realms/{realmId}/claimRequests/{requestId}']?.get?.operationId).toBe(
    'realm.claim_request_status',
  );
});
