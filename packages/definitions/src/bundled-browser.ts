import release from '../release/rezics.json';
import { releaseDigest, type Release } from './browser.ts';

// Browsers consume the compiled catalogue. Reading source YAML directories is
// the native bundledSources operation, available only on the default entry.
export const bundledRelease: Release = release as Release;
export const bundledDigest = releaseDigest(bundledRelease);
