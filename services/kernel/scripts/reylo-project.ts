import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Writes the Reylo project file that points every analysis at `analysisUrl`, in `directory`, which then holds `.reylo/`.
 * Reylo keys its entries by database name, so analysing in each file's own copy re-describes every statement there.
 */
export function writeReyloProject(directory: string, analysisUrl: string): string {
  const file = resolve(directory, '.reylo.yaml');
  writeFileSync(file, `direct_url: ${JSON.stringify(analysisUrl)}\n`);
  return file;
}
