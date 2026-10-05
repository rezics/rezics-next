import { isDeepStrictEqual } from 'node:util';
import { SeedApiError } from './api.ts';

/**
 * Official Zone placement on a persistent stack.
 * The create key stays bound to the first request body. A later Space, steward
 * or package change must not replay that create: read the Zone and apply
 * presentation through its configuration command. Package digest approval is
 * the theme step that follows this placement. One configuration read, and at
 * most one create and one configuration write.
 */
export interface OfficialZoneHead {
  revision: string;
  configuration: {
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

function idempotencyConflict(error: unknown): boolean {
  const problem = problemCode(error);
  return problem?.status === 409 && problem.code === 'idempotency_conflict';
}

/** Read the steward's Zone. Create it only when it is absent. A conflicting
 * create means the Zone already exists under an older request body. */
export async function readOrCreateOfficialZone(
  api: Pick<ZoneSeedApi, 'get' | 'post'>,
  input: ZoneIdentity & { space: string; key: string },
): Promise<OfficialZoneHead> {
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

/** Write the seed layout only when the current head differs. A Main that
 * rejects localized tab labels receives the same layout with default labels. */
export async function updateOfficialZonePresentation(
  api: Pick<ZoneSeedApi, 'put'>,
  input: ZoneIdentity & {
    head: OfficialZoneHead;
    defaultRealm: string;
    candidates: readonly { variant: string; presentation: unknown }[];
    key: (revision: string, variant: string) => string;
  },
): Promise<void> {
  const current = {
    defaultRealm: input.head.configuration.defaultRealm,
    official: input.head.configuration.official,
    presentation: input.head.configuration.presentation,
  };
  for (const [index, candidate] of input.candidates.entries()) {
    const desired = {
      defaultRealm: input.defaultRealm,
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
