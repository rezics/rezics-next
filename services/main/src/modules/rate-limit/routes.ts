import { exposureDeclarations } from '../access/exposure-declarations.ts';
import { families, type RateLimitFamily } from './budgets.ts';

type RateLimitDeclarations = Readonly<
  Record<string, Readonly<Record<string, { readonly rateLimitFamily?: unknown }>>>
>;

/** Compile the route owners' admission metadata with the existing whole-segment
 * matcher. Missing and invalid families retain the denied default. */
export function createRateLimitResolver(declarations: readonly RateLimitDeclarations[]) {
  const compiled = declarations
    .flatMap((owner) =>
      Object.entries(owner).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, entry]) => ({
          method: method === 'all' ? '*' : method.toUpperCase(),
          family:
            entry.rateLimitFamily === 'read'
              ? ('read' as const)
              : families.find((family) => family === entry.rateLimitFamily),
          parameters: path.split('/').filter((segment) => segment.startsWith('{')).length,
          path: new RegExp(
            '^' +
              path
                .split('/')
                .map((segment) =>
                  segment.startsWith('{')
                    ? '[^/]+'
                    : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                )
                .join('/') +
              '$',
          ),
        })),
      ),
    )
    // A named operation must take precedence over a resource parameter route.
    .sort((a, b) => a.parameters - b.parameters);
  return (method: string, path: string): RateLimitFamily | null | undefined => {
    // HEAD inherits GET; parameter names never select a different policy.
    const verb = method === 'HEAD' ? 'GET' : method;
    const normalized = path.replace(/:[^/]+/g, '_').replace(/\{[^}]+\}/g, '_');
    const operation = compiled.find(
      (entry) => (entry.method === verb || entry.method === '*') && entry.path.test(normalized),
    );
    return operation?.family === 'read' ? null : operation?.family;
  };
}

let resolve: ReturnType<typeof createRateLimitResolver> | undefined;
export function rateLimitFamily(method: string, path: string): RateLimitFamily | null | undefined {
  // Route modules also import admission helpers. Compile after their declarations
  // initialize, then reuse the same matcher for HTTP and dispatched MCP calls.
  resolve ??= createRateLimitResolver(exposureDeclarations);
  return resolve(method, path);
}
