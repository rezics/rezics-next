import type { RealmVisibility, RealmReviewMode, RealmHistory } from '../space/policy.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { AdmissionUnavailable } from '../access/admission.ts';
import { chosenModerators, readCurrentProfile } from '../realm-profile/commands.ts';
import { AVATAR_POLICY, avatarImageEligible, DEFAULT_MEDIA_CONTEXT, type AvatarRow } from '../media/store.ts';
import { fallbackAvatar, resourceAvatar } from '../media/summary.ts';
import { legacyLocalizedText, selectDisplayName } from '../display-language/select.ts';
import { pageDiscoveryPolicy } from '../space/visibility.ts';
import { readRealmPolicy } from '../space/policy.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { discloseInventory, hasDisclosure } from '../disclosure/read.ts';

export interface RealmBasis { id: string; space: string; revision: string;
  visibility: RealmVisibility; reviewMode: RealmReviewMode; policyRevision: string | null;
  history: RealmHistory }

async function readRealmDisclosure(session: WorkReadSession, realm: string, revision: string) {
  if (!hasDisclosure(session.deps.environment)) throw new WorkReadUnavailable('Realm disclosure is unavailable');
  const read = async () => (await discloseInventory(session.deps.environment,
    [{ owner: 'graph', resource: realm, component: 'record', revision }], session.viewer, 'read'))[0];
  const decision = await read();
  // Closure must become the ordinary missing answer before selected-dependency
  // tracking can classify the newly hidden record as a cursor-basis change.
  if (decision !== 'visible') throw new WorkReadMissing('Realm is unavailable');
  session.observeDependency(`realm-disclosure:${realm}`, decision, read);
}

/** A private Realm and an absent Realm have the same public answer. */
export async function readRealmBasis(session: WorkReadSession, realm: string): Promise<RealmBasis> {
  const read = async () => {
  const policy = await session.realm(realm);
  if (!policy.realmRevision) throw new WorkReadUnavailable('Realm basis is incomplete');
  // The container uses its own head; a restricted public-profile revision
  // must not close otherwise readable Works, threads or membership routes.
  await readRealmDisclosure(session, realm, policy.realmRevision);
  return { id: realm, space: policy.space, revision: policy.realmRevision,
    visibility: policy.visibility, reviewMode: policy.reviewMode, policyRevision: policy.revision,
    history: policy.history };
  };
  return session.retained ? session.retained(`realm-basis:${realm}`, read) : read();
}

