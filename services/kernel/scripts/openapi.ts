import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPool } from '../src/database/pool.ts';
import { createAccess } from '../src/access/index.ts';
import { createKernel } from '../src/http/kernel.ts';
import { formatDocument, openApiDocument } from '../src/http/openapi.ts';
import { testReceiptKeys } from '../test/support/receipt-keys.ts';

export const CONTRACT = resolve(import.meta.dir, '../../../contracts/openapi.json');

export async function kernelContract(): Promise<string> {
  const pool = createPool('postgres://kernel.invalid/openapi');
  try {
    return formatDocument(
      openApiDocument(
        createKernel({
          pool,
          routeKey: new Uint8Array(32),
          receiptKeys: testReceiptKeys(),
          // Contract construction mounts routes but never authorizes a request.
          access: createAccess({ actions: new Map() }),
        }),
      ),
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const contract = await kernelContract();
  await mkdir(dirname(CONTRACT), { recursive: true });
  await writeFile(CONTRACT, contract);
}
