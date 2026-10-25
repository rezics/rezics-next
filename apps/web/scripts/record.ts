import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const origin = process.env.KERNEL_ORIGIN;
if (!origin) throw new Error('Set KERNEL_ORIGIN to a running development kernel.');
const requests = [
  ['subject', '/v1/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01'],
  ['missing-subject', '/v1/subjects/00000000-0000-4000-8000-000000000000'],
] as const;
const output = join(import.meta.dir, '../src/kernel/recorded');
await mkdir(output, { recursive: true });
for (const [name, path] of requests) {
  const response = await fetch(new URL(path, origin));
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error(`${path} returned a non-object JSON response (${response.status}).`);
  await writeFile(join(output, `${name}.json`), `${JSON.stringify({ ...body, status: response.status }, null, 2)}\n`);
  if (name === 'subject' && !response.ok) throw new Error(`${path} returned ${response.status}.`);
  if (name === 'missing-subject' && response.status !== 404)
    throw new Error(`${path} should return 404, received ${response.status}.`);
}
