import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const minecraftClientResource = 'minecraft-client-id.txt';

export function parseMinecraftClientId(value: string) {
  const id = value.trim();
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return id;
}

export async function readPackagedMinecraftClientId(directory: string) {
  return parseMinecraftClientId(await readFile(join(directory, minecraftClientResource), 'utf8').catch(() => ''));
}
