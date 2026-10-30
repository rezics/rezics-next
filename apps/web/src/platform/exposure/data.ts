import type { KernelClient } from '@rezics/client';

export const globalContext = Object.freeze({ route: 0, id: '00000000-0000-8000-8000-000000000000' });
export type Action = 'open' | 'close';
export type Intent = Readonly<{ group: string; action: Action; key: string; body: Readonly<Record<string, never>> }>;
export type Authority = { status: 'available'; offered: Action[] } | { status: 'unavailable' };
// Delivered management projection owned by the native current-exposure source.
export type CurrentExposure =
  | { status: 'available'; exposureGroups: { group: string; open: boolean; at: string }[]; next: string | null }
  | { status: 'unavailable'; missing: 'native-current-exposure-management-read' };
export type ExposureQuery = { cursor?: string; limit?: number };
export function parseExposureQuery(value: unknown = {}): ExposureQuery {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['cursor', 'limit'].includes(key)) ||
    (value.cursor !== undefined &&
      (typeof value.cursor !== 'string' || /^[A-Za-z0-9_-]{1,4096}$/.exec(value.cursor)?.[0] !== value.cursor)) ||
    (value.limit !== undefined &&
      (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100))
  )
    throw new Error('Invalid exposure page selection');
  return {
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
    ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
  };
}
export type Page =
  | { status: 'ready'; groups: string[]; inventory: 'visible-only'; current: CurrentExposure; authority: Authority }
  | { status: 'signed-out' | 'denied' | 'unavailable' };
export type Outcome =
  | {
      status: 'recorded';
      operation: Intent;
      receipt: { group: string; open: boolean; changed: boolean };
      current: Page;
    }
  | { status: 'uncertain'; operation: Intent; current: Page }
  | { status: 'not-sent'; current: Page };

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
// Installed route declarations are stricter than the command's historical hyphen allowance.
export const validGroup = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-z][a-z_]{0,62}$/.exec(value)?.[0] === value &&
  !['any', 'open', 'close'].includes(value);

