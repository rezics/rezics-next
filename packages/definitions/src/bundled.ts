import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { releaseDigest, type Release } from './portable.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const files = (directory: string): string[] =>
  readdirSync(new URL(directory, import.meta.url), { withFileTypes: true })
    .flatMap((entry) => {
      const path = posix.join(directory, entry.name);
      return entry.isDirectory() ? files(path) : entry.isFile() && entry.name.endsWith('.yaml') ? [path] : [];
    })
    .sort();

function namedSources(directory: string): Record<string, string> {
  let entries;
  try {
    entries = readdirSync(new URL(directory, import.meta.url), { withFileTypes: true });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  return Object.fromEntries(
    entries
      .flatMap((entry) => (entry.isFile() && entry.name.endsWith('.yaml') ? [entry.name] : []))
      .sort()
      .map((name) => [posix.basename(name, '.yaml'), source(`${directory}/${name}`)]),
  );
}

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
    contexts: namedSources('../contexts'),
    filters: namedSources('../filters'),
  };
}

export const bundledRelease: Release = JSON.parse(source('../release/rezics.json')) as Release;
export const bundledDigest = releaseDigest(bundledRelease);
