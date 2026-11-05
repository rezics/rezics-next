import { expect, test } from 'bun:test';

test('cold community production imports initialize the frozen platform root anchor', async () => {
  const source = `
    await import('./src/community/space.ts');
    await import('./src/community/realm.ts');
    const { platformRootAnchor } = await import('./src/commerce/catalogue.ts');
    const resource = platformRootAnchor.resource;
    console.log(JSON.stringify({
      anchorFrozen: Object.isFrozen(platformRootAnchor),
      resourceFrozen: Object.isFrozen(resource),
      route: resource.route,
      id: resource.id,
    }));
  `;
  const child = Bun.spawn([process.execPath, '--eval', source], {
    cwd: `${import.meta.dir}/../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();

  expect(await child.exited).toBe(0);
  expect(await output).toBe(
    JSON.stringify({
      anchorFrozen: true,
      resourceFrozen: true,
      route: 0,
      id: '00000000-0000-8000-8000-000000000000',
    }),
  );
  expect(await errors).toBe('');
});
