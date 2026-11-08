import type { Pool } from 'pg';
import type { NativeSemanticDomain } from './native-domain.ts';
/** Trusted process composition only. There is no caller-selected domain or mutable setter. */
export declare function registerSemanticDomain(pool: Pool, domain: NativeSemanticDomain | null): void;
export declare function registeredSemanticDomain(pool: Pool): NativeSemanticDomain | null;
/** Tests and HTTP paths that have no worker pool use the native domain bound here. */
export declare function bindDefaultSemanticDomain(domain: NativeSemanticDomain): void;
export declare function defaultSemanticDomain(): NativeSemanticDomain | null;
/** Worker pool domain when registered, otherwise the process default bound at composition. */
export declare function resolvedSemanticDomain(pool?: Pool): NativeSemanticDomain | null;
