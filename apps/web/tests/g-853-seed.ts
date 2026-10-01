// Seeds the G-853 records (`g-853-records.ts`) into the isolated QA stack the e2e harness started and prints
// their IDs as JSON. The browser signs in as the stack's web member, so their Agent and principal come from the
// private web-auth fixture.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { seedZones } from './g-853-records.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The G-853 seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
if (!objectDirectory || !authPath) {
  throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
}
const reader = JSON.parse(readFileSync(authPath, 'utf8')) as { principalId: string; actingSubject: string };

const stack = await startMediaStack('g853-e2e', { agents: true, rights: true, library: true });
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
try {
  console.log(JSON.stringify(await seedZones(stack, reader, resolve('.temp', `g853-${process.env.REZICS_QA_RUN_ID}`))));
} finally {
  await stack.stop();
}
