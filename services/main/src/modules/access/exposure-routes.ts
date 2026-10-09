import { Elysia, type AnyElysia } from 'elysia';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { problem } from '../../routes/problems.ts';
import { defaultPlatformOpenGroups } from '../../infrastructure/platform-open-groups.ts';
import {
  type AccessExposure,
  type ExposureDeclarations,
  platformGroupOpened,
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

const unauthenticated = (): Response =>
  problem(401, 'unauthorized', 'Authentication is required', { 'www-authenticate': 'Bearer' });

const appealUnavailable = (): Response =>
  problem(404, 'appeal_unavailable', 'Appeal is unavailable');

/** A closed ban or appeal read uses the same 404 as a missing one. Any other
 * status would reveal that the capability exists. */
export function platformExistenceHidden(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  return (
    /^\/v1\/realms\/(?:\{realm\}|[^/]+)\/member-ban$/.test(path) ||
    /^\/v1\/realms\/(?:\{realm\}|[^/]+)\/member-receipts\/(?:\{receiptId\}|[^/]+)\/appeal$/.test(path)
  );
}

/** Bind declarations to route hooks once, before Elysia compiles them. Each
 * compiled hook retains only its exposure and identity; requests do not consult
 * an operation registry. ~routes is the pinned Elysia compiler input, including
 * WS upgrades, whereas routes is a composed metadata snapshot. */
export function bindPlatformExposure(
  work: {
    account: Pick<AccountAssertionVerifier, 'verify'>;
    platformAccess?: Pick<AccessExposure, 'require'> & Partial<Pick<AccessExposure, 'groupOpened'>>;
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
          if (exposure === 'public') return;
          const access = work.platformAccess;
          // An open group is the stack setting, not a grant. Skip the grant read.
          const opened = typeof access?.groupOpened === 'function'
            ? access.groupOpened(exposure)
            : platformGroupOpened(exposure, defaultPlatformOpenGroups());
          if (opened) return;
          const hidden = platformExistenceHidden(request.method, new URL(request.url).pathname);
          // Anonymous and invalid bearers answer before any grant lookup.
          if (!request.headers.has('authorization'))
            return hidden ? appealUnavailable() : unauthenticated();
          try {
            const principal = await work.account.verify(request, []);
            if (!exposure || !access) throw new PlatformClosed();
            await access.require(principal, exposure, operationId);
          } catch (error) {
            if (hidden && error instanceof PlatformClosed) return appealUnavailable();
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
