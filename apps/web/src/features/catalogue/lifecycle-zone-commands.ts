type Headers = { authorization: string; 'idempotency-key': string; 'if-match': string };
type ZoneEnvelope = {
  status: number;
  data?: { zone: { revision: string; deletedAt?: string | null; restoreUntil?: string | null } } | null;
};

type ZoneCommands = {
  delete: (body: undefined, options: { headers: Headers }) => Promise<ZoneEnvelope>;
  $restore: { post: (body: Record<string, never>, options: { headers: Headers }) => Promise<ZoneEnvelope> };
  $takedown?: { post: (body: { pointers: string[] }, options: { headers: Headers }) => Promise<ZoneEnvelope> };
  $releaseTakedown?: {
    post: (body: { pointers: string[] }, options: { headers: Headers }) => Promise<ZoneEnvelope>;
  };
};

export type ZoneLifecycleClient = { zones: (input: { id: string }) => ZoneCommands };
export type ZoneLifecycleAddress = { id: string; revision: string; key: string };
export type ZoneTakedownCommand = ZoneLifecycleAddress & { pointers: string[] };
export type ZoneLifecycleFailure = {
  ok: false;
  reason: 'denied' | 'missing' | 'conflict' | 'invalid' | 'unavailable';
};
export type ZoneLifecycleResult =
  | ZoneLifecycleFailure
  | {
      ok: true;
      operation: 'delete' | 'restore' | 'takedown' | 'release';
      revision: string;
      deletedAt: string | null;
      restoreUntil: string | null;
    };

function headers(authorization: string, key: string, revision: string): Headers {
  return { authorization, 'idempotency-key': key, 'if-match': `"${revision}"` };
}

function failure(status: number): ZoneLifecycleFailure {
  if (status === 401 || status === 403) return { ok: false, reason: 'denied' };
  if (status === 404) return { ok: false, reason: 'missing' };
  if (status === 409 || status === 412) return { ok: false, reason: 'conflict' };
  if (status === 400 || status === 422) return { ok: false, reason: 'invalid' };
  return { ok: false, reason: 'unavailable' };
}

/** Owner delete and restore use the Zone resource; takedown is platform moderation on Global Context. */
export async function changeZoneLifecycle(
  client: ZoneLifecycleClient,
  authorization: string,
  command: ZoneLifecycleAddress & { operation: 'delete' | 'restore' },
): Promise<ZoneLifecycleResult> {
  const zone = client.zones({ id: command.id });
  const options = { headers: headers(authorization, command.key, command.revision) };
  const result =
    command.operation === 'delete' ? await zone.delete(undefined, options) : await zone.$restore.post({}, options);
  if (result.status !== 200 || !result.data) return failure(result.status);
  return {
    ok: true,
    operation: command.operation,
    revision: result.data.zone.revision,
    deletedAt: result.data.zone.deletedAt ?? null,
    restoreUntil: result.data.zone.restoreUntil ?? null,
  };
}

export async function changeZoneTakedown(
  client: ZoneLifecycleClient,
  authorization: string,
  command: ZoneTakedownCommand & { operation: 'takedown' | 'release' },
): Promise<ZoneLifecycleResult> {
  const zone = client.zones({ id: command.id });
  const endpoint = command.operation === 'takedown' ? zone.$takedown : zone.$releaseTakedown;
  if (!endpoint) return { ok: false, reason: 'unavailable' };
  const result = await endpoint.post(
    { pointers: command.pointers },
    { headers: headers(authorization, command.key, command.revision) },
  );
  if (result.status !== 200 || !result.data) return failure(result.status);
  return {
    ok: true,
    operation: command.operation,
    revision: result.data.zone.revision,
    deletedAt: result.data.zone.deletedAt ?? null,
    restoreUntil: result.data.zone.restoreUntil ?? null,
  };
}
