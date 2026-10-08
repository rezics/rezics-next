import { Elysia, type AnyElysia } from 'elysia';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { problem } from '../../routes/problems.ts';
import {
  type AccessExposure,
  type ExposureDeclarations,
  PlatformClosed,
  validExposure,
} from './exposure.ts';

/** Same operation identity as Elysia's OpenAPI default, including hyphens. */
export function exposureOperationId(method: string, path: string): string {
  return (
    (method === '*' ? 'all' : method.toLowerCase()) +
    path
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        if (segment.startsWith(':')) return `By${segment[1]!.toUpperCase()}${segment.slice(2)}`;
        if (segment.startsWith('{')) return `By${segment[1]!.toUpperCase()}${segment.slice(2, -1)}`;
        return segment[0]!.toUpperCase() + segment.slice(1);
      })
      .join('')
  );
}

export const platformExposureProblem = (error: unknown): Response => {
  if (error instanceof PlatformClosed)
    return problem(403, 'platform_closed', 'This capability is closed');
  if (error instanceof AccountAssertionDenied)
    return problem(401, 'invalid_account_assertion', 'Account assertion refused');
  return problem(503, 'platform_access_unavailable', 'Platform access is unavailable');
};

/** Bind declarations to route hooks once, before Elysia compiles them. Each
 * compiled hook retains only its exposure and identity; requests do not consult
 * an operation registry. ~routes is the pinned Elysia compiler input, including
 * WS upgrades, whereas routes is a composed metadata snapshot. */
export function bindPlatformExposure(
  work: {
    account: Pick<AccountAssertionVerifier, 'verify'>;
    platformAccess?: Pick<AccessExposure, 'require'>;
  },
  declarations: readonly ExposureDeclarations[],
) {
  return <App extends AnyElysia>(app: App): App => {
    const metadata = new Map<string, { exposure: import('./exposure.ts').Exposure }>();
    for (const owner of declarations)
      for (const [path, methods] of Object.entries(owner)) {
        for (const [method, entry] of Object.entries(methods)) {
          const key = `${method.toUpperCase()} ${path}`;
          if (metadata.has(key)) throw new Error(`Duplicate exposure declaration: ${key}`);
          if (!validExposure(entry.exposure))
            throw new Error(`Invalid exposure declaration: ${key}`);
          metadata.set(key, entry);
        }
      }
    for (const route of app['~routes']) {
      const [method, path] = route;
      const declared = metadata.get(
        `${method === '*' ? 'ALL' : method} ${path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`,
      );
      const exposure = declared?.exposure;
      const operationId = route[4]?.detail?.operationId ?? exposureOperationId(method, path);
      const hooks = route[4] ?? {};
      if (!route[4]) Reflect.set(route, 4, hooks);
      const prior = hooks.beforeHandle
        ? Array.isArray(hooks.beforeHandle)
          ? hooks.beforeHandle
          : [hooks.beforeHandle]
        : [];
      hooks.beforeHandle = [
        async function enforcePlatformExposure({ request }: { request: Request }) {
          // An anonymous probe of a member's own ban must get the same absence as
          // no ban. platform_closed would be a different answer.
          const memberBan = request.method === 'GET'
            && /\/v1\/realms\/[^/]+\/member-ban$/.test(new URL(request.url).pathname);
          if (exposure === 'public') return;
          try {
            if (!exposure || !work.platformAccess) throw new PlatformClosed();
            const principal = request.headers.has('authorization')
              ? await work.account.verify(request, [])
              : undefined;
            await work.platformAccess.require(principal, exposure, operationId);
          } catch (error) {
            if (memberBan && error instanceof PlatformClosed)
              return problem(404, 'appeal_unavailable', 'Appeal is unavailable');
            return platformExposureProblem(error);
          }
        },
        ...prior,
      ];
      hooks.detail = { ...hooks.detail, ...(exposure ? { 'x-rezics-exposure': exposure } : {}) };
    }
    // A public mutation invalidates Elysia's composed-route metadata cache after
    // compiler-input hooks change, including when generation read it earlier.
    app.use(new Elysia({ name: 'main-platform-exposure' }));
    return app;
  };
}
