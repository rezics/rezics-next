import { type Community, realmOf } from '../communities.ts';
import { type MainClient, settle, uuidOf } from '../../feed/types.ts';

/** A pending invitation to join a Realm, with the names the page shows. */
export interface PendingInvitation {
  id: string;
  realm: string;
  realmName: string;
  realmLanguage?: string;
  realmIcon: Community['icon'];
  /** The Realm's page, by its Zone's address when it has one. */
  realmHref: string;
  inviterName: string | null;
  expiresAt: string;
}

/** Main's invitation page holds 50; a person rarely has more than a few open at once. */
const SHOWN = 10;

/**
 * The acting Agent's open invitations (G-314 `GET /v1/me/realm-invitations`),
 * oldest first, named with one public Realm and Agent read each. A refused or
 * failed read shows none rather than blocking the notifications.
 */
export async function readInvitations(main: MainClient, anonymous: MainClient, actingSubject: string, language: string,
  official: readonly Community[], now = Date.now()): Promise<PendingInvitation[]> {
  const page = await settle(() => main.v1.me['realm-invitations'].get({ query: { actingSubject } }));
  if (!page.ok) return [];
  const open = page.data.items.filter(item => item.state === 'pending' && Date.parse(item.expiresAt) > now).slice(0, SHOWN);
  const named = await Promise.all(open.map(async item => {
    const [realm, inviter] = await Promise.all([
      settle(() => anonymous.v1.realms({ realm: uuidOf(item.realm) }).get({ query: { language } })),
      settle(() => anonymous.v1.agents({ id: uuidOf(item.inviter) }).get({ query: {} }))]);
    if (!realm.ok) return null;
    const zone = official.find(community => realmOf(community) === item.realm);
    return { id: item.id, realm: item.realm, realmName: realm.data.name.value, realmLanguage: realm.data.name.language,
      realmIcon: realm.data.icon, realmHref: zone?.href ?? `/r/${uuidOf(item.realm)}`,
      inviterName: inviter.ok ? inviter.data.displayName : null, expiresAt: item.expiresAt } satisfies PendingInvitation;
  }));
  return named.filter(item => item !== null);
}
