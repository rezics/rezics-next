import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { RecoveryEffectCommand, RecoveryStatus } from '../src/library/archive-collection-recovery/contract';

mock.module('../src/session/request', () => ({
  prepareSession: async () => true,
  viewerCredential: () => 'Bearer current-viewer',
}));
const { kernelArchiveCollectionRecoveryPort, nativeArchiveCollectionRecovery } =
  await import('../src/library/archive-collection-recovery/native');

const uploadId = '00000000-0000-4000-8000-000000000011';
const status: RecoveryStatus = {
  uploadId,
  state: 'preview',
  createdAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  manifest: null,
  coverage: [],
  sourceRecordCount: 0,
  selectedCollectionId: null,
  selectedOccurrences: 0,
  cancelRequested: false,
  collectionId: null,
  confirmation: null,
  pin: { state: 'unsupported', reason: null },
  sectionReasons: {},
};
const command: Extract<RecoveryEffectCommand, { kind: 'upload' }> = {
  kind: 'upload',
  key: 'original-upload-key',
  body: { archiveBase64: 'e30=' },
};

test('the generated native route receives the exact private upload command and an uncertain response retains it verbatim', async () => {
  const requests: Request[] = [];
  let fetches = 0;
  let responseStatus = 200;
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      fetches++;
      requests.push(new Request(input, init));
      return responseStatus === 200
        ? Response.json(status)
        : Response.json({ code: 'temporarily_unavailable' }, { status: responseStatus });
    }) as typeof fetch,
  });
  expect(nativeArchiveCollectionRecovery(client)).toBeTruthy();
  const request = new Request('https://site.test/library/recovery', { headers: { cookie: 'private-session' } });
  const port = kernelArchiveCollectionRecoveryPort(client, request, {}, true);
  expect(await port.upload(command)).toEqual({ kind: 'ok', value: status });
  expect(requests[0]?.url).toContain('/v1/libraryArchiveCollectionRecoveries');
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer current-viewer');
  expect(requests[0]?.headers.get('idempotency-key')).toBe(JSON.stringify(command.key));
  expect(await requests[0]?.clone().json()).toEqual(command.body);

  const closed = kernelArchiveCollectionRecoveryPort(
    client,
    new Request('https://site.test/library/recovery'),
    {},
    false,
  );
  expect(await closed.upload(command)).toEqual({ kind: 'unavailable' });
  expect(fetches).toBe(1);

  responseStatus = 503;
  const uncertain = await port.upload(command);
  expect(uncertain).toEqual({ kind: 'unknown', command });
});
