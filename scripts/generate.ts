import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { generate } from '../model/compiler/generate.ts';
import { stampFusekiImage } from './dev/fuseki-image.ts';
import { generateDocumentSchemas } from '../packages/document/scripts/schema.ts';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('usage: task gen -- [--check]');
}
const root = resolve(import.meta.dir, '..');
const check = args[0] === '--check';
generate(root, check);
await generateDocumentSchemas(check);
// Shapes are image inputs, so the tag is derived after model generation.
stampFusekiImage(root, check);
// Main imports generated model modules (profiles, Facets), so load it only once they exist.
const { generateMainOpenApi } = await import('./api/generate.ts');
await generateMainOpenApi(root, check);
// The toolchain page lists the pinned images, so it follows the pins. Land and merge
// regenerate through this script, so the page cannot go stale behind a new pin.
const inventory = spawnSync('python3', ['scripts/documentation/toolchain_inventory.py', check ? '--check' : '--write'],
  { cwd: root, encoding: 'utf8' });
if (inventory.status !== 0) throw new Error(`toolchain inventory: ${(inventory.stderr || inventory.stdout).trim()}`);
