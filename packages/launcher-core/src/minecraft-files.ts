import { checksum } from '@xmcl/core';
import { fileInfo } from './storage.ts';

export async function checkResourceFiles(files: readonly { path: string; sha1: string; size: number }[]) {
  const batchSize = 32;
  for (let start = 0; start < files.length; start += batchSize) {
    const checks = await Promise.allSettled(
      files.slice(start, start + batchSize).map(async ({ path, sha1, size }) => {
        const file = await fileInfo(path);
        return file?.isFile() && file.size === size && (await checksum(path, 'sha1')) === sha1;
      }),
    );
    if (!checks.every((check) => check.status === 'fulfilled' && check.value)) return false;
  }
  return true;
}
