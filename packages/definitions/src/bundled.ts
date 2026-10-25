import { readFileSync } from 'node:fs';
import { releaseDigest, type Release } from './index.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

export function bundledSources() {
  return {
    root: 'rezics.yaml',
    schemas: {
      'rezics.yaml': source('../catalogue/rezics.yaml'),
      'core.yaml': source('../catalogue/core.yaml'),
      'book.yaml': source('../catalogue/book.yaml'),
      'recipe.yaml': source('../catalogue/recipe.yaml'),
      'works.yaml': source('../catalogue/works.yaml'),
    },
    presentation: {
      en: source('../presentation/en.yaml'),
      ja: source('../presentation/ja.yaml'),
      'zh-Hant': source('../presentation/zh-Hant.yaml'),
    },
  };
}

export const bundledRelease: Release = JSON.parse(source('../release/rezics.json')) as Release;
export const bundledDigest = releaseDigest(bundledRelease);
