// Stories run without vinext's router, so `next/navigation` resolves here
// (see main.ts). A story sets the route with `parameters.route`.
import { createContext, use } from 'react';

export interface StoryRoute {
  pathname: string;
  search?: string;
  /** Observe navigation commands without changing the Storybook iframe's address. */
  onPush?: (href: string, options?: { scroll?: boolean }) => void;
}

export const StoryRouteContext = createContext<StoryRoute>({ pathname: '/' });

export function usePathname(): string {
  return use(StoryRouteContext).pathname;
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(use(StoryRouteContext).search);
}

export function useRouter() {
  const route = use(StoryRouteContext);
  const ignore = () => undefined;
  return { push: route.onPush ?? ignore, replace: ignore, refresh: ignore, back: ignore, forward: ignore, prefetch: ignore };
}

export function notFound(): never {
  throw new Error('notFound() is not available in stories');
}

export function redirect(path: string): never {
  throw new Error(`redirect(${path}) is not available in stories`);
}
