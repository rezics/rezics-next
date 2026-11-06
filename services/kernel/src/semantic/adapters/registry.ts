import type { Pool } from 'pg';
import type { NativeSemanticDomain } from './native-domain.ts';

const installations = new WeakMap<Pool, NativeSemanticDomain>();

/** Trusted process composition only. There is no caller-selected domain or mutable setter. */
export function registerSemanticDomain(pool: Pool, domain: NativeSemanticDomain | null): void {
  if (domain) installations.set(pool, domain);
}

export function registeredSemanticDomain(pool: Pool): NativeSemanticDomain | null {
  return installations.get(pool) ?? null;
}

const fallback = {
  domain: null as NativeSemanticDomain | null,
};

/** Tests and HTTP paths that have no worker pool use the native domain bound here. */
export function bindDefaultSemanticDomain(domain: NativeSemanticDomain): void {
  fallback.domain = domain;
}

export function defaultSemanticDomain(): NativeSemanticDomain | null {
  return fallback.domain;
}

/** Worker pool domain when registered, otherwise the process default bound at composition. */
export function resolvedSemanticDomain(pool?: Pool): NativeSemanticDomain | null {
  return (pool ? registeredSemanticDomain(pool) : null) ?? fallback.domain;
}
