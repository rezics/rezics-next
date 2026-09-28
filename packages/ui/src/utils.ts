import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}

/** Smooth scrolling, unless the reader asked the system for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
