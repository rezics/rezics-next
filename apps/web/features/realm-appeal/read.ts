import { cookies } from 'next/headers';
import type { MainClient } from '../discover/types.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { mainReadHeaders } from '../api/main-read.ts';
import { serviceOrigin } from '../api/origins.ts';
import { gateFor, operationOpen } from '../api/platform-access.ts';
import { readPlatformAccess } from '../api/main.ts';
import { SERVER_READ_LIMITS } from '../api/server-fetch.ts';
import { serverRead } from '../api/server-read.ts';
import { readMemberBan } from './ban-read.ts';
import { readingFromBanResponse, type BanReading } from './reading.ts';

/**
 * The member's own ban: `GET /v1/realms/{realm}/member-ban?actingSubject=`.
 * Exposure is `platform:realm-appeals`, bearer, read family. Only the
 * controller of `actingSubject` may call it. A 404 is byte-identical for no
 * ban, an expired ban, and any other caller, and this returns nothing in every
 * one of those cases. A reversal stays readable: outcome `reversed`, `decidedAt`
 * and `liftedAt`. The lift receipt id and the decider stay off this reading.
 */
export async function readOwnRealmBan(realm: string, actingSubject: string, client?: MainClient): Promise<BanReading | null> {
  const id = realm.slice(-36);
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  // A caller that already holds the request client (the page, or a replay) uses it.
  // The platform gate stays here, so a closed operation still makes no request.
  if (client) {
    const access = await readPlatformAccess();
    const read = await readMemberBan(client, realm, actingSubject, gateFor(access));
    return read.ok ? read.reading : null;
  }
  try {
    if (operationOpen('getV1RealmsByRealmMember-ban', await readPlatformAccess())) {
      const token = (await cookies()).get(ACCESS_COOKIE)?.value;
      if (!token) return null;
      const response = await serverRead(
        new URL(`/v1/realms/${id}/member-ban?actingSubject=${encodeURIComponent(actingSubject)}`,
          serviceOrigin('MAIN_ORIGIN')), {
          headers: await mainReadHeaders({ authorization: `Bearer ${token}` }),
          cache: 'no-store',
        }, { timeoutMs: SERVER_READ_LIMITS.metadata });
      if (response.status !== 200) {
        await response.body?.cancel();
        return null;
      }
      return readingFromBanResponse(response.status, await response.json());
    }
    return null;
  } catch {
    return null;
  }
}
