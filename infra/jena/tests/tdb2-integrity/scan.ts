import { constants, cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { freshDirectory, lastJsonLine, runJava } from './support.ts';

// Usage: scan.ts <tdb2-directory> [--in-place]
// <tdb2-directory> holds Data-NNNN (for the product, databases/rezics/tdb2). The scan opens
// TDB2, which takes tdb.lock and replays a pending journal, so it works on a copy unless told
// otherwise. The copy is a snapshot of a store whose owner is stopped or idle (empty
// journal.jrnl, unchanged modification times); it never opens the live files.
const [target, ...flags] = process.argv.slice(2);
if (!target || flags.some((flag) => flag !== '--in-place')) {
  console.error('usage: scan.ts <tdb2-directory> [--in-place]');
  process.exit(2);
}
const source = resolve(target);
if (!existsSync(source) || !readdirSync(source).some((name) => /^Data-\d+$/.test(name))) {
  console.error(`${source} holds no Data-NNNN directory`);
  process.exit(2);
}
const inPlace = flags.includes('--in-place');
const work = inPlace ? source : freshDirectory('scan');
try {
  if (!inPlace) {
    // Reflink where the filesystem has it; TDB2 files are sparse, so a plain copy is also safe.
    for (const name of readdirSync(source)) {
      if (name !== 'tdb.lock') cpSync(join(source, name), join(work, name), { recursive: true, mode: constants.COPYFILE_FICLONE });
    }
  }
  const result = runJava('ScanTdb2', ['/database'], work);
  process.stdout.write(result.stdout);
  if (result.status === null || (result.status !== 0 && result.status !== 1)) {
    process.stderr.write(result.stderr);
    process.exit(2);
  }
  const report = lastJsonLine<{ damage: number }>(result.stdout);
  process.exit(report.damage === 0 ? 0 : 1);
} finally {
  if (!inPlace) rmSync(work, { recursive: true, force: true });
}
