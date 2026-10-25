// SPDX-License-Identifier: Apache-2.0
import { format } from 'oxfmt';
import { compositionSchema, platformRegistry } from '../src/index.ts';

const file = new URL('../schema/composition-v1.schema.json', import.meta.url);

/** Two-space JSON, collapsed the way oxfmt writes short arrays, so both checks see the same bytes. */
async function schemaText(): Promise<string> {
  const raw = `${JSON.stringify(compositionSchema(platformRegistry), null, 2)}\n`;
  const formatted = await format(file.pathname, raw, { printWidth: 120 });
  if (formatted.errors.length > 0) throw new Error(formatted.errors.map((error) => error.message).join('\n'));
  return formatted.code;
}

export async function generateCompositionSchema(check = false): Promise<void> {
  const expected = await schemaText();
  if (check) {
    if (!(await Bun.file(file).exists()) || (await Bun.file(file).text()) !== expected) {
      throw new Error(`Composition schema is stale: ${file.pathname}; run bun scripts/schema.ts`);
    }
  } else await Bun.write(file, expected);
}

if (import.meta.main) await generateCompositionSchema(process.argv.includes('--check'));
