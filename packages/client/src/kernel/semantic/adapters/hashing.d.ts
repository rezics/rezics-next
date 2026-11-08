import type { HashPort } from '../contract/domain-ports.ts';
/** Native SHA-256 hex digest. Composition binds this; cores never import crypto. */
export declare function nativeHashing(): HashPort;
