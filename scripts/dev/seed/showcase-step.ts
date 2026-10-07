import { SeedApiError } from './api.ts';
import { digest, focal, renderArt, wholeImage } from './showcase-art.ts';
import { grantShowcaseSeedAuthority } from './showcase-authority.ts';
import { type CampaignArt, type CampaignUses, retainedSlides, showcaseCampaigns, showcaseSlides, showcaseWorks, showcaseZone,
  type CampaignRole, type ShowcaseRoleKey, type ShowcaseWork } from './showcase-plan.ts';
import { officialPresentation, withoutTabLabels } from './official-plan.ts';
import { grantOfficialZoneSeed, type LocalOperatorInput } from './operator.ts';
import { realms, seedKey } from './plan.ts';
import { refreshSeedTokens, stableId, type SeedState, type Session } from './state.ts';
import { readOrCreateOfficialZone, updateOfficialZonePresentation } from './zones.ts';

// Showcase art through Main's own commands: the art is uploaded as the person
// who curates the Works and selected with the cover's authority. Every slot is
// read first, so a replay on a seeded stack uploads and selects nothing.

const short = (id: string) => id.slice(-36);
const anchor = 'start-bottom';

interface Current {
  role: ShowcaseRoleKey['role']; selection: string; asset: string; use: string; representation: string; language?: string; tone?: string;
  anchor?: string; focalArea: string | null;
}
interface Read { reference: string; status: string; images?: Current[]; trailer?: { selection: string; url: string } | null }

/** One public batch read of every planned Work, as a Work page or a Zone home reads it. */
async function readCurrent(state: SeedState, works: readonly string[]): Promise<Map<string, Read>> {
  const response = await fetch(`${state.endpoints.main}/v1/resources/showcase`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'work-showcase-batch-v1', targets: works }) });
  if (!response.ok) throw new SeedApiError('Showcase read', response.status, (await response.text()).slice(0, 500));
  const batch = await response.json() as { items: Read[] };
  return new Map(batch.items.map(item => [item.reference, item]));
}

const wanted = (key: ShowcaseRoleKey) => ({
  focalArea: key.role === 'background-landscape' || key.role === 'background-portrait' ? focal[key.role] : null,
  ...key.role === 'logo' ? { language: key.language, tone: key.tone, anchor } : {},
});

const present = (key: ShowcaseRoleKey, current: readonly Current[]) => current.find(image => image.role === key.role
  && (key.role !== 'logo' || image.language === key.language && image.tone === key.tone));

/** Whatever supplies art: a Work, or a campaign slide. */
type ArtOwner = Pick<ShowcaseWork, 'id' | 'hue' | 'names'>;

async function upload(state: SeedState, session: Session, work: ArtOwner, key: ShowcaseRoleKey) {
  const bytes = await renderArt(work, key);
  const sha256 = digest(bytes);
  const reserved = await state.api.post<{ asset: string; upload: string }>('/v1/media/uploads', {
    profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length, sha256,
    disclosure: 'public', actingSubject: session.actingSubject }, session.token,
  seedKey('showcase-upload', `${work.id}:${key.role}${'language' in key ? `:${key.language}:${key.tone}` : ''}:${sha256.slice(0, 16)}`));
  const sent = await fetch(`${state.endpoints.main}/v1/media/uploads/${reserved.upload}/bytes`, { method: 'PUT',
    headers: { authorization: `Bearer ${session.token}` }, body: new Blob([new Uint8Array(bytes)]) });
  if (!sent.ok) throw new SeedApiError('Showcase art bytes', sent.status, (await sent.text()).slice(0, 500));
  await sent.body?.cancel();
  return reserved;
}

async function select(state: SeedState, session: Session, work: ShowcaseWork, target: string, key: ShowcaseRoleKey,
  current: Current | undefined) {
  const asset = current?.asset ?? (await upload(state, session, work, key)).asset;
  const label = `${work.id}:${key.role}${'language' in key ? `:${key.language}:${key.tone}` : ''}`;
  await state.api.put(`/v1/resources/${short(target)}/showcase/art`, {
    profile: 'work-showcase-selection-v1', expectedSelection: current?.selection ?? null, role: key.role,
    ...'language' in key ? { language: key.language, tone: key.tone, anchor } : {}, asset,
    crop: wholeImage, focalArea: wanted(key).focalArea, actingSubject: session.actingSubject },
  session.token, seedKey('showcase-art', `${label}:${current?.selection ?? 'first'}`));
}

