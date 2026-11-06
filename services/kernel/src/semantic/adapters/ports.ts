import type { Pool } from 'pg';
import { nativeHashing } from './hashing.ts';
import { nativeRouting } from './routing.ts';
import { resolvedSemanticDomain } from './registry.ts';
import type { HashPort, RoutePort } from '../contract/domain-ports.ts';

export function hashingOf(pool?: Pool): HashPort {
  return resolvedSemanticDomain(pool)?.ports.hashing ?? nativeHashing();
}

export function routingOf(pool?: Pool): RoutePort {
  return resolvedSemanticDomain(pool)?.ports.routing ?? nativeRouting();
}
