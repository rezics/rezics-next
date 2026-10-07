import { isDeepStrictEqual } from 'node:util';
import { SeedApiError } from './api.ts';

/**
 * Official Zone placement on a persistent stack.
 * The create key stays bound to the first request body. A later Space, steward
 * or package change must not replay that create: read the Zone and apply
 * presentation through its configuration command. Package digest approval is
 * the theme step that follows this placement. One configuration read, at most
 * one Realm read when the planned default differs, and at most one create and
 * one configuration write.
 */
export interface OfficialZoneHead {
  revision: string;
  configuration: {
    /** Null when the read omitted the Zone's Space; the planned Realm is then kept out. */
    space: string | null;
    defaultRealm: string | null;
    official: Record<string, never> | null;
    presentation: unknown;
  };
}

export interface ZoneSeedApi {
  get<T>(path: string, token: string): Promise<T>;
  post<T>(path: string, body: unknown, token: string, key: string): Promise<T>;
  put<T>(path: string, body: unknown, token: string, key: string): Promise<T>;
}

interface ZoneIdentity {
  zone: string;
  actor: string;
  token: string;
}

const configurationPath = (zone: string, actor: string) =>
  `/v1/zones/${zone.slice(-36)}/configuration?${new URLSearchParams({ actingSubject: actor })}`;

function problemCode(error: unknown): { status: number; code: string } | null {
  if (!(error instanceof SeedApiError)) return null;
  try {
    const body = JSON.parse(error.detail) as { code?: string };
    return { status: error.status, code: body.code ?? '' };
  } catch {
    return { status: error.status, code: '' };
  }
}

const missingZone = (error: unknown) => problemCode(error)?.status === 404;

/** Theme execution control answers only to an operator. Zone configuration reports a
 * missing grant as "not found", so that 404 means absence only after this read succeeds. */
export async function proveOperatorAuthority(
  api: Pick<ZoneSeedApi, 'get'>,
  token: string,
): Promise<void> {
  try {
    await api.get('/v1/themes/execution-control', token);
  } catch (error) {
    const status = error instanceof SeedApiError ? error.status : 0;
    throw new Error(
      `Seed operator is not authorized (HTTP ${status}); a masked Zone denial will not be treated as absence`,
    );
  }
}

function idempotencyConflict(error: unknown): boolean {
  const problem = problemCode(error);
  return problem?.status === 409 && problem.code === 'idempotency_conflict';
}

/** Read the steward's Zone. Create it only when it is absent. A conflicting
 * create means the Zone already exists under an older request body. */
export async function readOrCreateOfficialZone(
  api: Pick<ZoneSeedApi, 'get' | 'post'>,
  input: ZoneIdentity & {
    space: string;
    key: string;
    name?: string;
    language?: string;
    /** Proves operator authority before a 404 is treated as an absent Zone. */
    operatorApi: Pick<ZoneSeedApi, 'get'>;
    operatorToken: string;
  },
): Promise<OfficialZoneHead> {
  await proveOperatorAuthority(input.operatorApi, input.operatorToken);
  const path = configurationPath(input.zone, input.actor);
  const read = () => api.get<OfficialZoneHead>(path, input.token);
  try {
    return await read();
  } catch (error) {
    if (!missingZone(error)) throw error;
  }
  let conflict: unknown;
  try {
    await api.post(
      '/v1/zones',
      {
        zone: input.zone,
        space: input.space,
        // Name stays in the first create body. A later read must not change that key.
        ...(input.name !== undefined ? { name: input.name, language: input.language } : {}),
        disclosure: 'public',
        actingSubject: input.actor,
      },
      input.token,
      input.key,
    );
  } catch (error) {
    if (!idempotencyConflict(error)) throw error;
    conflict = error;
  }
  try {
    return await read();
  } catch (error) {
    if (conflict && missingZone(error)) throw conflict;
    throw error;
  }
}

/** An earlier seed may have created this Zone's Realm under another key.
 * A Realm on a different Space is readable and still unavailable as the default. */
async function officialZoneDefaultRealm(
  api: Pick<ZoneSeedApi, 'get'>,
  input: ZoneIdentity & { space: string | null; planned: string; current: string | null },
): Promise<string | null> {
  if (input.planned === input.current || !input.space) return input.current;
  try {
    const realm = await api.get<{ id?: unknown; space?: unknown }>(
      `/v1/realms/${input.planned.slice(-36)}?${new URLSearchParams({ actingSubject: input.actor })}`,
      input.token,
    );
    if (realm.id === input.planned && realm.space === input.space) return input.planned;
  } catch (error) {
    // A private or absent Realm has the same public answer. Other failures stay visible.
    if (!(error instanceof SeedApiError) || error.status !== 404) throw error;
  }
  return input.current;
}

/** Write the seed layout only when the retained head differs. A Main that
 * rejects localized tab labels receives the same layout with default labels.
 * At most one Realm read and one configuration write. */
export async function updateOfficialZonePresentation(
  api: Pick<ZoneSeedApi, 'get' | 'put'>,
  input: ZoneIdentity & {
    head: OfficialZoneHead;
    defaultRealm: string;
    candidates: readonly { variant: string; presentation: unknown }[];
    key: (revision: string, variant: string) => string;
  },
): Promise<void> {
  const current = {
    defaultRealm: input.head.configuration.defaultRealm ?? null,
    official: input.head.configuration.official,
    presentation: input.head.configuration.presentation,
  };
  const defaultRealm = await officialZoneDefaultRealm(api, {
    zone: input.zone,
    actor: input.actor,
    token: input.token,
    space: input.head.configuration.space,
    planned: input.defaultRealm,
    current: current.defaultRealm,
  });
  for (const [index, candidate] of input.candidates.entries()) {
    const desired = {
      defaultRealm,
      official: {},
      presentation: candidate.presentation,
    };
    if (isDeepStrictEqual(current, desired)) return;
    try {
      await api.put(
        `/v1/zones/${input.zone.slice(-36)}/configuration`,
        {
          expectedHead: input.head.revision,
          actingSubject: input.actor,
          ...desired,
        },
        input.token,
        input.key(input.head.revision, candidate.variant),
      );
      return;
    } catch (error) {
      const last = index === input.candidates.length - 1;
      if (last || !(error instanceof SeedApiError) || error.status !== 400) throw error;
    }
  }
}
