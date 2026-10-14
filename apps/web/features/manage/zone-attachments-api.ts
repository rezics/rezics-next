import { send } from './commands.ts';
import { iriOf, uuidOf, type MainClient } from './types.ts';
const resourceIri = (value: string) => iriOf(uuidOf(value));

/** Realm stewardship ends an attachment without requiring Zone edit authority. */
export async function withdrawRealmAttachment(main: MainClient, input: {
  zone: string; realm: string; actingSubject: string; key: string;
}) {
  const answer = await send(() => main.v1.zones({ id: uuidOf(input.zone) })['realm-attachment-withdrawals'].post(
    { realm: resourceIri(input.realm), actingSubject: input.actingSubject },
    { headers: { 'idempotency-key': input.key } },
  ));
  if (answer.ok && (!('zone' in answer.data) || answer.data.zone !== resourceIri(input.zone)
    || answer.data.realm !== resourceIri(input.realm) || !answer.data.receipt)) {
    return { ok: false as const, failure: 'unavailable' as const };
  }
  return answer;
}
