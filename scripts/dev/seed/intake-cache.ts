import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared-stack creations bind the candidate receipt retained by their original
 * checkout. A worktree's new search receipt has a different UUID, even for the
 * same intent. Import only this public evidence, never mutate the source cache.
 * Files are already addressed by stack epoch, actor and stable creation key. */
export function retainSharedSeedIntake(root: string, sourceRoot: string): number {
  const source = join(sourceRoot, '.temp/catalogue-intake');
  if (!existsSync(source)) return 0;
  const destination = join(root, '.temp/catalogue-intake');
  let copied = 0;
  for (const file of readdirSync(source)) {
    if (!/^[0-9a-f]{64}\.json$/.test(file)) continue;
    const text = readFileSync(join(source, file), 'utf8');
    const retained = JSON.parse(text) as { fingerprint: string; candidateReceipt: string };
    if (!/^[0-9a-f]{64}$/.test(retained.fingerprint)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(retained.candidateReceipt)) {
      throw new Error(`Shared seed intake evidence is invalid: ${file}`);
    }
    const path = join(destination, file);
    if (existsSync(path)) {
      const localText = readFileSync(path, 'utf8');
      if (localText === text) continue;
      const local = JSON.parse(localText) as { fingerprint: string };
      if (local.fingerprint !== retained.fingerprint) {
        throw new Error(`Shared seed intake intent differs from this worktree: ${file}`);
      }
    }
    mkdirSync(destination, { recursive: true });
    writeFileSync(path, text, { mode: 0o600 });
    copied++;
  }
  return copied;
}
