// SPDX-License-Identifier: Apache-2.0
import { documentJsonSchema } from '../src/schema.ts';

export async function generateDocumentSchemas(check = false): Promise<void> {
  for (const profile of ['core', 'text', 'blocks'] as const) {
    const file = new URL(
      `../schema/rezics-${profile === 'core' ? 'document-core' : profile}-v1.schema.json`,
      import.meta.url,
    );
    const expected = `${JSON.stringify(documentJsonSchema(profile), null, 2)}\n`;
    if (check) {
      if (!(await Bun.file(file).exists()) || (await Bun.file(file).text()) !== expected) {
        throw new Error(`Document schema is stale: ${file.pathname}; run task document:gen`);
      }
    } else await Bun.write(file, expected);
  }
}

if (import.meta.main) await generateDocumentSchemas(process.argv.includes('--check'));
