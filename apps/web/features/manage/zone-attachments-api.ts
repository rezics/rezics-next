import { send } from './commands.ts';
import { iriOf, uuidOf, type MainClient } from './types.ts';

/** Realm stewardship ends an attachment without requiring Zone edit authority. */
export async function withdrawRealmAttachment(main: MainClient, input: {
  zone: string; realm: string; actingSubject: string; key: string;
}) {
  const answer = await send(() => main.v1.zones({ id: uuidOf(input.zone) })['realm-attachment-withdrawals'].post(
    { realm: iriOf(input.realm), actingSubject: input.actingSubject },
    { headers: { 'idempotency-key': input.key } },
  ));
  if (answer.ok && (answer.data.zone !== iriOf(input.zone) || answer.data.realm !== iriOf(input.realm) || !answer.data.receipt)) {
    return { ok: false as const, failure: 'unavailable' as const };
  }
  return answer;
}

/** Zone stewardship uses its configuration head, independently of Realm stewardship. */
export function withdrawZoneAttachment(main: MainClient, input: {
  zone: string; expectedHead: string; actingSubject: string; key: string;
}) {
  return send(() => main.v1.zones({ id: uuidOf(input.zone) }).configuration.put(
    { expectedHead: input.expectedHead, defaultRealm: null, actingSubject: input.actingSubject },
    { headers: { 'idempotency-key': input.key } },
  ));
}