export function parseIntent(value: unknown): Intent {
  if (
    !object(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(value).some((key) => !['group', 'action', 'key', 'body'].includes(key)) ||
    !validGroup(value.group) ||
    (value.action !== 'open' && value.action !== 'close') ||
    typeof value.key !== 'string' ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(value.key)?.[0] !== value.key ||
    !object(value.body) ||
    Object.keys(value.body).length !== 0
  )
    throw new Error('Invalid exposure operation');
  return Object.freeze({ group: value.group, action: value.action, key: value.key, body: Object.freeze({}) });
}

/** One bounded native page. Preserve the kernel's T verbatim, including microseconds. */
export async function readCurrentExposure(
  client: KernelClient,
  authorization: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<CurrentExposure> {
  const unavailable: CurrentExposure = { status: 'unavailable', missing: 'native-current-exposure-management-read' };
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return unavailable;
  try {
    const result = await client.platform.exposure.management.get({
      query: { ...query, limit },
      headers: { authorization },
      fetch: { cache: 'no-store' },
    });
    const value: unknown = result.data;
    if (
      result.error ||
      !object(value) ||
      Object.keys(value).length !== 2 ||
      !Array.isArray(value.exposureGroups) ||
      value.exposureGroups.length > limit ||
      !(
        value.next === null ||
        (typeof value.next === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.exec(value.next)?.[0] === value.next)
      )
    )
      return unavailable;
    const exposureGroups: Extract<CurrentExposure, { status: 'available' }>['exposureGroups'] = [];
    let previous = '';
    let at: string | undefined;
    for (const row of value.exposureGroups) {
      if (
        !object(row) ||
        Object.keys(row).length !== 3 ||
        !validGroup(row.group) ||
        row.group <= previous ||
        typeof row.open !== 'boolean' ||
        typeof row.at !== 'string' ||
        row.at.length > 64 ||
        /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.exec(row.at)?.[0] !==
          row.at ||
        !Number.isFinite(Date.parse(row.at)) ||
        (at !== undefined && row.at !== at)
      )
        return unavailable;
      previous = row.group;
      at = row.at;
      exposureGroups.push({ group: row.group, open: row.open, at: row.at });
    }
    if (value.next !== null && exposureGroups.length !== limit) return unavailable;
    return { status: 'available', exposureGroups, next: value.next };
  } catch {
    return unavailable;
  }
}

type Binding = { action: Action; type: string; id: string };
type Discovery = { groups: string[]; bindings: Binding[]; management: boolean };
/** Consume only the real viewer-filtered mounted catalogue. Admission is never public opening data. */
export function parseDiscovery(value: unknown): Discovery | null {
  if (!object(value) || !object(value.paths) || Object.keys(value.paths).length > 4096) return null;
  const groups = new Set<string>();
  const bindings: Binding[] = [];
  let management = false;
  let count = 0;
  for (const [path, methods] of Object.entries(value.paths)) {
    if (!object(methods)) return null;
    for (const [method, metadata] of Object.entries(methods)) {
      if (++count > 4096 || !object(metadata)) return null;
      const exposure = metadata['x-exposure'];
      if (typeof exposure !== 'string') return null;
      if (exposure.startsWith('gate:')) {
        const group = exposure.slice(5);
        if (!validGroup(group)) return null;
        groups.add(group);
        if (groups.size > 256) return null;
      } else if (exposure !== 'public') return null;
      if (
        path === '/v1/platform/exposure/management' &&
        method === 'get' &&
        metadata.operationId === 'exposure.read_management' &&
        metadata['x-action'] === 'exposure:manage_read' &&
        exposure === 'public'
      )
        management = true;
      for (const action of ['open', 'close'] as const) {
        if (
          method !== 'post' ||
          path !== `/v1/platform/exposure/{group}:${action}` ||
          metadata.operationId !== `exposure.${action}` ||
          metadata['x-action'] !== `exposure:${action}` ||
          exposure !== 'public'
        )
          continue;
        // Only an actual native resource binding can supply the type. Never guess semantic.context.
        const types = metadata['x-authority-resource-types'] ?? metadata['x-resource-types'];
        const fixedId = metadata['x-authority-resource-id'];
        if (metadata['x-authority-anchor'] !== undefined && metadata['x-authority-anchor'] !== 'resource') continue;
        if (metadata['x-account-authority'] !== undefined) continue;
        if (
          fixedId !== undefined &&
          (fixedId !== globalContext.id ||
            !Array.isArray(metadata['x-authority-resource-types']) ||
            !Array.isArray(types) ||
            types.length !== 1 ||
            types[0] !== 'semantic.context')
        )
          continue;
        if (
          Array.isArray(types) &&
          types.length === 1 &&
          typeof types[0] === 'string' &&
          /^[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z][A-Za-z0-9_.-]*)?$/.test(types[0])
        )
          bindings.push({ action, type: types[0], id: fixedId === undefined ? globalContext.id : fixedId });
      }
    }
  }
  return { groups: [...groups].sort(), bindings, management };
}

async function readAuthority(client: KernelClient, authorization: string, bindings: Binding[]): Promise<Authority> {
  if (bindings.length === 0) return { status: 'unavailable' };
  try {
    const references = [...new Map(bindings.map(({ type, id }) => [`${type}/${id}`, { type, id }])).values()];
    const result = await client.viewerActions.post(
      { resources: references },
      { headers: { authorization }, fetch: { cache: 'no-store' } },
    );
    if (result.error || !result.data || result.data.resources.length !== references.length)
      return { status: 'unavailable' };
    const offered: Action[] = [];
    for (const { type, id } of references) {
      const resources = result.data.resources.filter((item) => item.type === type && item.id === id);
      if (resources.length !== 1 || !('viewerActions' in resources[0]!)) return { status: 'unavailable' };
      const resource = resources[0]!;
      if (!('viewerActions' in resource)) return { status: 'unavailable' };
      for (const binding of bindings.filter((binding) => binding.type === type && binding.id === id))
        if (
          resource.viewerActions.some(
            (entry) =>
              entry.action === `exposure:${binding.action}` && entry.operations.includes(`exposure.${binding.action}`),
          )
        )
          offered.push(binding.action);
    }
    return { status: 'available', offered: [...new Set(offered)] };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function loadExposure(
  client: KernelClient,
  authorization: string,
  query: ExposureQuery = {},
): Promise<Page> {
  try {
    const result = await client['openapi.json'].get({ headers: { authorization }, fetch: { cache: 'no-store' } });
    if (result.error || !result.data)
      return { status: result.status === 401 ? 'signed-out' : result.status === 403 ? 'denied' : 'unavailable' };
    const catalogue = parseDiscovery(result.data);
    if (!catalogue) return { status: 'unavailable' };
    return {
      status: 'ready',
      groups: catalogue.groups,
      inventory: 'visible-only',
      current: catalogue.management
        ? await readCurrentExposure(client, authorization, query)
        : { status: 'unavailable', missing: 'native-current-exposure-management-read' },
      authority: await readAuthority(client, authorization, catalogue.bindings),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/** A private native source page can supply selections independently of public discovery. */
export function hasExposureGroup(page: Extract<Page, { status: 'ready' }>, group: string): boolean {
  return (
    page.groups.includes(group) ||
    (page.current.status === 'available' && page.current.exposureGroups.some((row) => row.group === group))
  );
}

export async function commandExposure(
  client: KernelClient,
  authorization: string,
  input: Intent,
  query: ExposureQuery = {},
): Promise<Outcome> {
  const operation = parseIntent(input);
  const current = await loadExposure(client, authorization, query);
  if (
    current.status !== 'ready' ||
    !hasExposureGroup(current, operation.group) ||
    current.authority.status !== 'available' ||
    !current.authority.offered.includes(operation.action)
  )
    return { status: 'not-sent', current };
  try {
    const target = client.platform.exposure({ group: operation.group });
    const options = {
      headers: { authorization, 'idempotency-key': operation.key },
      fetch: { cache: 'no-store' as const },
    };
    // Generated bindings send native colon custom methods; native uses normal admission/write rates.
    const result =
      operation.action === 'open'
        ? await target.$open.post(operation.body, options)
        : await target.$close.post(operation.body, options);
    const readback = await loadExposure(client, authorization, query);
    const receipt = result.data?.exposure;
    if (
      result.error ||
      !receipt ||
      receipt.group !== operation.group ||
      receipt.open !== (operation.action === 'open') ||
      typeof receipt.changed !== 'boolean'
    )
      return { status: 'uncertain', operation, current: readback };
    return { status: 'recorded', operation, receipt, current: readback };
  } catch {
    return { status: 'uncertain', operation, current: await loadExposure(client, authorization, query) };
  }
}
