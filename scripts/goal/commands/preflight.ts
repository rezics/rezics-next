import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { preflightRetainedSources, retainedPreflightSummary } from '../../qa/retained-preflight.ts';

export const usage = 'Usage: goalctl preflight <selected test files...>';
export default async function preflight(files: string[]): Promise<number> {
  if (!files.length || files.some(file => file.startsWith('-'))) throw new Error(usage);
  const root = resolve(import.meta.dir, '../../..');
  const selected = files.map(file => {
    const path = relative(root, resolve(root, file));
    if (isAbsolute(path) || path.startsWith('..') || !existsSync(resolve(root, path)))
      throw new Error(`Selected test file is missing or outside this checkout: ${file}`);
    return path;
  });
  const result = await preflightRetainedSources(root, selected);
  console.log(retainedPreflightSummary(result));
  return result.ok ? 0 : 1;
}