export async function readRealmHeader(session: WorkReadSession, realm: string) {
  const policy = await session.realm(realm);
  if (!policy.realmRevision) throw new WorkReadUnavailable('Realm basis is incomplete');
  if (!hasDisclosure(session.deps.environment)) throw new WorkReadUnavailable('Realm disclosure is unavailable');
  const decisions = await session.disclosure([
    { owner: 'graph', resource: realm, component: 'record' },
    { owner: 'graph', resource: realm, component: 'name', nameOwnerResolved: true },
  ]);
  if (decisions.some(decision => decision !== 'visible')) throw new WorkReadMissing('Realm is unavailable');
  const basis: RealmBasis = { id: realm, space: policy.space, revision: policy.realmRevision,
    visibility: policy.visibility, reviewMode: policy.reviewMode, policyRevision: policy.revision,
    history: policy.history };
  const published = await readCurrentProfile(session.deps.environment, realm);
  session.observeDependency(`realm-profile:${realm}`, published,
    () => readCurrentProfile(session.deps.environment, realm));
  const profile = published?.profile;
  // The header already owns Realm admission. Read only the legacy label and
  // image it needs, rather than resolving the Realm as another summary twice.
  const names = !profile ? await session.query(`SELECT ?name WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(policy.space)} a rv:Space ; rv:realmCapability ${iri(realm)} ; rdfs:label ?name .
  } } LIMIT 2`, 1) : [];
  if (!profile && (names.length !== 1 || !names[0]?.name)) throw new WorkReadMissing('Realm is unavailable');
  const legacyName = names[0]?.name ? selectDisplayName({ original: names[0].name['xml:lang'] ?? 'und',
    labels: { [names[0].name['xml:lang'] ?? 'und']: names[0].name.value } }, session.displayLanguages) : null;
  const readImage = async (context: string) => {
    if (!session.deps.media) return undefined;
    const read = () => session.deps.media!.store.avatarRows([realm], context);
    const media = await read();
    session.observeDependency(`realm-image:${realm}:${context}`,
      [media.generation.dataEpoch, media.rows.get(realm) ?? null], async () => {
        const current = await read();
        return [current.generation.dataEpoch, current.rows.get(realm) ?? null];
      });
    return media.rows.get(realm);
  };
  const image = !profile || profile.iconSelection ? await readImage(DEFAULT_MEDIA_CONTEXT) : undefined;
  let icon = resourceAvatar('realm', realm, image);
  if (profile && (icon.kind !== 'image' || icon.selection !== profile.iconSelection)) icon = fallbackAvatar('realm', realm);
  const path = `/v1/realms/${realm.slice(-36)}`;
  const selected = (value: { original: string; labels: Record<string, string> }
    | { en: string; 'zh-CN': string }) =>
    selectDisplayName('labels' in value ? value : legacyLocalizedText(value), session.displayLanguages)!;
  let banner = null;
  let bannerImage: AvatarRow | undefined;
  if (profile?.bannerSelection && session.deps.media?.store) {
    const row = await readImage(realm);
    if (row?.target === realm && row.context === realm && row.selection === profile.bannerSelection && avatarImageEligible(row)) {
      bannerImage = row;
      banner = { kind: 'image' as const, selection: row.selection!,
        url: `/v1/media/avatars/${row.selection}`, mediaType: row.mediaType!,
        width: row.width!, height: row.height!, crop: row.crop,
        basis: { policy: AVATAR_POLICY, context: realm } };
    }
  }
  const images = [icon.kind === 'image' ? image : undefined, bannerImage];
  const selectedImages = images.filter((row): row is AvatarRow => !!row?.asset);
  const imageDecisions = selectedImages.length ? await session.disclosure(selectedImages.map(row => ({
    owner: 'media' as const, resource: `https://rezics.com/id/${row.asset}`, component: 'cover' as const,
    context: row.context ?? undefined, ...(row.use ? { occurrence: { owner: 'media' as const,
      kind: 'media-use' as const, resource: `https://rezics.com/id/${row.use}`,
      revision: `https://rezics.com/id/${row.use}` } } : {}),
  })), 'summary') : [];
  if (image && icon.kind === 'image' && imageDecisions[selectedImages.indexOf(image)] !== 'visible') icon = fallbackAvatar('realm', realm);
  if (bannerImage && imageDecisions[selectedImages.indexOf(bannerImage)] !== 'visible') banner = null;
  const moderators = profile ? [...await chosenModerators(session.deps.environment,
    realm, profile.moderators)] : [];
  const governance = session.deps.governance?.rules;
  let snapshot: Awaited<ReturnType<NonNullable<typeof governance>['realmHeaderRules']>> | undefined;
  if (governance) {
    try { snapshot = await governance.realmHeaderRules(realm); }
    catch (error) { throw new WorkReadUnavailable('Realm governance rule is unavailable', { cause: error }); }
  }
  if (snapshot?.rules === null) throw new WorkReadUnavailable('Realm governance rule is unavailable');
  const rules = snapshot?.rules?.map(rule => {
    let governanceRule = rule.governanceRule;
    if (governanceRule && snapshot?.heads.get(governanceRule.ref)?.revision !== governanceRule.revision) {
      governanceRule = null;
    }
    return { id: rule.id, title: selected(rule.title), body: selected(rule.body), governanceRule };
  }) ?? null;
  if (profile?.count.kind === 'exact' && !snapshot && !session.deps.access.publicRealmCount) {
    throw new WorkReadUnavailable('Realm count owner is unavailable');
  }
  // The header rules statement already read this count on the recovery snapshot.
  // A second statement would put a ruled Realm over its request cap.
  const counted = snapshot
    ? Number(snapshot.memberValue ?? '0')
    : null;
  if (profile?.count.kind === 'exact' && snapshot
    && (counted === null || !Number.isSafeInteger(counted) || counted < 0)) {
    throw new AdmissionUnavailable('Realm count is unavailable');
  }
  const count = profile?.count.kind === 'exact'
    ? snapshot
      ? { kind: 'exact' as const, value: counted!, revision: snapshot.memberRevision ?? '0' }
      : await session.deps.access.publicRealmCount!(realm)
    : profile?.count ?? { kind: 'unknown' as const, value: null };
  // The session closes the exact profile, icon, policy and paired disclosure
  // dependencies after governance hydration, including private membership.
  return { profile: 'realm-read-v1' as const, ...basis,
    name: profile ? selected(profile.name) : legacyName!, icon,
    originalName: profile ? selectDisplayName(profile.name, []) : legacyName!,
    profileRevision: published?.revision ?? null,
    profileContract: published?.contract ?? null,
    listing: policy.listing, history: policy.history, admission: policy.admission,
    discovery: pageDiscoveryPolicy(basis.visibility === 'private' ? 'private' : 'public', policy.listing),
    description: profile ? selected(profile.description) : null,
    banner, rules,
    membership: { count,
      publicMembers: null },
    moderators: { kind: profile ? 'known' as const : 'unknown' as const,
      items: profile ? profile.moderators.filter(agent => moderators.includes(agent)) : [] },
    sourcePosition: session.position,
    links: { works: `${path}/works`, decisions: `${path}/decisions` } };
}

