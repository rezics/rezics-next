import { expect, test } from 'bun:test';

test('native preload binds Content schemas before cold Community response construction', () => {
  const source = new URL('../../src/', import.meta.url);
  const modules = {
    value: 'typebox/value',
    community: new URL('community/schemas.ts', source).href,
    content: new URL('content/schemas.ts', source).href,
    ports: new URL('community/domain-ports.ts', source).href,
    preload: new URL('composition/preload.ts', source).href,
    composition: new URL('composition/community.ts', source).href,
  };
  const script = `
    const { Value } = await import(${JSON.stringify(modules.value)});
    const community = await import(${JSON.stringify(modules.community)});
    const content = await import(${JSON.stringify(modules.content)});
    const ports = await import(${JSON.stringify(modules.ports)});
    const preload = await import(${JSON.stringify(modules.preload)});
    const composition = await import(${JSON.stringify(modules.composition)});
    preload.installNativeHistoryPreload();
    if (ports.ContentRealmImageSchema !== content.RealmPresentationImageSchema) {
      throw new Error('native preload did not install the Content-owned Realm image schema');
    }
    const first = composition.composeCommunityApplication();
    const second = composition.composeCommunityApplication();
    if (first !== second) throw new Error('repeated native composition replaced the Community ambient');

    const realmId = '00000000-0000-8000-8000-000000000001';
    const spaceId = '00000000-0000-8000-8000-000000000002';
    const image = {
      id: '00000000-0000-8000-8000-000000000003',
      containerId: '00000000-0000-8000-8000-000000000004',
      digest: 'a'.repeat(64),
      width: 128,
      height: 128,
      variants: [{ format: 'webp', width: 128, height: 128 }],
      placeholder: null,
      focalPoint: null,
      credit: null,
    };
    const response = {
      realms: [{ realmId, spaceId, name: 'Example', description: 'Community image', avatar: image }],
      next: null,
    };
    if (!Value.Check(community.discoveryResponseSchema(), response)) {
      throw new Error('Community rejected the Content Realm image response shape');
    }
    if (Value.Check(community.discoveryResponseSchema(), {
      ...response,
      realms: [{ ...response.realms[0], avatar: { ...image, originalUrl: 'https://private.invalid/image' } }],
    })) {
      throw new Error('Community accepted a field outside Content image disclosure');
    }
    community.RealmSchema();
    community.SpaceSchema();
    community.SitemapRealmPageSchema();
    community.SitemapSpacePageSchema();
    console.log('native Community schemas installed');
  `;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe('native Community schemas installed');
});
