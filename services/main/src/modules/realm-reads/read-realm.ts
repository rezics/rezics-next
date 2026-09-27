import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { chosenModerators, readCurrentProfile } from '../realm-profile/commands.ts';
import { AVATAR_POLICY, avatarImageEligible, DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { fallbackAvatar, selectName } from '../media/summary.ts';

export interface RealmBasis { id: string; space: string; revision: string }

/** A private Realm and an absent Realm have the same public answer. */
export async function readRealmBasis(session: WorkReadSession, realm: string): Promise<RealmBasis> {
  const rows = await session.query(`SELECT ?space ?revision WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space ; rv:head ?revision .
    ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
  } } LIMIT 2`, 1);
  if (!rows.length) throw new WorkReadMissing('Realm is unavailable');
  if (!rows[0]?.space || !rows[0].revision) throw new WorkReadUnavailable('Realm basis is incomplete');
  return { id: realm, space: rows[0].space.value, revision: rows[0].revision.value };
}

export async function readRealmHeader(session: WorkReadSession, realm: string) {
  const basis = await readRealmBasis(session, realm);
  const summary = (await session.summaries([realm]))[0];
  if (summary?.status !== 'available' || summary.type !== 'realm' || summary.disclosure !== 'public') {
    throw new WorkReadMissing('Realm is unavailable');
  }
  await readRealmBasis(session, realm);
  const path = `/v1/realms/${realm.slice(-36)}`;
  const published = await readCurrentProfile(session.deps.environment, realm);
  const selected = (value: { en: string; 'zh-CN': string }) =>
    selectName(new Map([['en', value.en], ['zh-cn', value['zh-CN']]]),
      session.options.language?.toLowerCase() ?? null)!;
  const profile = published?.profile;
  let banner = null;
  if (profile?.bannerSelection && session.deps.media?.store) {
    const row = await session.deps.media.store.avatarDelivery(profile.bannerSelection);
    if (row?.target === realm && row.context === realm && avatarImageEligible(row)) {
      banner = { kind: 'image' as const, selection: row.selection!,
        url: `/v1/media/avatars/${row.selection}`, mediaType: row.mediaType!,
        width: row.width!, height: row.height!, crop: row.crop,
        basis: { policy: AVATAR_POLICY, context: realm } };
    }
  }
  const icon = profile?.iconSelection
    ? summary.avatar.kind === 'image' && summary.avatar.selection === profile.iconSelection
      && summary.avatar.basis.context === DEFAULT_MEDIA_CONTEXT
      ? summary.avatar : fallbackAvatar('realm', realm)
    : profile ? fallbackAvatar('realm', realm) : summary.avatar;
  const moderators = profile ? [...await chosenModerators(session.deps.environment,
    realm, profile.moderators)] : [];
  const managedRules = await session.deps.governance?.rules?.publishedRealmRules(realm);
  const sourceRules = managedRules ?? profile?.rules;
  const rules = sourceRules ? await Promise.all(sourceRules.map(async rule => {
    let governanceRule = rule.governanceRule;
    if (governanceRule) {
      if (!session.deps.governance?.rules) governanceRule = null;
      else {
        let current: { revision: string } | null;
        try { current = await session.deps.governance.rules.current(governanceRule.ref,
          `governance:realm:${realm}`); }
        catch { throw new WorkReadUnavailable('Realm governance rule is unavailable'); }
        if (current?.revision !== governanceRule.revision) governanceRule = null;
      }
    }
    return { id: rule.id, title: selected(rule.title), body: selected(rule.body), governanceRule };
  })) : null;
  if (profile?.count.kind === 'exact' && !session.deps.access.publicRealmCount) {
    throw new WorkReadUnavailable('Realm count owner is unavailable');
  }
  const count = profile?.count.kind === 'exact'
    ? await session.deps.access.publicRealmCount!(realm) : profile?.count ?? { kind: 'unknown' as const, value: null };
  await readRealmBasis(session, realm);
  return { profile: 'realm-read-v1' as const, ...basis,
    name: profile ? selected(profile.name) : summary.name, icon,
    profileRevision: published?.revision ?? null,
    description: profile ? selected(profile.description) : null,
    banner, rules,
    membership: { count,
      publicMembers: null },
    moderators: { kind: profile ? 'known' as const : 'unknown' as const,
      items: profile ? profile.moderators.filter(agent => moderators.includes(agent)) : [] },
    sourcePosition: session.position,
    links: { works: `${path}/works`, decisions: `${path}/decisions` } };
}
