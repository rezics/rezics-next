import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import type { Release } from './portable.ts';

/** The synchronous RFC 8785 / UTF-8 SHA-256 identity used by every Definitions root. */
export function releaseDigest(release: Release): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalize(release)!)))}`;
}
