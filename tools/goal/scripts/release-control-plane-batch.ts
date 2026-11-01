import { readFileSync } from 'node:fs';
import { createRuntime } from '../src/config.ts';
import {
  parseControlPlaneBatchSupersession,
  parseControlPlaneScopeApproval,
  receiveControlPlaneBatch,
  receiveControlPlaneBatchSupersession,
  receiveControlPlaneBatchRefContinuation,
  receiveControlPlaneScopeApproval,
} from '../src/control-plane-batch.ts';

// This receiving entry is run by the controller from the authenticated manager's session, after source completion.
const approval = process.argv[2] === '--approve-scope';
const continuation = process.argv[2] === '--continue-ref-exhausted';
const flagged = approval || continuation;
const file = process.argv[flagged ? 3 : 2];
if (!file || process.argv.length !== (flagged ? 4 : 3))
  throw new Error('Usage: release-control-plane-batch.ts [--approve-scope|--continue-ref-exhausted] <request.json>');
const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'));
const runtime = createRuntime({ trainMode: 'inline' });
try {
  const supersession = manifest && typeof manifest === 'object' && 'previousBatchId' in manifest;
  console.log(
    JSON.stringify(
      approval
        ? receiveControlPlaneScopeApproval(parseControlPlaneScopeApproval(manifest), runtime)
        : continuation
          ? await receiveControlPlaneBatchRefContinuation(manifest, runtime)
          : supersession
            ? await receiveControlPlaneBatchSupersession(parseControlPlaneBatchSupersession(manifest), runtime)
            : await receiveControlPlaneBatch(manifest, runtime),
      null,
      2,
    ),
  );
  await runtime.job.drain();
} finally {
  runtime.close();
}
