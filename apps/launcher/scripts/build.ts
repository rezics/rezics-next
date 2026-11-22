import { copyFile, mkdir, rm } from 'node:fs/promises';
import { build } from 'vite';

const output = '.temp/app';
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await Promise.all([
  build(),
  copyFile('assets/rezics.png', `${output}/rezics.png`),
  buildDesktop('src/main/main.ts', `${output}/main.mjs`, 'esm'),
  buildDesktop('src/main/preload.ts', `${output}/preload.cjs`, 'cjs'),
  ...(process.platform === 'linux'
    ? [buildDesktop('scripts/rename-directory.ts', `${output}/rename-directory.mjs`, 'esm', 'bun')]
    : []),
]);

async function buildDesktop(
  entrypoint: string,
  output: string,
  format: 'cjs' | 'esm',
  target: 'node' | 'bun' = 'node',
) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target,
    format,
    external: ['electron'],
    sourcemap: process.argv.includes('--debug') ? 'inline' : 'none',
  });
  const bundle = result.outputs.find((file) => file.kind === 'entry-point');
  if (!result.success || !bundle) throw new AggregateError(result.logs, `Could not bundle ${entrypoint}.`);
  await Bun.write(output, bundle);
}
