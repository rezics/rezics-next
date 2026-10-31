import { readFileSync } from 'node:fs';
import { createRuntime } from '../src/config.ts';
import { receiveControlPlaneBatch } from '../src/control-plane-batch.ts';

// This receiving entry is run by the controller from the authenticated manager's session, after source completion.
const file = process.argv[2];
if (!file || process.argv.length !== 3) throw new Error('Usage: release-control-plane-batch.ts <manifest.json>');
const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'));
const runtime = createRuntime({ trainMode: 'inline' });
try {
  console.log(JSON.stringify(await receiveControlPlaneBatch(manifest, runtime), null, 2));
  await runtime.job.drain();
} finally {
  runtime.close();
}
