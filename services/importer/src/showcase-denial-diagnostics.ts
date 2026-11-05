import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImportDeniedResponse } from './import-client.ts';

/** Capture the first HTTP denial without interpreting Kernel's internal authorization stage. */
export function createSeedDenialDiagnostics(
  directory: string,
  report: (diagnostic: string) => void = (diagnostic) => process.stderr.write(diagnostic + '\n'),
): (denial: ImportDeniedResponse) => Promise<void> {
  let captured = false;
  return async ({ method, path, response }) => {
    // Claim before awaiting so concurrent failed members cannot replace the first response.
    if (captured) return;
    captured = true;
    const subject = /^\/v1\/subjects\/([0-9a-f-]{36})(?:\/|$)/.exec(path)?.[1];
    const stage = path.includes('/source-statistics')
      ? 'source-statistics'
      : path === '/v1/subjects:batchWrite'
        ? 'subject-batch'
        : 'native-request';
    // The transport has already enforced its response size and deadline limits.
    const bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const artifact = await mkdtemp(join(directory, 'denial-'));
    await writeFile(join(artifact, 'response.body'), bytes, { mode: 0o600 });
    await writeFile(
      join(artifact, 'response.json'),
      JSON.stringify({
        method,
        path,
        status: response.status,
        bodyBytes: bytes.byteLength,
        bodySha256: createHash('sha256').update(bytes).digest('hex'),
      }) + '\n',
      { mode: 0o600 },
    );
    // No remote text, headers, request body, bearer, session or account key enters output.
    report(JSON.stringify({ event: 'seed-native-denial', stage, method, status: response.status, subject, artifact }));
  };
}
