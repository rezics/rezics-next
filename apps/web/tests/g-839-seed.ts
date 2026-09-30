// Seeds the G-839 edit records into the isolated QA stack the e2e harness started and prints their
// IDs as JSON. The browser signs in as the stack's web member, whose Agent and principal come from
// the private web-auth fixture.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { seedEditCatalogue } from './g-839-catalogue.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The G-839 seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
if (!objectDirectory || !path) throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
const { principalId, actingSubject } = JSON.parse(readFileSync(path, 'utf8')) as { principalId: string; actingSubject: string };

const stack = await startMediaStack('g839-e2e');
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
try {
  const catalogue = await seedEditCatalogue(stack, { principalId, actor: actingSubject }, resolve('.temp', `g839-${process.env.REZICS_QA_RUN_ID}`));
  console.log(JSON.stringify(catalogue));
} finally {
  await stack.stop();
}