/** The Works the plan names, as Main knows them after the base seed and the official Zones. */
export function showcaseTargets(state: SeedState): { work: ShowcaseWork; target: string }[] {
  return showcaseWorks.flatMap(work => {
    const target = state.created.get(work.id)?.work ?? state.publicWorks.get(work.id)?.work.work;
    return target ? [{ work, target }] : [];
  });
}

interface Described { status: string; representation: string; nsfw: string;
  controls: { nsfw: { basis: unknown; valueHead: string | null } } }

/** Public metadata of every planned image, in one batch: the viewer's mask follows its NSFW label. */
async function readLabels(state: SeedState, images: readonly { representation: string; use: string }[]) {
  if (!images.length) return [];
  const response = await fetch(`${state.endpoints.main}/v1/media/metadata`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: images }) });
  if (!response.ok) throw new SeedApiError('Showcase metadata', response.status, (await response.text()).slice(0, 500));
  return (await response.json() as { items: Described[] }).items.filter(item => item.status === 'available');
}

/** Unassessed images stay masked for readers, so the demo art is labelled as the curator's own safe work. */
async function markSafe(state: SeedState, session: Session, items: readonly Described[]) {
  for (const item of items) {
    await state.optional(`Showcase art label ${item.representation}`, () => state.api.post(
      `/v1/media/representations/${item.representation}/labels`, { actingSubject: session.actingSubject,
        field: 'nsfw', basis: item.controls.nsfw.basis, expectedValueHead: item.controls.nsfw.valueHead,
        value: 'sfw', mode: 'edit', authority: 'author' }, session.token, seedKey('showcase-sfw', item.representation)));
  }
}

export async function seedShowcaseArt(state: SeedState) {
  if (!state.operatorInput) {
    state.findings.add('Showcase art: the local fixture operator is unavailable');
    return;
  }
  const input = state.operatorInput;
  const session = state.sessions.find(item => item.id === 'mira');
  if (!session) { state.findings.add('Showcase art: the demo curator has no session'); return; }
  const targets = showcaseTargets(state);
  for (const work of showcaseWorks) {
    if (!targets.some(item => item.work.id === work.id)) state.findings.add(`Showcase art: ${work.id} is not a Work yet`);
  }
  if (!targets.length) return;
  const plannedImages = (read: ReadonlyMap<string, Read>) => targets.flatMap(({ work, target }) =>
    (read.get(target)?.images ?? []).filter(image => work.slots.some(key => present(key, [image]))));
  const unlabelled = async (read: ReadonlyMap<string, Read>) => {
    const images = plannedImages(read).map(image => ({ representation: image.representation, use: image.use }));
    return readLabels(state, images).then(items => items.filter(item => item.nsfw === 'unknown'));
  };
  let current = await readCurrent(state, targets.map(item => item.target));
  const missing = targets.filter(({ work, target }) => {
    const images = current.get(target)?.images ?? [];
    return work.slots.some(key => !present(key, images)) || (work.trailer && !current.get(target)?.trailer);
  });
  if (!missing.length && !(await unlabelled(current)).length) return;
  const own = { ...input, ownerAccountSubject: session.accountId, actingSubject: session.actingSubject };
  const owner = `media:owner:${session.actingSubject}` as const;
  await grantShowcaseSeedAuthority(own, [{ action: 'media.upload', scope: owner }, { action: 'media.labels', scope: owner },
    ...missing.map(({ target }) => ({ action: 'media.avatar' as const, scope: `media:avatar:${target}` as const }))]);
  await refreshSeedTokens(state);
  for (const { work, target } of missing) {
    await state.optional(`Showcase art ${work.id}`, async () => {
      const images = current.get(target)?.images ?? [];
      for (const key of work.slots) {
        if (present(key, images)) continue;
        await select(state, session, work, target, key, undefined);
      }
      if (work.trailer && !current.get(target)?.trailer) {
        await state.api.put(`/v1/resources/${short(target)}/showcase/trailer`, {
          profile: 'work-showcase-trailer-v1', expectedSelection: null, url: work.trailer,
          actingSubject: session.actingSubject }, session.token, seedKey('showcase-trailer', work.id));
      }
    });
  }
  current = await readCurrent(state, targets.map(item => item.target));
  await markSafe(state, session, await unlabelled(current));
  for (const { work, target } of targets) {
    const images = current.get(target)?.images ?? [];
    const absent = work.slots.filter(key => !present(key, images));
    if (absent.length) state.findings.add(`Showcase art ${work.id}: ${absent.map(key => key.role).join(', ')} not selected`);
  }
}

