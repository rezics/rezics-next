import { cn as merge } from 'tailwind-variants';

/** What cn accepts, as clsx did: strings, nested arrays and `{ class: condition }` objects. */
export type ClassValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | { [name: string]: unknown }
  | readonly ClassValue[];

/** Joins class values (strings, arrays, conditional objects) and resolves Tailwind conflicts, the last class
 * winning. It reuses the merger tailwind-variants bundles; importing tailwind-merge as well shipped the same
 * code to every page twice. */
export function cn(...values: ClassValue[]): string {
  // Keep clsx's falsy-number behavior even when 0 is the only argument; tailwind-variants v4 keeps a lone "0".
  return merge(...(values.map((value) => (value === 0 ? null : value)) as Parameters<typeof merge>)) ?? '';
}

/** Smooth scrolling, unless the reader asked the system for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
