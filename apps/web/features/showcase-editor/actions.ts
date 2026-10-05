'use server';

import type { ZoneText } from '@rezics/zone-sdk';
import { zoneText } from '../realm/adapt.ts';
import { reader } from '../work-page/read.ts';
import { writeKey } from '../work-levels-edit/write.ts';
import { canonicalTag, logoAnchors, type LogoAnchor, type LogoTone } from './art.ts';
import { refusalOf, type SaveResult } from './refusal.ts';

// The showcase editor's writes and its one extra read. Each write goes to Main as the session's
// Agent with the selection the person started from and a key derived from what it says, so a
// retried save replays and a changed one is a new write. What Main refuses comes back typed
// (`refusal.ts`); no rule about ratios, resolution or transparency is decided here.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const area = /^xywh=percent:[0-9.,]{7,60}$/;
const roles = ['background-landscape', 'background-portrait', 'logo', 'cutout'] as const;

export interface ArtSelection {
  work: string;
  role: (typeof roles)[number];
  language?: string;
  tone?: LogoTone;
  anchor?: LogoAnchor;
  /** The selection the person started from; null when the slot was empty. */
  expectedSelection: string | null;
  /** Null removes the slot's selection. */
  asset: string | null;
  crop: string | null;
  focalArea: string | null;
}

type Answer = { data: unknown; error: { status: number; value?: unknown } | null; headers?: unknown };

function settle(answer: Answer): SaveResult {
  if (answer.error) return refusalOf(answer.error, retryAfterOf(answer.headers));
  const data = answer.data as { selection?: unknown; replayed?: unknown } | null;
  return typeof data?.selection === 'string'
    ? { status: 'done', selection: data.selection, replayed: data.replayed === true }
    : { status: 'refused', refusal: 'unavailable', code: null, detail: null, current: null };
}

const retryAfterOf = (headers: unknown) => {
  const value = headers instanceof Headers ? headers.get('retry-after')
    : typeof headers === 'object' && headers !== null ? (headers as Record<string, unknown>)['retry-after'] : null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

const invalid: SaveResult = { status: 'refused', refusal: 'invalid', code: null, detail: null, current: null };

/** Selects, replaces or removes one role or logo key of the Work's showcase art. */
export async function saveShowcaseArt(input: ArtSelection): Promise<SaveResult> {
  const logo = input.role === 'logo';
  const language = logo && input.language ? canonicalTag(input.language) : null;
  if (!uuid.test(input.work) || !roles.includes(input.role) || (input.expectedSelection !== null && !uuid.test(input.expectedSelection))
    || (input.asset !== null && !uuid.test(input.asset)) || [input.crop, input.focalArea].some(value => value !== null && !area.test(value))
    || (logo && (!language || !['dark', 'light'].includes(input.tone ?? '') || !logoAnchors.includes(input.anchor!)))) return invalid;
  const { main, actingSubject } = await reader();
  if (!actingSubject) return { status: 'refused', refusal: 'sign-in', code: null, detail: null, current: null };
  const body = { profile: 'work-showcase-selection-v1' as const, expectedSelection: input.expectedSelection, role: input.role,
    ...(logo ? { language: language!, tone: input.tone!, anchor: input.anchor! } : {}),
    asset: input.asset, crop: input.asset ? input.crop : null, focalArea: input.asset ? input.focalArea : null, actingSubject };
  try {
    const key = await writeKey(['showcase-art', input.work, actingSubject, JSON.stringify(body)]);
    return settle(await main.v1.resources({ resource: input.work }).showcase.art.put(body, { headers: { 'idempotency-key': key } }));
  } catch {
    return { status: 'refused', refusal: 'unavailable', code: null, detail: null, current: null };
  }
}

/** Sets or removes (`url: null`) the Work's trailer link. */
export async function saveShowcaseTrailer(input: { work: string; expectedSelection: string | null; url: string | null }): Promise<SaveResult> {
  if (!uuid.test(input.work) || (input.expectedSelection !== null && !uuid.test(input.expectedSelection))
    || (input.url !== null && (typeof input.url !== 'string' || input.url.length > 2048))) return invalid;
  const { main, actingSubject } = await reader();
  if (!actingSubject) return { status: 'refused', refusal: 'sign-in', code: null, detail: null, current: null };
  const body = { profile: 'work-showcase-trailer-v1' as const, expectedSelection: input.expectedSelection,
    url: input.url?.trim() || null, actingSubject };
  try {
    const key = await writeKey(['showcase-trailer', input.work, actingSubject, JSON.stringify(body)]);
    return settle(await main.v1.resources({ resource: input.work }).showcase.trailer.put(body, { headers: { 'idempotency-key': key } }));
  } catch {
    return { status: 'refused', refusal: 'unavailable', code: null, detail: null, current: null };
  }
}

/**
 * The Work's title and tagline as Main selects them for a reader of `language`, for the preview's
 * reader language: the stage shows Main's title and matches the logo to the title's language.
 */
export async function readPreviewTitle(work: string, language: string): Promise<{ title: ZoneText; tagline: ZoneText | null } | null> {
  const tag = canonicalTag(language);
  if (!uuid.test(work) || !tag) return null;
  const { main, actingSubject } = await reader();
  try {
    const { data, error } = await main.v1.works({ id: work }).get({ query: { language: tag, actingSubject } });
    return data && !error ? { title: zoneText(data.title), tagline: zoneText(data.tagline) } : null;
  } catch {
    return null;
  }
}
