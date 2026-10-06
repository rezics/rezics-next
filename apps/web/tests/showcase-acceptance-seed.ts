// A small Games Zone written through Main's public routes into the isolated QA stack the e2e harness started:
// a game Work with its own showcase art, and a Zone whose home leads with two slides, the game's and a campaign
// link slide whose art carries the description its author wrote. It leaves the identifiers in
// `.temp/showcase-acceptance/<run>/seed.json` for showcase-acceptance.e2e.ts.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { campaignAlt, campaignTitle, gameTitle } from './showcase-acceptance-data.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The showcase acceptance seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
if (!objectDirectory || !authPath) {
  throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
}
const reader = JSON.parse(readFileSync(authPath, 'utf8')) as { principalId: string; actingSubject: string };
const short = (iri: string) => iri.slice(-36);
const ref = () => `https://rezics.com/id/${randomUUID()}`;

const stack = await startMediaStack('showcase-acceptance', { agents: true, rights: true, library: true });
for (const prefix of ['semantic/work/', 'semantic/structure/']) {
  const objects = stack.objects(prefix);
  await objects.initialize();
  Object.assign(stack.env, { objectDirectory, [prefix === 'semantic/work/' ? 'workObjects' : 'structureObjects']: objects });
}

async function json<T = Record<string, unknown>>(response: Response, status: number, label: string): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${label}: expected ${status}, got ${response.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text) as T;
}

