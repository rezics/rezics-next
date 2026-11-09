import { expect, test } from 'bun:test';

test('ordinary Community composition precedes catalogue inspection and HTTP compilation', () => {
  const source = new URL('../../src/', import.meta.url);
  const modules = {
    value: 'typebox/value',
    runtime: new URL('composition/runtime-defaults.ts', source).href,
    kernel: new URL('http/kernel.ts', source).href,
    community: new URL('community/schemas.ts', source).href,
    content: new URL('content/schemas.ts', source).href,
    ports: new URL('community/domain-ports.ts', source).href,
    binding: new URL('community/adapters/bind.ts', source).href,
  };
  const script = `
    const { Value } = await import(${JSON.stringify(modules.value)});
    const community = await import(${JSON.stringify(modules.community)});
    const content = await import(${JSON.stringify(modules.content)});
    const ports = await import(${JSON.stringify(modules.ports)});
    const kernel = await import(${JSON.stringify(modules.kernel)});
    const binding = await import(${JSON.stringify(modules.binding)});
    const runtime = await import(${JSON.stringify(modules.runtime)});
    const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(11)]]) };
    const receiptKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(22)]]) };
    const defaults = runtime.createKernelRuntimeDefaults({
      env: {},
      tokens,
      receiptKeys,
      deadlineNow: () => 50,
    });
    if (ports.ContentRealmImageSchema !== content.RealmPresentationImageSchema) {
      throw new Error('ordinary runtime did not install the Content-owned Realm image schema');
    }

    const realmId = '00000000-0000-8000-8000-000000000001';
    const image = {
      id: '00000000-0000-8000-8000-000000000003',
      containerId: '00000000-0000-8000-8000-000000000004',
      digest: 'b'.repeat(64),
      width: 256,
      height: 256,
      variants: [{ format: 'avif', width: 256, height: 256 }],
      placeholder: { thumbhash: 'abc', color: '#123456' },
      focalPoint: { x: 0.25, y: 0.75 },
      credit: null,
    };
    const response = {
      realms: [{ realmId, spaceId: '00000000-0000-8000-8000-000000000002', name: 'Example', description: '', avatar: image }],
      next: null,
    };
    if (!Value.Check(community.discoveryResponseSchema(), response)) {
      throw new Error('mounted Community schema rejected the Content-owned image fields');
    }

    const pool = new Proxy({}, {
      get(_target, key) {
        if (key === 'on') return () => pool;
        throw new Error('database touched while constructing the Kernel: ' + String(key));
      },
    });
    const dependencies = { ...defaults, pool, routeKey: new Uint8Array(32).fill(33) };
    const actions = kernel.createKernelActionCatalogue(dependencies);
    kernel.createKernel(dependencies);
    kernel.createKernel(dependencies);
    if (actions.length === 0) throw new Error('Community actions were missing from the mounted catalogue');
    const application = binding.tryCommunityApplication();
    if (!application || !application.elapsed(50) || application.elapsed(51)) {
      throw new Error('repeated Kernel construction lost the supplied Community deadline ambient');
    }
    console.log('ordinary Community Kernel constructed');
  `;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe('ordinary Community Kernel constructed');
});
