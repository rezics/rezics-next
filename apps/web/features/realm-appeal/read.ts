import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { mainReadHeaders } from '../api/main-read.ts';
import { serviceOrigin } from '../api/origins.ts';
import { operationOpen, type PlatformOperationId } from '../api/platform-access.ts';
import { readPlatformAccess } from '../api/main.ts';
import { SERVER_READ_LIMITS } from '../api/server-fetch.ts';
import { serverRead } from '../api/server-read.ts';
import { parseBanReading, type BanReading } from './reading.ts';

const appealRead = 'getV1RealmsByRealmMember-receiptsByReceiptIdAppeal' satisfies PlatformOperationId;

/**
 * The member's own ban for this Realm.
 *
 * The appeal read answers the reason, the end date and the appeal, and it
 * never names the decider. It only answers when the caller already has the
 * receipt id. No current read gives that id to the sanctioned member: the
 * members list is a moderator read and omits the receipt and the reason, and
 * joining policy has no ban. Until `GET /v1/realms/{realm}/member-ban` exists,
 * this returns nothing and the page stays quiet.
 *
 * Privacy for that read: only the principal who controls `actingSubject`;
 * 404 when there is no ban and for every other caller; the body is the appeal
 * reading, including `decidedAt` once a resolution has one, and no decider.
 */
export async function readOwnRealmBan(realm: string, actingSubject: string): Promise<BanReading | null> {
  const id = realm.slice(-36);
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    if (!operationOpen(appealRead, await readPlatformAccess())) return null;
    const token = (await cookies()).get(ACCESS_COOKIE)?.value;
    if (!token) return null;
    const url = new URL(`/v1/realms/${id}/member-ban`, serviceOrigin('MAIN_ORIGIN'));
    url.searchParams.set('actingSubject', actingSubject);
    const response = await serverRead(url, {
      headers: await mainReadHeaders({ authorization: `Bearer ${token}` }),
      cache: 'no-store',
    }, { timeoutMs: SERVER_READ_LIMITS.metadata });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return parseBanReading(await response.json());
  } catch {
    return null;
  }
}
