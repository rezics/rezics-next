'use client';

import { Checkbox } from '@rezics/ui/checkbox';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Popover, PopoverBody, PopoverContent, PopoverFooter, PopoverHeader, PopoverTrigger } from '@rezics/ui/popover';
import { Progress } from '@rezics/ui/progress';
import { Rating, RatingLabel } from '@rezics/ui/rating';
import { Textarea } from '@rezics/ui/textarea';
import { cn } from '@rezics/ui/utils';
import { BookOpenIcon, CalendarIcon, PencilLineIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { workTitle } from '../catalogue/work-tile.tsx';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import type { ReviewDraft } from './api.ts';
import { formatDayRange, today } from './format.ts';
import { isUseWork } from './labels.ts';
import { useLibrary } from './library-context.tsx';
import type { LibraryMessages } from './messages.ts';
import type { LibraryRow, Review } from './types.ts';

/**
 * Where a Work in progress stands, as StoryGraph shows it: a bar when Main
 * counts the chapters exactly, what comes next, and Continue to the next
 * unread chapter. A Work Continue did not answer for opens its page instead.
 */
export function ReadingProgress({ row, locale, messages, className }: {
  row: LibraryRow; locale: UiLocale; messages: LibraryMessages; className?: string;
}) {
  const t = materializeData(messages, { locale });
  const title = workTitle(row.work, locale);
  const progress = row.progress;
  const chapters = progress?.chapters;
  const left = progress?.left;
  const leftText = left ? left.kind === 'exact' ? t.chaptersLeft(left.value)
    : t.chaptersLeftAtLeast({ count: new Intl.NumberFormat(locale).format(left.value) }) : null;
  const next = progress?.next;
  return <div className={cn('grid gap-2', className)}>
    {chapters ? <div className="grid max-w-sm gap-1">
      <Progress value={Math.round((chapters.read / chapters.total) * 100)} aria-label={t.progressOf({ title })} />
      <p className="text-muted-foreground text-xs tabular-nums">{t.chaptersRead({
        read: new Intl.NumberFormat(locale).format(chapters.read),
        total: new Intl.NumberFormat(locale).format(chapters.total) })}</p>
    </div> : null}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Link href={next?.href ?? row.work.href} className={cn(buttonVariants({ size: 'sm', pill: true,
        variant: next ? 'default' : 'outline' }))}>
        <BookOpenIcon aria-hidden="true" />{next ? t.continue : t.openWork}
        <span className="sr-only"> — {title}</span></Link>
      {next ? <p className="min-w-0 text-muted-foreground text-sm">
        <span className="line-clamp-1">{next.title ? t.nextChapter({ chapter: next.title }) : t.nextUp}
          {leftText ? ` · ${leftText}` : null}</span></p> : null}
    </div>
  </div>;
}

/**
 * Reading dates on Read, as Goodreads keeps "date started" and "date read":
 * shown as a range and edited in place. Main compares and sets on the
 * status version the page read.
 */
export function ReadDates({ row, now, locale, messages }: {
  row: LibraryRow; now: number; locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  const { api, refresh } = useLibrary();
  const title = workTitle(row.work, locale);
  const [basis, setBasis] = useState(row.version);
  const [saved, setSaved] = useState({ startedOn: row.startedOn, finishedOn: row.finishedOn, version: row.version });
  // The page read again after a write elsewhere: show what Main has now.
  if (row.version !== basis) {
    setBasis(row.version);
    setSaved({ startedOn: row.startedOn, finishedOn: row.finishedOn, version: row.version });
  }
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ startedOn: '', finishedOn: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const range = formatDayRange(saved.startedOn, saved.finishedOn, locale);
  const useWork = isUseWork(row);
  const latest = today(now);

  function openEditor(next: boolean) {
    setOpen(next);
    if (next) { setDraft({ startedOn: saved.startedOn ?? '', finishedOn: saved.finishedOn ?? '' }); setError(null); }
  }
  async function save() {
    const dates = { startedOn: draft.startedOn || null, finishedOn: draft.finishedOn || null };
    if (dates.startedOn && dates.finishedOn && dates.startedOn > dates.finishedOn) { setError(t.datesOrder); return; }
    setSaving(true);
    const written = await api.setDates(row.work.id, saved.version, dates);
    setSaving(false);
    if (!written.ok) { setError(written.failure === 'moved' ? t.datesMoved : t.datesFailed); return; }
    setSaved({ ...dates, version: written.data.version });
    setOpen(false);
    refresh();
  }

  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <CalendarIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    {range ? <span>{useWork ? t.usedDates({ range }) : t.readDates({ range })}</span> : null}
    <Popover open={open} onOpenChange={details => openEditor(details.open)}>
      <PopoverTrigger className={cn(buttonVariants({ variant: range ? 'ghost' : 'outline', size: 'sm', pill: true }),
        range && '-ms-1.5 text-muted-foreground')}>
        {range ? t.editDates : t.addDates}<span className="sr-only"> — {title}</span></PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)]">
        <form noValidate onSubmit={event => { event.preventDefault(); void save(); }} className="contents">
          <PopoverHeader title={useWork ? t.useDatesFor({ title }) : t.datesFor({ title })} />
          <PopoverBody className="grid gap-4">
            <Field>
              <FieldLabel>{useWork ? t.startedUsing : t.started}</FieldLabel>
              <Input type="date" value={draft.startedOn} max={draft.finishedOn || latest}
                onChange={event => { setDraft({ ...draft, startedOn: event.currentTarget.value }); setError(null); }} />
            </Field>
            <Field invalid={error !== null}>
              <FieldLabel>{useWork ? t.finishedUsing : t.finished}</FieldLabel>
              <Input type="date" value={draft.finishedOn} min={draft.startedOn || undefined} max={latest}
                onChange={event => { setDraft({ ...draft, finishedOn: event.currentTarget.value }); setError(null); }} />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
          </PopoverBody>
          <PopoverFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>{t.cancel}</Button>
            <Button type="submit" size="sm" isLoading={saving}>{t.save}</Button>
          </PopoverFooter>
        </form>
      </PopoverContent>
    </Popover>
  </div>;
}

