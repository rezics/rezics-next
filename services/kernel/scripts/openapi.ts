import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPool } from '../src/database/pool.ts';
import { createApp } from '../src/http/app.ts';
import { formatDocument, openApiDocument } from '../src/http/openapi.ts';

export const CONTRACT = resolve(import.meta.dir, '../../../contracts/openapi.json');

export async function kernelContract(): Promise<string> {
  const pool = createPool('postgres://kernel.invalid/openapi');
  try {
    return formatDocument(openApiDocument(createApp({ pool })));
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const contract = await kernelContract();
  await mkdir(dirname(CONTRACT), { recursive: true });
  await writeFile(CONTRACT, contract);
}
