'use client';

import type { ReactNode } from 'react';
import { seedTypes, type TypeRegistry } from './types.ts';

/**
 * Seeds the browser's registry snapshot before anything below it renders, so
 * every synchronous lookup (`coverKindOf`, `typeLabel`) answers in client
 * components and while they render on the server. The registry is the same for
 * every reader, so mounting it once in the locale layout is enough.
 */
export function TypeRegistryProvider({ registry, children }: { registry: TypeRegistry | null; children: ReactNode }) {
  if (registry) seedTypes(registry);
  return children;
}
