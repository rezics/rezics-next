import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import type { Release } from './portable.ts';

export * from './portable.ts';

// Publication admission/validation and catalogue compilation are server operations.
// Keep them on the default entry: browsers submit publication through the
// Definitions API, whose native validator owns pattern analysis and its budget.
// No native checker or publication-construction module belongs in this graph.

/** The same synchronous RFC 8785 / UTF-8 SHA-256 identity as the native entry. */
export function releaseDigest(release: Release): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalize(release)!)))}`;
}