/** The reader's own stars, set in place. The chosen value shows at once and goes back with a note if Main refuses. */
export function OwnRating({ row, locale, messages }: { row: LibraryRow; locale: UiLocale; messages: LibraryMessages }) {
  const t = materializeData(messages, { locale });
  const { reader } = useLibrary();
  const [pending, setPending] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  if (!reader.rate) return null;
  const rate = reader.rate;
  const value = pending ?? row.rating ?? 0;
  async function save(next: number) {
    setPending(next);
    setFailed(false);
    const saved = await rate(row.work.id, next).catch(() => false);
    if (!saved) { setPending(null); setFailed(true); }
  }
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <Rating size="sm" count={5} value={value} onValueChange={({ value: next }) => void save(next)}
      className="flex-row items-center gap-2">
      <RatingLabel className="order-last font-normal text-muted-foreground text-xs">
        {t.yourRating}<span className="sr-only"> — {workTitle(row.work, locale)}</span></RatingLabel>
    </Rating>
    {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.ratingFailed}</p> : null}
  </div>;
}

// CJK prose reads at a taller line height (frontend principles).
const prose = (language: string | undefined) => /^(?:zh|ja|ko)(?:-|$)/.test(language ?? '')
  ? 'leading-[1.8]' : 'leading-relaxed';

/**
 * The reader's review of a Read Work: shown under the row and written or
 * edited in place. A review goes with the reader's rating in the same
 * question, so it asks for stars first.
 */
