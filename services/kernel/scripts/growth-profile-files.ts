import { open, type FileHandle } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { GROWTH_PROFILE_INPUT_LIMITS } from '../test/support/growth-profile-input.ts';
import type { GrowthProfileRunSource } from '../test/support/growth-profile-read.ts';

function sourceName(path: string): string {
  return basename(path, extname(path));
}

function inputError(name: string, detail: string): TypeError {
  return new TypeError(`${name || '<unnamed profile>'}:1 ${detail}`);
}

function budgetError(name: string): TypeError {
  return inputError(name, `exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.totalBytes} byte profile input limit`);
}

function changedError(name: string): TypeError {
  return inputError(name, 'changed while reading');
}

/** Read at most the observed size; a trailing extra byte means the file grew after stat. */
export async function readGrowthProfileHandle(
  handle: FileHandle,
  name: string,
  observedSize: number,
  retainedBytes: number,
): Promise<string> {
  if (observedSize > GROWTH_PROFILE_INPUT_LIMITS.totalBytes - retainedBytes) throw budgetError(name);

  const buffer = observedSize > 0 ? Buffer.alloc(observedSize) : Buffer.alloc(0);
  let got = 0;
  while (got < observedSize) {
    const { bytesRead } = await handle.read(buffer, got, observedSize - got, got);
    if (bytesRead === 0) throw changedError(name);
    got += bytesRead;
  }
  const peek = Buffer.alloc(1);
  const extra = await handle.read(peek, 0, 1, observedSize);
  if (extra.bytesRead > 0) throw changedError(name);
  return buffer.toString('utf8');
}

export async function readGrowthProfileFiles(paths: readonly string[]): Promise<GrowthProfileRunSource[]> {
  const handles: FileHandle[] = [];
  try {
    const opened: { name: string; handle: FileHandle; size: number }[] = [];
    for (const path of paths) {
      const name = sourceName(path);
      const handle = await open(path, 'r');
      handles.push(handle);
      opened.push({ name, handle, size: (await handle.stat()).size });
    }

    let retainedBytes = 0;
    for (const file of opened) {
      if (file.size > GROWTH_PROFILE_INPUT_LIMITS.totalBytes - retainedBytes) throw budgetError(file.name);
      retainedBytes += file.size;
    }

    const sources: GrowthProfileRunSource[] = [];
    retainedBytes = 0;
    for (const file of opened) {
      const text = await readGrowthProfileHandle(file.handle, file.name, file.size, retainedBytes);
      retainedBytes += file.size;
      sources.push({ name: file.name, text });
    }
    return sources;
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
  }
}
