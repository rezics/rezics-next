import type { Evidence, HeaderState, LocalizedFacts } from './types.ts';

/** The header facts a person edits, one language at a time. */
export interface Fields { title: string; description: string; tagline: string }
export const noFields: Fields = { title: '', description: '', tagline: '' };

/** A language's current facts as form fields; empty where the Work has none. */
export function fieldsOf(state: HeaderState, language: string): Fields {
  const row = state.localized.find(item => item.language === language);
  return { title: row?.title ?? '', description: row?.description ?? '', tagline: row?.tagline ?? '' };
}

/**
 * Main's header text is one line (no control characters), so a pasted synopsis
 * with line breaks becomes one line; blank means the fact is unset.
 */
const cleaned = (text: string): string | null => {
  const line = text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return line ? line : null;
};

/** Whether the fields differ from what the Work has now, as Main would read them. */
export function changed(state: HeaderState, language: string, fields: Fields): boolean {
  const now = fieldsOf(state, language);
  return (Object.keys(fields) as (keyof Fields)[]).some(key => (cleaned(fields[key]) ?? '') !== now[key]);
}

/**
 * The `component-correction` candidate for a header: the Work's current header
 * with this language's facts replaced. A language left with no fact is dropped
 * (Main keeps only locale rows that record something).
 */
export function headerCandidate(state: HeaderState, language: string, fields: Fields) {
  const existing = state.localized.find(item => item.language === language);
  const row: LocalizedFacts = { language, title: cleaned(fields.title), description: cleaned(fields.description),
    mainVersionLabel: existing?.mainVersionLabel ?? null, tagline: cleaned(fields.tagline) };
  const empty = !row.title && !row.description && !row.mainVersionLabel && !row.tagline;
  const localized = [...state.localized.filter(item => item.language !== language), ...empty ? [] : [row]]
    .sort((a, b) => a.language < b.language ? -1 : a.language > b.language ? 1 : 0);
  return { command: 'work-metadata' as const, state: { ...state, localized } };
}

/** The languages a header has facts in, then the one to start from: the reader's when present. */
export function startLanguage(state: HeaderState, preferred: readonly string[], fallback: string): string {
  const have = state.localized.map(row => row.language);
  const lower = new Map(have.map(tag => [tag.toLowerCase(), tag]));
  for (const tag of preferred) {
    const match = lower.get(tag.toLowerCase()) ?? have.find(item => item.toLowerCase().startsWith(`${tag.toLowerCase().split('-')[0]}`));
    if (match) return match;
  }
  return have[0] ?? fallback;
}

export interface Source { source: string; locator: string }

/**
 * Sources as evidence references: the source itself, the day it was read (an
 * external page has no revision of its own) and where in it the fact is.
 */
export function evidenceOf(sources: readonly Source[], today: string): Evidence[] {
  return sources.filter(item => item.source.trim()).map(item => ({ resource: item.source.trim().slice(0, 512),
    revision: `retrieved:${today}`, locator: item.locator.trim() ? item.locator.trim().slice(0, 4000) : null }));
}

/** A reference shown as a link only when it is a web address. */
export const webHref = (resource: string): string | null => /^https?:\/\/\S+$/.test(resource) ? resource : null;

/** A header from a proposal's candidate or retained prestate (`{ command: 'work-metadata', state }`), else null. */
export function headerOf(value: unknown): HeaderState | null {
  if (typeof value !== 'object' || value === null || !('command' in value) || value.command !== 'work-metadata'
    || !('state' in value)) return null;
  const state = value.state as HeaderState | undefined;
  return state?.kind === 'header' && Array.isArray(state.localized) ? state : null;
}

/**
 * The proposer's edit carried onto the header as it is now: only the fields
 * they changed from the header they wrote against (`before`) replace the
 * current ones, so other languages, other fields and other people's changes
 * stay as they are.
 */
export function rebaseFields(current: HeaderState, before: HeaderState, language: string, fields: Fields): Fields {
  const was = fieldsOf(before, language);
  const now = fieldsOf(current, language);
  const next = { ...now };
  for (const key of Object.keys(fields) as (keyof Fields)[]) {
    if ((cleaned(fields[key]) ?? '') !== was[key]) next[key] = fields[key];
  }
  return next;
}
