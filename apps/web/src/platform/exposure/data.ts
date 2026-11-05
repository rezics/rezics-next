import type { KernelClient } from '@rezics/client';

export type Action = 'open' | 'close';
export type Intent = Readonly<{ group: string; action: Action; key: string; body: Readonly<Record<string, never>> }>;
export type ViewerContext = Readonly<{ accountId: string; clientId: string }>;
export type ActionAdvice = Readonly<Record<Action, boolean>>;
export type CurrentExposure =
  | {
      status: 'available';
      viewer: ViewerContext;
      actions: ActionAdvice;
      exposureGroups: { group: string; open: boolean; at: string }[];
      next: string | null;
    }
  | { status: 'invalid-cursor' | 'signed-out' | 'denied' }
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
export type Discovery = { status: 'available'; groups: string[] } | { status: 'unavailable' };
export type Page =
  | { status: 'ready'; discovery: Discovery; current: Extract<CurrentExposure, { status: 'available' }> }
  | { status: 'invalid-cursor' | 'signed-out' | 'denied' | 'unavailable'; discovery: Discovery };
/** The production reader identity captured from the same prepared request as its credential. */
export type ExposureReaderEnvelope = Readonly<{ page: Page; sessionSubject: string | null }>;
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
async function responseProblemCode(value: unknown): Promise<string | undefined> {
  if (value instanceof Response) {
    try {
      return await responseProblemCode(await value.clone().json());
    } catch {
      return undefined;
    }
  }
  if (!object(value)) return undefined;
  if (typeof value.code === 'string') return value.code;
  for (const nested of [value.value, value.error]) {
    const code = await responseProblemCode(nested);
    if (code) return code;
  }
  return undefined;
}
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
    if (result.status === 401) return { status: 'signed-out' };
    if (result.status === 403) return { status: 'denied' };
    if (
      result.status === 400 &&
      query.cursor !== undefined &&
      (await responseProblemCode(result.error)) === 'invalid_cursor'
    )
      return { status: 'invalid-cursor' };
    const value: unknown = result.data;
    if (
      result.error ||
      !object(value) ||
      Object.keys(value).length !== 4 ||
      !object(value.viewer) ||
      Object.keys(value.viewer).length !== 2 ||
      typeof value.viewer.accountId !== 'string' ||
      value.viewer.accountId.length === 0 ||
      typeof value.viewer.clientId !== 'string' ||
      value.viewer.clientId.length === 0 ||
      !object(value.actions) ||
      Object.keys(value.actions).length !== 2 ||
      typeof value.actions.open !== 'boolean' ||
      typeof value.actions.close !== 'boolean' ||
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
    return {
      status: 'available',
      viewer: { accountId: value.viewer.accountId, clientId: value.viewer.clientId },
      actions: { open: value.actions.open, close: value.actions.close },
      exposureGroups,
      next: value.next,
    };
  } catch {
    return unavailable;
  }
}

/** Consume only the real viewer-filtered mounted catalogue. Admission is never public opening data. */
export function parseDiscovery(value: unknown): Discovery | null {
  if (!object(value) || !object(value.paths) || Object.keys(value.paths).length > 4096) return null;
  const groups = new Set<string>();
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
    }
  }
  return { status: 'available', groups: [...groups].sort() };
}

async function readDiscovery(client: KernelClient, authorization: string): Promise<Discovery> {
  try {
    const result = await client['openapi.json'].get({
      headers: { authorization },
      fetch: { cache: 'no-store', signal: AbortSignal.timeout(2_000) },
    });
    const catalogue = result.error || !result.data ? null : parseDiscovery(result.data);
    return catalogue ?? { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function loadExposure(
  client: KernelClient,
  authorization: string,
  query: ExposureQuery = {},
): Promise<Page> {
  const [current, discovery] = await Promise.all([
    readCurrentExposure(client, authorization, query),
    readDiscovery(client, authorization),
  ]);
  if (current.status === 'available') return { status: 'ready', discovery, current };
  return { status: current.status, discovery };
}

export async function readExposureBound(
  query: ExposureQuery,
  dependencies: {
    prepare(): Promise<Request>;
    credential(request: Request): string | null;
    subject(request: Request): string | null;
    configured: boolean;
    read(authorization: string, query: ExposureQuery): Promise<Page>;
  },
): Promise<ExposureReaderEnvelope> {
  const request = await dependencies.prepare();
  const sessionSubject = dependencies.subject(request) ?? null;
  const authorization = dependencies.credential(request);
  if (!authorization) return { page: { status: 'signed-out', discovery: { status: 'unavailable' } }, sessionSubject };
  if (!dependencies.configured)
    return { page: { status: 'unavailable', discovery: { status: 'unavailable' } }, sessionSubject };
  return { page: await dependencies.read(authorization, query), sessionSubject };
}

/** A private native source page can supply selections independently of public discovery. */
export function hasExposureGroup(page: Extract<Page, { status: 'ready' }>, group: string): boolean {
  return page.current.exposureGroups.some((row) => row.group === group);
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
    !current.current.actions[operation.action]
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