/**
 * The Uses a campaign slide's art needs, created through the Zone's campaign-art command as the
 * Zone's steward, who uploads the images. A role the slide already holds is kept and uploads
 * nothing, so a replay writes nothing.
 */
async function seedCampaignArt(state: SeedState, steward: Session, input: LocalOperatorInput, zone: string, realm: string,
  retained: ReturnType<typeof retainedSlides>): Promise<CampaignArt> {
  const art = new Map<string, CampaignUses>();
  for (const campaign of showcaseCampaigns) {
    const held = retained.find(slide => slide.id === campaign.id)?.art;
    const uses: CampaignUses = {};
    const missing: { role: CampaignRole }[] = [];
    for (const { role } of campaign.slots) {
      const use = (role === 'background-landscape' ? held?.landscape : held?.portrait)?.use;
      if (use) uses[role] = use; else missing.push({ role });
    }
    if (missing.length) {
      const owner = `media:owner:${steward.actingSubject}` as const;
      await grantShowcaseSeedAuthority({ ...input, ownerAccountSubject: steward.accountId, actingSubject: steward.actingSubject },
        [{ action: 'media.upload', scope: owner }, { action: 'media.labels', scope: owner }]);
      await refreshSeedTokens(state);
      const created: { representation: string; use: string }[] = [];
      for (const key of missing) {
        await state.optional(`Showcase campaign art ${campaign.id}:${key.role}`, async () => {
          const reserved = await upload(state, steward, campaign, key);
          const result = await state.api.post<{ id: string | null }>(`/v1/zones/${short(zone)}/campaign-art`, {
            profile: 'zone-campaign-art-v1', realm, asset: reserved.asset, role: key.role, crop: wholeImage,
            focalArea: focal[key.role], actingSubject: steward.actingSubject },
          steward.token, seedKey('showcase-campaign-art', `${campaign.id}:${key.role}:${reserved.asset}`));
          if (!result.id) throw new SeedApiError('Showcase campaign art', 500, 'no Use was created');
          uses[key.role] = `https://rezics.com/id/${result.id}`;
          const status = await state.api.get<{ representation: string | null }>(`/v1/media/uploads/${reserved.upload}`, steward.token);
          if (status.representation) created.push({ representation: status.representation, use: result.id });
        });
      }
      await markSafe(state, steward, (await readLabels(state, created)).filter(item => item.nsfw === 'unknown'));
    }
    art.set(campaign.id, uses);
  }
  return art;
}

/**
 * The showcase Zone's home leads with these slides. The layout is the plan's
 * own (`officialPresentation`), so the realms step's replay keeps them, and the
 * write happens only when the retained head differs.
 */
export async function seedShowcaseSlides(state: SeedState) {
  const { operatorInput, operatorSession } = state;
  const realm = state.createdRealms.find(item => item.id === showcaseZone);
  const plan = realms.find(item => item.id === showcaseZone);
  if (!operatorInput || !operatorSession || !realm || !plan) {
    state.findings.add('Showcase slides: the Zone or the local fixture operator is unavailable');
    return;
  }
  const zone = `https://rezics.com/id/${stableId(`zone:${showcaseZone}`)}`;
  await grantOfficialZoneSeed({ ...operatorInput, ownerAccountSubject: realm.steward.accountId,
    actingSubject: realm.steward.actingSubject }, zone);
  const head = await readOrCreateOfficialZone(state.api, { zone, space: realm.receipt.space,
    actor: realm.steward.actingSubject, token: realm.steward.token, key: seedKey('zone', showcaseZone),
    operatorApi: operatorSession.api, operatorToken: operatorSession.token });
  const campaignArt = await seedCampaignArt(state, realm.steward, operatorInput, zone, realm.receipt.realm,
    retainedSlides(head.configuration.presentation));
  const slides = showcaseSlides(id => state.created.get(id)?.work ?? state.publicWorks.get(id)?.work.work, campaignArt);
  const presentation = officialPresentation(showcaseZone, plan.preset, undefined, slides);
  await updateOfficialZonePresentation(operatorSession.api, { zone, actor: realm.steward.actingSubject,
    token: operatorSession.token, head, defaultRealm: realm.receipt.realm,
    candidates: [{ variant: '', presentation }, { variant: ':plain', presentation: withoutTabLabels(presentation) }],
    key: (revision, variant) => seedKey('showcase-slides', `${showcaseZone}:${revision.slice(-36)}${variant}`) });
}

export async function seedShowcase(state: SeedState) {
  await state.optional('Showcase art', () => seedShowcaseArt(state));
  await refreshSeedTokens(state);
  await state.optional('Showcase slides', () => seedShowcaseSlides(state));
}
