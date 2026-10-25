import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPool } from '../src/database/pool.ts';
import { createKernel } from '../src/http/kernel.ts';
import { formatDocument, openApiDocument } from '../src/http/openapi.ts';

export const CONTRACT = resolve(import.meta.dir, '../../../contracts/openapi.json');

export async function kernelContract(): Promise<string> {
  const pool = createPool('postgres://kernel.invalid/openapi');
  try {
    return formatDocument(openApiDocument(createKernel({ pool, routeKey: new Uint8Array(32) })));
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const contract = await kernelContract();
  await mkdir(dirname(CONTRACT), { recursive: true });
  await writeFile(CONTRACT, contract);
}
