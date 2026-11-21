import { parseExposureDeclaration, type Exposure } from '@rezics/access';
import type { MountedRoute } from '../../http/request.ts';
import { PLATFORM_RESOURCE } from '../governance-reach.ts';

export type { Exposure } from '@rezics/access';

/** Parse trusted route metadata once, when the production kernel is composed. */
export function parseExposure(detail: unknown): Exposure {
  const metadata =
    typeof detail === 'object' && detail !== null && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)
      : undefined;
  try {
    return parseExposureDeclaration(metadata?.['x-exposure']);
  } catch {
    const route = typeof metadata?.operationId === 'string' ? metadata.operationId : '<unnamed route>';
    throw new Error(`${route}: routes declare x-exposure as public or gate:<group> with a valid, non-reserved group`);
  }
}

/** The only fixed authority anchor is the native Global Context. */
export function fixedGlobalResourceId(
  detail: Readonly<Record<string, unknown>>,
  route: Pick<MountedRoute, 'method' | 'path'>,
): string | undefined {
  const id = detail['x-authority-resource-id'];
  if (id === undefined) return;
  const types = detail['x-authority-resource-types'];
  if (
    id !== PLATFORM_RESOURCE.id ||
    (detail['x-authority-anchor'] ?? 'resource') !== 'resource' ||
    !Array.isArray(types) ||
    types.length !== 1 ||
    types[0] !== 'semantic.context' ||
    detail['x-account-authority'] !== undefined
  )
    throw new Error(`${route.method} ${route.path}: invalid x-authority-resource-id`);
  return id;
}
