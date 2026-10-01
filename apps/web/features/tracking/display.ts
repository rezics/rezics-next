import type { UiLocale } from '../../i18n/define.ts';
import { isKnownFormat, timeText } from './model.ts';
import type { Copy } from './messages.ts';
import type { Editions, Locator, LocatorUnit, Selection, SessionState } from './types.ts';

// How the words of tracking are chosen: Main's states and units named in the reader's language.

export function stateLabel(state: SessionState, t: Copy): string {
  return state === 'planned' ? t.statePlanned : state === 'active' ? t.stateActive : state === 'paused' ? t.statePaused
    : state === 'dnf' ? t.stateDnf : t.stateFinished;
}

export function moveLabel(state: SessionState, from: SessionState, t: Copy): string {
  return state === 'active' ? (from === 'planned' ? t.startReading : t.moveActive) : state === 'paused' ? t.movePaused : state === 'dnf' ? t.moveDnf
    : state === 'finished' ? t.moveFinished : stateLabel(state, t);
}

/** A language tag in the reader's language; the tag itself where the runtime has no name for it. */
export function languageName(tag: string, locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

export function formatLabel(format: string | null, t: Copy): string | null {
  if (format === null) return null;
  if (!isKnownFormat(format)) return format;
  return format === 'print' ? t.formatPrint : format === 'ebook' ? t.formatEbook : format === 'audiobook' ? t.formatAudiobook
    : t.formatWeb;
}

export function unitLabel(unit: LocatorUnit, t: Copy): string {
  return unit === 'page' ? t.unitPage : unit === 'percentage' ? t.unitPercentage : t.unitMediaTime;
}

/** `page 120`, `45%` or `1:02:03`: one point of a position in its own unit. */
export function pointText(unit: LocatorUnit, value: number, t: Copy): string {
  return unit === 'page' ? t.atPage({ value: String(value) }) : unit === 'percentage' ? t.atPercentage({ value: String(value) })
    : t.atTime({ value: timeText(value) });
}

export function locatorParts(locator: Locator, t: Copy): { now: string; furthest: string } {
  return { now: pointText(locator.unit, locator.current, t), furthest: pointText(locator.unit, locator.furthest, t) };
}

/** Names an edition Main pinned in an attempt, from the Work's own lists when it is in them. */
export function editionName(resource: string, base: Selection['target']['base'] | 'work', editions: Editions | null,
  locale: UiLocale, t: Copy): string {
  if (base === 'work') return t.workInGeneral;
  const realization = editions?.realizations.find(item => item.id === resource);
  if (realization) {
    const language = languageName(realization.language, locale);
    return realization.kind === 'original' ? t.originalText({ language }) : t.translationText({ language });
  }
  const release = editions?.releases.find(item => item.id === resource);
  if (release) return release.platform ? `${release.title.value} · ${release.platform}` : release.title.value;
  return t.unnamedEdition;
}