export function ReviewCell({ row, locale, messages }: { row: LibraryRow; locale: UiLocale; messages: LibraryMessages }) {
  const t = materializeData(messages, { locale });
  const { actingSubject, api, ratingContext, refresh } = useLibrary();
  const reading = useReadingLanguages(actingSubject);
  const title = workTitle(row.work, locale);
  const known = row.review?.ok ? row.review.data : null;
  const [review, setReview] = useState<Pick<Review, 'id' | 'revision' | 'text' | 'spoiler' | 'language'> | null>(known);
  const [basis, setBasis] = useState(known?.revision ?? null);
  if ((known?.revision ?? null) !== basis) { setBasis(known?.revision ?? null); setReview(known); }
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Omit<ReviewDraft, 'language'> & { language: string | null }>({ text: '', spoiler: false, language: null });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'save' | 'delete' | null>(null);
  if (!ratingContext || row.review === undefined) return null;
  if (!row.review.ok) return <p className="text-muted-foreground text-sm">{t.reviewUnavailable}</p>;
  const context = ratingContext;

  function edit() {
    setDraft({ text: review?.text ?? '', spoiler: review?.spoiler ?? false, language: review?.language ?? null });
    setError(null);
    setEditing(true);
  }
  async function save() {
    const text = draft.text.trim();
    if (!text) return;
    setSaving('save');
    const language = writingLanguage({ chosen: draft.language, reading });
    const written = await api.saveReview(row.work.id, context, { ...draft, language, text }, review?.revision ?? null);
    setSaving(null);
    if (!written.ok) { setError(written.failure === 'moved' ? t.reviewMoved : t.reviewFailed); return; }
    setReview({ id: written.data.review, revision: written.data.revision, text, spoiler: draft.spoiler, language });
    setEditing(false);
    refresh();
  }
  async function remove() {
    if (!review) return;
    setSaving('delete');
    const written = await api.deleteReview(review.id, review.revision);
    setSaving(null);
    if (!written.ok) { setError(written.failure === 'moved' ? t.reviewMoved : t.reviewFailed); return; }
    setReview(null);
    setEditing(false);
    refresh();
  }

  if (editing) {
    // Only a Work Main says is unrated asks for stars first; when Main could not say, Main decides on save.
    const unrated = row.stateRead === true && row.rating === null;
    const language = writingLanguage({ chosen: draft.language, reading });
    const written = textAttributes(language, draft.text);
    return <form noValidate onSubmit={event => { event.preventDefault(); void save(); }}
      className="grid max-w-2xl gap-3 rounded-2xl bg-muted/50 p-4">
      <Field invalid={error !== null}>
        <FieldLabel>{t.reviewOf({ title })}</FieldLabel>
        <Textarea value={draft.text} rows={4} maxLength={8000} lang={written.lang} dir={written.dir}
          placeholder={t.reviewPlaceholder} className={prose(language)}
          onChange={event => { setDraft({ ...draft, text: event.currentTarget.value }); setError(null); }}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
          }} />
        {error ? <FieldError>{error}</FieldError> : unrated ? <FieldHelper>{t.reviewNeedsRating}</FieldHelper> : null}
      </Field>
      <LanguageSelect value={language} onChange={chosen => setDraft({ ...draft, language: chosen })} locale={locale}
        reading={reading} className="w-fit" />
      <Checkbox className="flex w-fit cursor-pointer items-center gap-2 text-sm" checked={draft.spoiler} onCheckedChange={event => setDraft({ ...draft, spoiler: event.checked === true })}>
        {t.spoiler}</Checkbox>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" isLoading={saving === 'save'} disabled={unrated || !draft.text.trim()}>
          {t.saveReview}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>{t.cancel}</Button>
        {review ? <Button type="button" size="sm" variant="ghost" className="ms-auto text-destructive-foreground"
          isLoading={saving === 'delete'} onClick={() => void remove()}>{t.deleteReview}</Button> : null}
      </div>
    </form>;
  }
  if (!review) {
    return <Button variant="outline" size="sm" pill className="w-fit" onClick={edit}>
      <PencilLineIcon aria-hidden="true" />{t.writeReview}<span className="sr-only"> — {title}</span></Button>;
  }
  return <figure className="grid max-w-2xl gap-1.5 border-border border-s-2 ps-4">
    <figcaption className="flex items-center gap-2 font-medium text-muted-foreground text-xs">
      {t.reviewText}
      {review.spoiler ? <span className="rounded-full bg-muted px-2 py-0.5 text-foreground">{t.spoilerMark}</span> : null}
      <Button variant="ghost" size="xs" className="ms-auto" onClick={edit}>
        <PencilLineIcon aria-hidden="true" />{t.editReview}<span className="sr-only"> — {t.reviewOf({ title })}</span>
      </Button>
    </figcaption>
    <blockquote lang={review.language} dir={textAttributes(review.language, review.text ?? '').dir}
      className={cn('line-clamp-4 whitespace-pre-line text-pretty text-sm', prose(review.language))}>{review.text ?? ''}</blockquote>
  </figure>;
}

export function PrivateReviewCell({ row, locale, messages }: { row: LibraryRow;
  locale: UiLocale; messages: LibraryMessages }) {
  const privateReview = row.privateReview;
  if (!privateReview?.ok || !privateReview.data) return null;
  const t = materializeData(messages, { locale });
  return <figure className="grid max-w-2xl gap-1.5 border-border border-s-2 ps-4">
    <figcaption className="font-medium text-muted-foreground text-xs">
      {t.privateImportedReview} · {t.privateImportedReviewHelp}</figcaption>
    <blockquote lang={privateReview.data.language} className="line-clamp-4 whitespace-pre-line text-pretty text-sm">
      {privateReview.data.text}</blockquote>
  </figure>;
}
