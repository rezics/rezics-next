// The merge gate kills this process at the shard deadline. Bun's reporter
// prints no file header when CI is set, so the file that is current is
// recorded here, before that kill, in the same `path:` form the gate reads.
import { appendFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

const progress = process.env.REZICS_QA_PROGRESS_FILE;
if (progress) {
  const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
  let current = '';
  const note = () => {
    const main = Bun.main;
    if (!main || main === current || !testFile.test(main)) return;
    current = main;
    const file = isAbsolute(main) ? relative(process.cwd(), main) : main;
    appendFileSync(progress, `${file}:\n`);
  };
  note();
  // A file can spend its whole budget in beforeAll, before any test hook runs.
  const timer = setInterval(note, 20);
  timer.unref();
}
