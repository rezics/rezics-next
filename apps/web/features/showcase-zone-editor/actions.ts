'use server';

import type { ZoneWork } from '@rezics/zone-sdk';
import { isUiLocale, type UiLocale } from '../../i18n/define.ts';
import { canonicalTag, type LogoAnchor, logoAnchors, type LogoTone } from '../showcase-editor/art.ts';
import { refusalOf, type SaveResult } from '../showcase-editor/refusal.ts';
import { reader } from '../work-page/read.ts';
import { writeKey } from '../work-levels-edit/write.ts';
import { type ConfigurationSave, configurationSaveOf } from './refusal.ts';
import { loadSlideWorks, readCampaignRegistry, readZoneShowcase, type ZoneShowcaseState } from './server.ts';
import type { Registry } from './art.ts';
import type { PresentationDocument } from './slides.ts';

// The showcase editor's writes and its reads after the page loaded. Each write goes to Main as the
// session's Agent with a key derived from what it says, so a retried save replays and a changed one
// is a new write. What Main refuses comes back typed; the rules about ratios, resolution,
// schedules and slide limits are Main's, never decided here.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const area = /^xywh=percent:[0-9.,]{7,60}$/;
const roles = ['background-landscape', 'background-portrait', 'logo', 'cutout'] as const;

const signIn: ConfigurationSave = { status: 'refused', refusal: 'sign-in', code: null, detail: null };
const unavailable: ConfigurationSave = { status: 'refused', refusal: 'unavailable', code: null, detail: null };
const invalid: ConfigurationSave = { status: 'refused', refusal: 'invalid', code: null, detail: null };

/** Replaces the Zone's presentation document with the edited one, naming the revision the person started from. */
export async function saveShowcase(input: { zone: string; expectedHead: string; presentation: PresentationDocument }): Promise<ConfigurationSave> {
  if (!uuid.test(input.zone) || !iri.test(input.expectedHead) || typeof input.presentation !== 'object' || input.presentation === null
    || input.presentation.profile !== 'zone-presentation-v2') return invalid;
  const { main, actingSubject } = await reader();
  if (!actingSubject) return signIn;
  const body = { expectedHead: input.expectedHead, actingSubject, presentation: input.presentation };
  try {
    const key = await writeKey(['zone-showcase', input.zone, actingSubject, input.expectedHead, JSON.stringify(input.presentation)]);
    const answer = await main.v1.zones({ id: input.zone }).configuration.put(body as never, { headers: { 'idempotency-key': key } });
    return configurationSaveOf(answer as Parameters<typeof configurationSaveOf>[0]);
  } catch {
    return unavailable;
  }
}

export interface CampaignArtInput {
  zone: string;
  /** The Realm the Zone's campaign art belongs to. */
  realm: string;
  role: (typeof roles)[number];
  language?: string;
  tone?: LogoTone;
  anchor?: LogoAnchor;
  /** The cleared upload. */
  asset: string;
  crop: string | null;
  focalArea: string | null;
}

export type CampaignArtResult = { status: 'done'; use: string; replayed: boolean }
  | Extract<SaveResult, { status: 'refused' }>;

const refusedWith = (refusal: Extract<SaveResult, { status: 'refused' }>['refusal']): CampaignArtResult =>
  ({ status: 'refused', refusal, code: null, detail: null, current: null });

/** Makes one uploaded image the Realm's campaign art for a slide's role (`POST /v1/zones/{id}/campaign-art`); the slide uses the Use it returns once the showcase is saved. */
export async function addCampaignArt(input: CampaignArtInput): Promise<CampaignArtResult> {
  const logo = input.role === 'logo';
  const language = logo && input.language ? canonicalTag(input.language) : null;
  if (!uuid.test(input.zone) || !iri.test(input.realm) || !uuid.test(input.asset) || !roles.includes(input.role)
    || [input.crop, input.focalArea].some(value => value !== null && !area.test(value))
    || (logo && (!language || !['dark', 'light'].includes(input.tone ?? '') || !logoAnchors.includes(input.anchor!)))) return refusedWith('invalid');
  const { main, actingSubject } = await reader();
  if (!actingSubject) return refusedWith('sign-in');
  const body = { profile: 'zone-campaign-art-v1' as const, realm: input.realm, asset: input.asset, role: input.role,
    ...logo ? { language: language!, tone: input.tone!, anchor: input.anchor! } : {},
    crop: input.crop, focalArea: input.focalArea, actingSubject };
  try {
    const key = await writeKey(['zone-campaign-art', input.zone, actingSubject, JSON.stringify(body)]);
    const answer = await main.v1.zones({ id: input.zone })['campaign-art'].post(body as never, { headers: { 'idempotency-key': key } });
    if (answer.error) {
      const refused = refusalOf(answer.error as { status: number; value?: unknown });
      return refused.status === 'refused' ? refused : refusedWith('unavailable');
    }
    const data = answer.data as { id?: unknown; replayed?: unknown } | null;
    return typeof data?.id === 'string' && uuid.test(data.id) ? { status: 'done', use: `https://rezics.com/id/${data.id}`, replayed: data.replayed === true }
      : refusedWith('unavailable');
  } catch {
    return refusedWith('unavailable');
  }
}

/** The Works the slides name, as the stage draws them: for a newly chosen Work, and for reading again after a conflict. */
export async function readSlideWorks(input: { realm: string; locale: string; works: string[] }): Promise<Record<string, ZoneWork | null>> {
  if (!iri.test(input.realm) || !isUiLocale(input.locale) || !Array.isArray(input.works)) return {};
  const { actingSubject } = await reader();
  return loadSlideWorks({ realm: input.realm, locale: input.locale as UiLocale, works: input.works,
    ...actingSubject ? { avatarQuery: `?actingSubject=${encodeURIComponent(actingSubject)}` } : {} });
}

export type LatestShowcase = { status: 'read'; state: ZoneShowcaseState; registry: Registry } | { status: 'unavailable' };

/** The Zone's showcase as it stands now: what a person reloads after a conflict. */
export async function readLatestShowcase(input: { zone: string }): Promise<LatestShowcase> {
  if (!uuid.test(input.zone)) return { status: 'unavailable' };
  const { main, actingSubject } = await reader();
  if (!actingSubject) return { status: 'unavailable' };
  const [read, registry] = await Promise.all([readZoneShowcase(main, input.zone, actingSubject), readCampaignRegistry(input.zone)]);
  return read.ok ? { status: 'read', state: read.state, registry } : { status: 'unavailable' };
}
