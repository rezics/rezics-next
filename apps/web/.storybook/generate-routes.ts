import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isCheckHostRun } from '../../../scripts/check-placement.ts';
import { generateRoutes } from './route-generation.ts';

const app = process.cwd();
const run = process.env.REZICS_CHECK_RUN;
// The driver and Web qualification can share one generated tree inside the same frozen run.
const stamp =
  run && /^[a-zA-Z0-9-]+$/.test(run) && isCheckHostRun(app) ? resolve(app, '.temp', `routes-${run}.sha256`) : undefined;
const treeDigest = async () =>
  createHash('sha256')
    .update(await readFile(resolve(app, 'src/routeTree.gen.ts')))
    .digest('hex');

const prepared = stamp && process.argv.includes('--reuse') && (await readFile(stamp, 'utf8').catch(() => undefined));
if (!prepared || prepared !== (await treeDigest().catch(() => undefined))) {
  await generateRoutes(app);
  if (stamp) {
    await mkdir(resolve(app, '.temp'), { recursive: true });
    await writeFile(stamp, await treeDigest());
  }
}
