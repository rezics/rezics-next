// Seeds the G-849 records (`g-849-records.ts`) into the isolated QA stack the e2e harness started and prints their IDs
// as JSON. The browser signs in as the stack's web member, so the member's Agent and principal come from the private
// web-auth fixture.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { seedWiki } from './g-849-records.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The G-849 seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
if (!objectDirectory || !authPath) {
  throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
}
const reader = JSON.parse(readFileSync(authPath, 'utf8')) as { principalId: string; actingSubject: string };

const stack = await startMediaStack('g849-e2e', { agents: true, rights: true, library: true });
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
// The HTTP problem deliberately omits kernel internals. Retain the first
// rejection: replaying its terminal receipt no longer carries the native report.
let invalidNativeCommand: unknown;
const nativeCommand = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
stack.fuseki.commandWithReceipt = async envelope => {
  const result = await nativeCommand(envelope);
  if (result.status === 'invalid' && !invalidNativeCommand) {
    invalidNativeCommand = { envelope, report: result.report,
      membership: await stack.fuseki.membershipPreparationStatus() };
  }
  return result;
};
try {
  const seeded = await seedWiki(stack, reader);
  const again = await seedWiki(stack, reader);
  if (again.zone !== seeded.zone || again.work !== seeded.work || again.realm !== seeded.realm) {
    throw new Error('Wiki fixture did not keep its identity on the second seed');
  }
  const { read: _read, tokens: _tokens, holderToken: _holder, holderActor: _actor, ...seed } = seeded;
  console.log(JSON.stringify(seed));
} catch (error) {
  if (invalidNativeCommand) {
    const directory = resolve('.temp', 'qa', process.env.REZICS_QA_RUN_ID!);
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, 'wiki-native-rejection.json');
    writeFileSync(path, JSON.stringify(invalidNativeCommand, null, 2));
    console.error(`Wiki native rejection: ${path}`);
  }
  throw error;
} finally {
  await stack.stop();
}
