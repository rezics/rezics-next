import type { Pool } from 'pg';
import { nativeContentLifecycle } from './content-lifecycle.ts';
import { nativeHashing } from './hashing.ts';
import { nativeRouting } from './routing.ts';
import { resolvedSemanticDomain } from './registry.ts';
import type { ContentLifecyclePort, HashPort, RoutePort } from '../contract/domain-ports.ts';

let ordinaryContentLifecycle: ContentLifecyclePort | undefined;

/** Composition installs the native Content adapter. Inward files never import that adapter. */
export function bindOrdinaryContentLifecycle(port: ContentLifecyclePort): void {
  ordinaryContentLifecycle = port;
}

export function hashingOf(pool?: Pool): HashPort {
  return resolvedSemanticDomain(pool)?.ports.hashing ?? nativeHashing();
}

export function routingOf(pool?: Pool): RoutePort {
  return resolvedSemanticDomain(pool)?.ports.routing ?? nativeRouting();
}

export function contentLifecycleOf(pool?: Pool): ContentLifecyclePort {
  return (
    resolvedSemanticDomain(pool)?.ports.contentLifecycle ?? ordinaryContentLifecycle ?? nativeContentLifecycle()
  );
}
