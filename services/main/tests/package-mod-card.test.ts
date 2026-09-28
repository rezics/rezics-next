import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { ModProfileInvalid, type ModResolution, ModResolutionStore }
  from '../src/modules/package/mod-resolution.ts';
import { solveModCaptures, type ModRequest } from '../src/modules/package/mod-profile.ts';

function receipt(ecosystem: 'fabric' | 'forge', version: string): ModResolution {
  const manifest = ecosystem === 'fabric'
    ? JSON.stringify({ schemaVersion: 1, id: 'samplemod', version, environment: 'client', depends: {} })
    : `modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\n[[mods]]\nmodId="samplemod"\nversion="${version}"\n`;
  const bytes = Buffer.from(manifest);
  const request: ModRequest = { profile: 'mod-native-capture-v1', ecosystem,
    side: 'CLIENT', root: 'samplemod', runtime: { loaderVersion: '52', gameVersion: '1.21.1' },
    captures: [{ identity: 'samplemod', surface: 'manifest', status: 'observed',
      bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }] };
  return { profile: 'mod-native-capture-receipt-v1', resolution: 'https://rezics.com/id/00000000-0000-0000-0000-000000000001',
    requestDigest: '0'.repeat(64), request, outcome: solveModCaptures(request),
    createdAt: '2026-09-28T00:00:00.000Z' };
}

test('public mod card derives only game, loader and release from a valid native receipt', () => {
  expect(ModResolutionStore.card(receipt('fabric', '1.3.0'))).toEqual({
    profile: 'mod-work-card-v1', game: 'Minecraft', gameVersions: ['1.21.1'],
    loaders: ['Fabric'], latestRelease: '1.3.0', capturedAt: '2026-09-28T00:00:00.000Z',
  });
  expect(ModResolutionStore.card(receipt('forge', '1.4.2'))).toMatchObject({
    loaders: ['Forge'], latestRelease: '1.4.2',
  });
  expect(JSON.stringify(ModResolutionStore.card(receipt('fabric', '1.3.0'))))
    .not.toContain('bytesBase64');
});

test('an incomplete native outcome cannot become a public compatibility claim', () => {
  const invalid = receipt('fabric', '1.3.0');
  invalid.outcome.selection = 'incomplete-source-data';
  expect(() => ModResolutionStore.card(invalid)).toThrow(ModProfileInvalid);
});