/** An image of the given size, as a stage background or a logo; a logo is transparent but for its words. */
async function art(width: number, height: number, hue: number, words: string, logo = false) {
  // A logo's words span its width; a background's headline is large but not the whole frame.
  const font = logo ? Math.floor(width / Math.max(words.length * 0.62, 1)) : Math.round(Math.min(width / 8, height / 3));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${logo ? '' : `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 22%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 50) % 360} 60% 42%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>
      <circle cx="${width * .72}" cy="${height * .42}" r="${height * .3}" fill="#fff" opacity=".12"/>`}
    <text x="${logo ? width / 2 : width * .08}" y="${logo ? height * .65 : height * .72}" ${logo ? 'text-anchor="middle"' : ''}
      font-family="sans-serif" font-weight="700" font-size="${font}" fill="#fff">${words}</text></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

const owner = await stack.member('showcase-owner');
try {
  for (const [scope, action] of [['work:create:root', 'work.create'], ['space:create:root', 'space.create'],
    [`media:owner:${owner.actor}`, 'media.labels']] as const) await owner.grant(scope, action);

  // The game: a public Work typed as a video game, whose Main Version selects its own text.
  const types = ['https://schema.org/VideoGame'];
  const created = await activateMetadataWork(stack.env, { title: gameTitle, language: 'en', semanticTypes: types,
    admission: stack.admission(owner.actor, 'work:create:root', 'work.create',
      metadataWorkRequestDigest(gameTitle, types, 'en')) });
  const text = await stack.contribution(created.work, owner.actor, 'en', `${gameTitle} description ${randomUUID()}`);
  const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
    contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: owner.actor };
  const selected = await selectMainDefault(stack.env, stack.admission(owner.actor,
    `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(input)), input);
  if (selected.outcome !== 'succeeded') throw new Error('Main selection failed');
  const work = created.work;
  // The signed-in reader sees what a signed-out one does, and may read the Work.
  await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [`work:read:${work}`]);
  await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'work.read',now() + interval '8 hours')`, [randomUUID(), reader.principalId, reader.actingSubject]);
  await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1,$2,$2,$3,'work.read',now() + interval '8 hours')`, [randomUUID(), reader.actingSubject, `work:read:${work}`]);

  // The Work's own art: a landscape and a portrait background and an English logo.
  await owner.grant(`media:avatar:${work}`, 'media.avatar');
  const whole = 'xywh=percent:0,0,100,100';
  for (const [role, width, height, extra] of [['background-landscape', 1920, 1080, {}], ['background-portrait', 960, 1280, {}],
    ['logo', 600, 200, { language: 'en', tone: 'light', anchor: 'start-bottom' }]] as const) {
    const upload = await owner.upload(await art(width, height, 150, role === 'logo' ? gameTitle : '', role === 'logo'));
    await json(await owner.send('PUT', `/v1/resources/${short(work)}/showcase/art`, { profile: 'work-showcase-selection-v1',
      expectedSelection: null, role, ...extra, asset: upload.asset, crop: whole, focalArea: null, actingSubject: owner.actor },
    `showcase-${role}-${randomUUID()}`), 201, `Work ${role}`);
  }
  const batch = await json<{ items: { reference: string; images: { representation: string; use: string }[] }[] }>(
    await stack.call('POST', '/v1/resources/showcase', { body: { profile: 'work-showcase-batch-v1', targets: [work] } }), 200,
    'Work showcase read');
  const workImages = batch.items[0]!.images;

  // The Zone: a Space with a Realm, the Zone on it, and the game adopted into the Realm.
  const space = await json<{ space: string; realm: string }>(await owner.send('POST', '/v1/spaces', {
    profile: 'space-realm-v1', name: 'Games', capabilities: ['realm'], actingSubject: owner.actor }), 201, 'Space');
  const zone = ref();
  await owner.grant(`zone:edit:${zone}`, 'zone.edit');
  await owner.grant(`publication:adopt:${space.realm}`, 'publication.adopt');
  await json(await owner.send('POST', '/v1/zones', { zone, space: space.space, disclosure: 'public', name: 'Games',
    language: 'en', actingSubject: owner.actor }), 201, 'Zone');
  await json(await owner.send('POST', '/v1/publication-selections', { profile: 'realm-local-selection-v1',
    context: { kind: 'realm-local', id: space.realm }, work, mainVersion: created.mainVersion, contribution: text.contribution,
    publicationDecision: text.decision, expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
    actingSubject: owner.actor }), 201, 'Adoption');

  // A campaign slide has no Work to carry art: its art is a Use of the Realm, made through the Zone.
  const campaign: { use: string; representation: string }[] = [];
  for (const [role, width, height] of [['background-landscape', 1920, 1080], ['background-portrait', 960, 1280]] as const) {
    const upload = await owner.upload(await art(width, height, 30, campaignTitle));
    const made = await json<{ id: string }>(await owner.send('POST', `/v1/zones/${short(zone)}/campaign-art`, {
      profile: 'zone-campaign-art-v1', realm: space.realm, asset: upload.asset, role, crop: whole, focalArea: null,
      actingSubject: owner.actor }), 201, `Campaign ${role}`);
    campaign.push({ use: made.id, representation: upload.representation });
  }

  // Unassessed images stay masked for readers, so the demo art is labelled as its owner's safe work.
  const labelled = [...workImages, ...campaign];
  const metadata = await json<{ items: { status: string; representation: string; nsfw: string;
    controls: { nsfw: { basis: unknown; valueHead: string | null } } }[] }>(await stack.call('POST', '/v1/media/metadata',
    { body: { items: labelled.map(({ representation, use }) => ({ representation, use })) } }),
  200, 'Media metadata');
  for (const item of metadata.items.filter(entry => entry.status === 'available' && entry.nsfw === 'unknown')) {
    await json(await owner.send('POST', `/v1/media/representations/${item.representation}/labels`, {
      actingSubject: owner.actor, field: 'nsfw', basis: item.controls.nsfw.basis, expectedValueHead: item.controls.nsfw.valueHead,
      value: 'sfw', mode: 'edit', authority: 'author' }), 201, `Label ${item.representation}`);
  }

  const head = await json<{ revision: string }>(await owner.read(`/v1/zones/${short(zone)}/configuration`), 200, 'Zone configuration');
  await json(await owner.send('PUT', `/v1/zones/${short(zone)}/configuration`, {
    expectedHead: head.revision, defaultRealm: space.realm, actingSubject: owner.actor,
    presentation: { ...DEFAULT_ZONE_PRESENTATION,
      modules: [{ id: 'picks', type: 'hero-carousel', title: 'Featured', source: { kind: 'query-block', block: 'new-adoptions' } }],
      slides: [{ id: 'game', work },
        { id: 'jam', title: campaignTitle, kicker: 'Community', href: '/about',
          art: { landscape: { use: `https://rezics.com/id/${campaign[0]!.use}`, alt: campaignAlt },
            portrait: { use: `https://rezics.com/id/${campaign[1]!.use}`, alt: campaignAlt } } }] } }), 200, 'Zone presentation');

  const directory = resolve('.temp/showcase-acceptance', process.env.REZICS_QA_RUN_ID!);
  mkdirSync(directory, { recursive: true });
  const seeded = { space: space.space, zone, realm: space.realm, work };
  writeFileSync(resolve(directory, 'seed.json'), JSON.stringify(seeded));
  console.log(JSON.stringify(seeded));
} finally {
  await stack.stop();
}
