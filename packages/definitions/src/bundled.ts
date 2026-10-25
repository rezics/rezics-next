import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { releaseDigest, type Release } from './index.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const files = (directory: string): string[] =>
  readdirSync(new URL(directory, import.meta.url), { withFileTypes: true })
    .flatMap((entry) => {
      const path = posix.join(directory, entry.name);
      return entry.isDirectory() ? files(path) : entry.isFile() && entry.name.endsWith('.yaml') ? [path] : [];
    })
    .sort();

export function bundledSources() {
  const schemas = Object.fromEntries(files('../catalogue').map((path) => [posix.basename(path), source(path)]));
  const presentation = Object.fromEntries(
    files('../presentation').map((path) => {
      const relative = posix.relative('../presentation', path).replace(/\.yaml$/u, '');
      return [relative, source(path)];
    }),
  );
  return {
    root: 'rezics.yaml',
    schemas,
    presentation,
  };
}

export const bundledRelease: Release = JSON.parse(source('../release/rezics.json')) as Release;
export const bundledDigest = releaseDigest(bundledRelease);
