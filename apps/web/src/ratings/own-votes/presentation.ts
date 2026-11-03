import type { OwnVoteEntry } from './types';
import { m } from '../../paraglide/messages.js';

export function ownVoteValue(entry: OwnVoteEntry, locale: string): string {
  return `${new Intl.NumberFormat(locale).format(entry.own.units)} / ${new Intl.NumberFormat(locale).format(entry.question.scale.max)}`;
}

export function ownVoteScale(entry: OwnVoteEntry, locale: string): string {
  const number = new Intl.NumberFormat(locale);
  return `${number.format(entry.question.scale.min)}–${number.format(entry.question.scale.max)} · ${number.format(entry.question.scale.displayStep)}`;
}

export function ownVoteChangedAt(entry: OwnVoteEntry, locale: string): string | null {
  const time = Date.parse(entry.own.at);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time);
}

export function ownVoteSubjectLabel(entry: OwnVoteEntry, locale: string): string {
  return entry.subject.label?.value || m.subject_value_unlabelled({}, { locale: locale as never });
}