/** The request landing page is an explicit, bounded disclosure exception. It
 * never calls the full header hydrator or exposes roster, media, moderators,
 * capability links or history to an outsider. */
export async function readRealmLanding(session: WorkReadSession, realm: string) {
  try { return await readRealmHeader(session, realm); }
  catch (error) {
    if (!(error instanceof WorkReadMissing)) throw error;
    const policy = await readRealmPolicy(session.deps.environment, realm);
    if (!policy || policy.visibility !== 'private' || policy.admission !== 'request') throw error;
    // Request admission relaxes membership only; a closed record has no teaser.
    await readRealmDisclosure(session, realm);
    const published = await readCurrentProfile(session.deps.environment, realm);
    const selected = (value: { original: string; labels: Record<string,string> } | { en: string; 'zh-CN': string }) =>
      selectDisplayName('labels' in value ? value : legacyLocalizedText(value), session.displayLanguages)!;
    const names = await session.query(`SELECT ?name WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(policy.space)} a rv:Space ; rdfs:label ?name . } } LIMIT 2`, 2);
    if (names.length !== 1 || !names[0]?.name) throw new WorkReadUnavailable('Realm request page name is unavailable');
    const language = names[0].name['xml:lang'] ?? 'und';
    const name = published ? selected(published.profile.name)
      : selected({ original: language, labels: { [language]: names[0].name.value } });
    let rules;
    try { rules = await session.deps.governance?.rules?.publishedRealmRules(realm, true); }
    catch (error) { throw new WorkReadUnavailable('Realm governance rule is unavailable', { cause: error }); }
    if (rules === null || rules === undefined) {
      throw new WorkReadUnavailable('Realm governance rule is unavailable');
    }
    const current = await readRealmPolicy(session.deps.environment, realm);
    if (!current || current.revision !== policy.revision || current.visibility !== 'private'
      || current.admission !== 'request') throw new WorkReadMissing('Realm is unavailable');
    await readRealmDisclosure(session, realm);
    return { profile: 'realm-join-page-v1' as const, id: realm, space: policy.space, name,
      description: published ? selected(published.profile.description) : null,
      rules: rules.map(rule => ({ id: rule.id, title: selected(rule.title), body: selected(rule.body) })),
      action: { kind: 'request' as const, href: `/v1/realms/${realm.slice(-36)}/join-requests`, method: 'POST' as const,
        basis: `/v1/realms/${realm.slice(-36)}/join-requests/basis` },
      listing: policy.listing, discovery: pageDiscoveryPolicy('private', policy.listing), sourcePosition: session.position };
  }
}
