import { BFF_PREFIX } from '../api/browser.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { retryAfterSeconds } from './report-api.ts';
import { fill, textFor, waitText } from './report.ts';

/**
 * What screening says about an uploaded image (Main's `clearance`, G-571).
 * Only `cleared` means other people can see it: an upload that finished is
 * not yet a visible image, and nothing here may say otherwise.
 */
export type Clearance = 'screening' | 'cleared' | 'held' | 'rejected';

const states: readonly Clearance[] = ['screening', 'cleared', 'held', 'rejected'];

/** A clearance Main reported, or `screening` for an answer that carries none: never assume visible. */
export const clearanceOf = (value: unknown): Clearance =>
  states.find(state => state === value) ?? 'screening';

/** `cleared` and `rejected` do not change on their own; `held` changes when staff decide. */
export const settled = (state: Clearance) => state === 'cleared' || state === 'rejected';

/** Seconds to wait before the next look: quick while the check runs, slow while a person reviews. */
export function nextCheckSeconds(state: Clearance, looked: number): number | null {
  if (settled(state)) return null;
  if (state === 'screening') return looked >= 12 ? null : [2, 2, 4, 8, 15][Math.min(looked, 4)]!;
  return looked >= 20 ? null : 30;
}

/** Looks up an upload's clearance as its uploader, or `null` when Main cannot say. */
export async function readClearance(upload: string, send: typeof fetch = fetch): Promise<Clearance | null> {
  try {
    const response = await send(`${BFF_PREFIX}/v1/media/uploads/${upload}`,
      { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) { await response.body?.cancel(); return null; }
    return clearanceOf(((await response.json()) as { clearance?: unknown }).clearance);
  } catch { return null; }
}

/** An upload refused for a spent budget names when to retry (G-543: `429` and `Retry-After`). */
export const limitedFor = (response: Response): { retryAfter: number } | null =>
  response.status === 429 ? { retryAfter: retryAfterSeconds(response) } : null;

/** The page-level wording for a save that refused its image, or null for any other failure. */
export function uploadErrorText(code: string | null | undefined, wait: string | null | undefined, locale: UiLocale): string | null {
  const t = textFor(locale);
  if (code === 'avatar-rejected') return `${t.uploadRejected}. ${t.uploadRejectedBody}`;
  if (code !== 'avatar-limited') return null;
  const seconds = Number(wait);
  return Number.isFinite(seconds) && seconds > 0 ? fill(t.uploadLimited, { time: waitText(seconds, locale) })
    : t.uploadLimitedShort;
}

/** The clearance a redirect carries back to the page, or null when it carries none. */
export const clearanceFromQuery = (value: string | null | undefined): Clearance | null =>
  value ? clearanceOf(value) : null;
