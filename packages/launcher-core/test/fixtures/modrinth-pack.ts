import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { packIndexName } from '../../src/plugins/modrinth-pack-format.ts';

export async function writeModrinthPack(
  path: string,
  index: object,
  entries: Record<string, string | { data: string; mode: number }> = {},
) {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(index)), packIndexName);
  for (const [name, item] of Object.entries(entries)) {
    if (typeof item === 'string') zip.addBuffer(Buffer.from(item), name);
    else zip.addBuffer(Buffer.from(item.data), name, { mode: item.mode });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
  return path;
}
