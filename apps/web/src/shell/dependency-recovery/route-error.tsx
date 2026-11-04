import { createElement, type ComponentType, type ElementType } from 'react';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { ClosedErrorPage } from '../closed';
import { isDependencyUnavailableError } from '../../session/unavailable';

type RouteNode = {
  options?: { errorComponent?: unknown };
  children?: Record<string, RouteNode>;
};

const patchedOptions = new WeakSet<object>();

export function dependencyErrorComponent<T extends ElementType>(fallback: T): ComponentType<ErrorComponentProps> {
  return function DependencyErrorBoundary(props: ErrorComponentProps) {
    return isDependencyUnavailableError(props.error)
      ? createElement(ClosedErrorPage, props)
      : createElement(fallback, props);
  };
}

/** Keep each mounted route's existing error page, with the shared outage page for typed dependencies. */
export function applyDependencyErrorComponents(route: RouteNode): void {
  const options = route.options;
  if (options && !patchedOptions.has(options)) {
    const fallback = options.errorComponent;
    if (typeof fallback === 'function' || (typeof fallback === 'object' && fallback !== null)) {
      options.errorComponent = dependencyErrorComponent(fallback as ElementType);
      patchedOptions.add(options);
    }
  }
  for (const child of Object.values(route.children ?? {})) applyDependencyErrorComponents(child);
}
