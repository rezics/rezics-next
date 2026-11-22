import { expect, test } from 'bun:test';
import { MinecraftVersions } from '../src/minecraft-versions.ts';

function fixture() {
  const requests: URL[] = [];
  const versions = new MinecraftVersions((async (input, options) => {
    options?.signal?.throwIfAborted();
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith('maven-metadata.json')) {
      return Response.json({
        '1.20.1': ['1.20.1-47.4.9', '1.20.1-47.4.10', '1.20.2-48.0.0', '1.20.1-malformed'],
        '1.19.2': ['1.19.2-43.5.2'],
        '26.3': ['26.3-66.1.8', '26.3-66.1.9'],
      });
    }
    if (url.pathname.startsWith('/api/maven/versions/')) {
      return Response.json({
        versions: [
          '21.0.167',
          '21.1.206',
          '21.1.207-beta',
          '21.2.1',
          '26.3.1.10',
          '26.3.0.9',
          '26.3.0.100',
          '26.3.0.101-beta',
        ],
      });
    }
    if (url.hostname === 'piston-meta.mojang.com') {
      return Response.json({
        versions: ['1.20.1', '1.19.2', '26.3'].map((id) => ({
          id,
          type: 'release',
          url: `https://piston-meta.mojang.com/v1/packages/abc/${id}.json`,
        })),
      });
    }
    if (url.pathname.endsWith('.jar.sha1')) return new Response('A'.repeat(40));
    throw new Error(`Unexpected catalogue request ${url}`);
  }) as typeof fetch);
  return { requests, versions };
}

test('projects exact compatible Forge and NeoForge builds and rejects mismatched selections', async () => {
  const { versions, requests } = fixture();
  expect(await versions.listForgeVersions('1.20.1')).toEqual([
    { id: '47.4.10', stable: true },
    { id: '47.4.9', stable: true },
  ]);
  expect(await versions.listNeoForgeVersions('1.21.1')).toEqual([
    { id: '21.1.207-beta', stable: false },
    { id: '21.1.206', stable: true },
  ]);
  expect(await versions.listForgeVersions('1.21.1')).toEqual([]);
  expect(await versions.listNeoForgeVersions('1.21.10')).toEqual([]);
  expect(await versions.listNeoForgeVersions('1.21')).toEqual([{ id: '21.0.167', stable: true }]);
  expect(await versions.listNeoForgeVersions('1.20.1')).toEqual([]);
  expect(await versions.listNeoForgeVersions('26.3')).toEqual([
    { id: '26.3.0.101-beta', stable: false },
    { id: '26.3.0.100', stable: true },
    { id: '26.3.0.9', stable: true },
  ]);
  expect(await versions.listNeoForgeVersions('26.3.1')).toEqual([{ id: '26.3.1.10', stable: true }]);
  expect(await versions.listForgeVersions('1.19.2')).toEqual([{ id: '43.5.2', stable: true }]);
  expect(await versions.select({ name: 'Forge', loader: 'forge', version: '1.20.1' })).toEqual({
    version: '1.20.1',
    loader: 'forge',
    forgeVersion: '47.4.10',
  });
  const neo = await versions.select({ name: 'NeoForge', loader: 'neoforge', version: '1.21.1' });
  expect(neo).toEqual({ version: '1.21.1', loader: 'neoforge', neoForgeVersion: '21.1.206' });
  expect(await versions.select({ name: 'Latest', loader: 'neoforge', version: '26.3' })).toMatchObject({
    neoForgeVersion: '26.3.0.100',
  });
  await expect(
    versions.select({ name: 'Wrong', loader: 'forge', version: '1.20.2', forgeVersion: '47.4.10' }),
  ).rejects.toThrow('does not have this Forge loader');
  await expect(
    versions.select({ name: 'Wrong', loader: 'neoforge', version: '1.21.1', forgeVersion: '47.4.10' }),
  ).rejects.toThrow('chosen Minecraft loader');
  const signal = new AbortController().signal;
  if (neo.loader !== 'neoforge') throw new Error('Expected a NeoForge selection.');
  expect(await versions.loaderInstaller(neo, signal)).toEqual({
    url: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.206/neoforge-21.1.206-installer.jar',
    sha1: 'a'.repeat(40),
  });
  await expect(
    versions.loaderInstaller({ version: '26.3', loader: 'neoforge', neoForgeVersion: '26.3.1.10' }, signal),
  ).rejects.toThrow('unavailable for this Minecraft release');
  expect(
    await versions.loaderInstaller({ version: '1.20.1', loader: 'forge', forgeVersion: '47.4.9' }, signal),
  ).toEqual({
    url: 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.9/forge-1.20.1-47.4.9-installer.jar',
    sha1: 'a'.repeat(40),
  });
  expect(requests.filter(({ pathname }) => pathname.includes('maven-metadata'))).toHaveLength(1);
  expect(requests.filter(({ pathname }) => pathname.startsWith('/api/maven/versions/'))).toHaveLength(1);
});
