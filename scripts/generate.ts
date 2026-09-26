import { resolve } from 'node:path';
import { generate } from '../model/compiler/generate.ts';
import { generateMainOpenApi } from './api/generate.ts';
import { stampFusekiImage } from './dev/fuseki-image.ts';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('usage: yarn gen [--check]');
}
const root = resolve(import.meta.dir, '..');
const check = args[0] === '--check';
generate(root, check);
// Shapes are image inputs, so the tag is derived after model generation.
stampFusekiImage(root, check);
await generateMainOpenApi(root, check);
