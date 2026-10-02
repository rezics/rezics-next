'use client';

import { authorHref } from '../author/route.ts';
import { Checkbox } from '@rezics/ui/checkbox';

import { Button, buttonVariants } from '@rezics/ui/button';
import { ChoiceSelect } from '@rezics/ui/select';
import { Textarea } from '@rezics/ui/textarea';
import { cn } from '@rezics/ui/utils';
import { EyeIcon, MessageSquareTextIcon, PencilIcon, ThumbsUpIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { StarMeter } from '../catalogue/rating.tsx';
import { RateWork, useReaderActions } from '../catalogue/reader-actions.tsx';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import Link from '../shell/localized-link.tsx';
import { Expandable } from './expandable.tsx';
import { formatDate, isoTime, languageName, paragraphs } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { AggregateScope, GrainChooser, type GrainRead, readGrain } from './reviews-grain.tsx';
import type { ReviewAggregate, ReviewScopeQuery, ReviewTarget } from './reviews-grain-model.tsx';
import { type ReviewApi, type ReviewFilter, type ReviewWrite, mainReviewApi } from './reviews-api.ts';
import type { Loaded, ReadFailure, Review, Reviewer, ReviewPage } from './types.ts';

type Translation = ReturnType<typeof materializeData<WorkPageMessages>>;

export const REVIEWS_REGION = 'work-reviews';

/** Who is reading, as far as reviews care: signed out, signed in without an identity to act as, or a reader. */
export type ReviewViewer =
  | { kind: 'signed-out'; signInHref: string }
  | { kind: 'no-identity' }
  /** `canWrite` when this list's rating Context is the one the page's stars rate. */
  | { kind: 'reader'; actingSubject: string; canWrite: boolean }
  /** A target whose rating question is not open to readers yet (a release before G-652): the reviews read, nothing writes. */
  | { kind: 'read-only' };

export interface ReviewsProps {
  /** The resource IRI the reviews are of, and the rating Context (question) they answer, with its scale. */
  target: string; context: string; scale: number;
  /** The projection's link to the reviews; the target's own `/reviews` read when left out. */
  href?: string;
  /** What was reviewed ("Reviews of this release"); the heading alone when left out. */
  subject?: string;
  /** The server's first page, most helpful first, and the names of its reviewers. */
  initial: Loaded<ReviewPage>;
  reviewers: Record<string, Reviewer>;
  viewer: ReviewViewer;
  /** Stories supply their own; pages read and write Main through the BFF. */
  api?: ReviewApi;
  locale: UiLocale; messages: WorkPageMessages;
  /** The aggregate of `context` with the scope Main states for it (question, grain, population). */
  aggregate?: ReviewAggregate | null;
  /** What else the Work's reviews can be of (editions, translations, related Works); the chooser appears with more than one. */
  targets?: readonly ReviewTarget[];
  /** The rating scope the page is in, which the chosen target's question is read in. */
  scopeQuery?: ReviewScopeQuery;
  /** Stories supply their own; pages read the chosen target from Main through the BFF. */
  grainReader?: typeof readGrain;
}

const reviewAnchor = /^#review-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The review a `#review-{id}` link names, as the home feed links a review card to its Work. */
export function linkedReview(hash: string): string | null {
  return reviewAnchor.exec(hash)?.[1] ?? null;
}

function failureText(failure: ReadFailure, t: Translation) {
  return failure === 'moved' ? t.moved : failure === 'budget' ? t.budget : t.regionUnavailable;
}

/** One review, Goodreads-style: who, their stars and when, the text (spoilers behind a gate) and "Helpful". */
function ReviewCard({ review, reviewer, own, highlighted, viewer, api, scale, onChange, onEdit, locale, t }: {
  review: Review; reviewer: Reviewer | undefined; own: boolean; highlighted: boolean; viewer: ReviewViewer;
  api: ReviewApi; scale: number; onChange: (review: Review) => void; onEdit?: () => void; locale: UiLocale;
  t: Translation;
}) {
  const [revealing, setRevealing] = useState(false);
  const [voting, setVoting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const created = new Date(review.createdAt);
  // Main stamps a new review's two times a moment apart; only a later change is an edit.
  const edited = new Date(review.updatedAt).getTime() - created.getTime() > 60_000;
  async function reveal() {
    setRevealing(true);
    const full = await api.one(review.id);
    setRevealing(false);
    if (full?.text) onChange({ ...review, text: full.text, spoilerWithheld: false });
    else setFailed(t.spoilerFailed);
  }
  async function vote() {
    const next = !review.viewerHelpful;
    setVoting(true);
    setFailed(null);
    // Shown at once; put back with a note when Main refuses.
    onChange({ ...review, viewerHelpful: next, helpfulCount: review.helpfulCount + (next ? 1 : -1) });
    const saved = await api.helpful(review.id, next, review.viewerVoteRevision);
    setVoting(false);
    if (saved) onChange({ ...review, viewerHelpful: saved.helpful, helpfulCount: saved.helpfulCount,
      viewerVoteRevision: saved.revision });
    else { onChange(review); setFailed(t.helpfulFailed); }
  }
  const helpfulCount = review.helpfulCount ? t.helpfulCount(review.helpfulCount) : null;
  return <article id={`review-${review.id}`} aria-labelledby={`review-${review.id}-by`}
    className={cn('grid scroll-mt-24 gap-3 rounded-2xl p-4 transition-colors sm:p-5',
      own ? 'bg-primary/5 ring-1 ring-primary/20' : 'bg-card/60 ring-1 ring-border/60',
      highlighted && 'ring-2 ring-primary')}>
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p id={`review-${review.id}-by`} className="font-semibold">
        {own ? t.yourReview : reviewer
          ? <Link href={authorHref({ kind: 'agent', handle: reviewer.handle })} className="rounded-sm outline-none underline-offset-4 hover:underline
            focus-visible:ring-2 focus-visible:ring-ring">{reviewer.name}</Link> : t.reviewerFallback}</p>
      {review.rating === null ? null : <span className="flex items-center gap-1.5 text-sm">
        <span className="sr-only">{t.ratedValue({ value: String(review.rating), max: String(scale) })}</span>
        {scale === 5 ? <StarMeter mean={review.rating} max={5} className="text-[0.95rem]" />
          : <span aria-hidden="true" className="font-semibold tabular-nums">{review.rating}/{scale}</span>}
      </span>}
      <time dateTime={isoTime(review.createdAt)} className="text-muted-foreground text-sm">{formatDate(created, locale)}
        {edited ? ` · ${t.edited}` : ''}</time>
      {review.language.split('-')[0] !== locale.split('-')[0]
        ? <span className="text-muted-foreground text-xs">{languageName(review.language, locale)}</span> : null}
    </header>
    {review.spoilerWithheld || review.text === null
      ? <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/70 px-4 py-3 text-sm">
        <EyeIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="flex-1">{t.spoilerWithheld}</span>
        <Button size="sm" variant="outline" isLoading={revealing} onClick={() => void reveal()}>{t.showSpoilers}</Button>
      </div>
      : <Expandable more={t.showMore} less={t.showLess}>
        <div lang={review.language} dir={textAttributes(review.language, review.text).dir}
          className="grid gap-3 text-pretty break-words text-base/7">
          {review.spoiler ? <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {t.spoilerLabel}</p> : null}
          {paragraphs(review.text).map((line, index) => <p key={index}>{line}</p>)}
        </div>
      </Expandable>}
    <footer className="flex flex-wrap items-center gap-3 text-sm">
      {own ? onEdit ? <Button size="sm" variant="outline" onClick={onEdit}><PencilIcon aria-hidden="true" />
        {t.editReview}</Button> : null
        : viewer.kind === 'reader' ? <Button size="sm" variant={review.viewerHelpful ? 'soft' : 'ghost'}
          aria-pressed={review.viewerHelpful} disabled={voting} onClick={() => void vote()}>
          <ThumbsUpIcon aria-hidden="true" />{t.helpful}</Button>
          : viewer.kind === 'signed-out' ? <Link href={viewer.signInHref}
            className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
            <ThumbsUpIcon aria-hidden="true" />{t.helpful}<span className="sr-only"> — {t.helpfulSignIn}</span></Link>
            : null}
      {helpfulCount ? <span className="text-muted-foreground">{helpfulCount}</span> : null}
      {failed ? <span role="status" className="text-destructive-foreground text-xs">{failed}</span> : null}
    </footer>
  </article>;
}

/**
 * Writing or editing the reader's own review: their stars (a review stands
 * on a rating, which Main proves), the text, its language and whether it
 * gives the story away. Deleting keeps the rating.
 */
function ReviewEditor({ target, own, actingSubject, api, onSaved, onCancel, locale, t }: {
  target: string; own: Review | null; actingSubject: string; api: ReviewApi; onSaved: () => void; onCancel: () => void; locale: UiLocale;
  t: Translation;
}) {
  const id = useId();
  const actions = useReaderActions();
  const rated = actions.kind === 'ready' ? actions.stateOf(target).rating !== null : false;
  const [text, setText] = useState(own?.text ?? '');
  // The writer's choice; until then the review's own language, their first reading language, or none.
  const [chosen, setChosen] = useState<string | null>(null);
  const reading = useReadingLanguages(actingSubject);
  const language = writingLanguage({ chosen, existing: own?.language, reading });
  const written = textAttributes(language, text);
  const [spoiler, setSpoiler] = useState(own?.spoiler ?? false);
  const [state, setState] = useState<'idle' | 'saving' | 'confirm-delete' | ReviewWrite>('idle');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setState('saving');
    const result = await api.write({ expectedRevision: own?.revision ?? null, language, text: text.trim(), spoiler });
    if (result === 'saved') onSaved();
    else setState(result);
  }
  async function remove() {
    if (!own) return;
    setState('saving');
    if (await api.remove(own.id, own.revision)) onSaved();
    else setState('failed');
  }
  const note = state === 'rate-first' ? t.rateFirst : state === 'conflict' ? t.reviewConflict
    : state === 'denied' ? t.reviewDenied : state === 'failed' ? t.reviewFailed : null;
  return <form onSubmit={event => void submit(event)} aria-labelledby={`${id}-title`}
    className="grid gap-4 rounded-2xl bg-card/60 p-4 ring-1 ring-border/60 sm:p-5">
    <h3 id={`${id}-title`} className="font-semibold">{own ? t.editReview : t.writeReview}</h3>
    <RateWork work={target} locale={locale} className="justify-items-start" />
    <label htmlFor={`${id}-text`} className="sr-only">{t.reviewText}</label>
    <Textarea id={`${id}-text`} value={text} onChange={event => setText(event.target.value)} required maxLength={8000}
      placeholder={t.reviewPlaceholder} lang={written.lang} dir={written.dir}
      className="min-h-36 text-base" />
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
      <div className="flex items-center gap-2">
        <span>{t.reviewLanguage}</span>
        <LanguageSelect value={language} onChange={setChosen} locale={locale} reading={reading}
          label={t.reviewLanguage} className="w-48" />
      </div>
      <Checkbox className="flex items-center gap-2" checked={spoiler} onCheckedChange={event => setSpoiler(event.checked === true)}>

        {t.containsSpoilers}
      </Checkbox>
    </div>
    {!rated ? <p className="text-muted-foreground text-sm">{t.rateFirst}</p> : null}
    {note ? <p role="alert" className="flex items-center gap-2 text-destructive-foreground text-sm">
      <TriangleAlertIcon aria-hidden="true" className="size-4" />{note}</p> : null}
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" isLoading={state === 'saving'} disabled={!rated || !text.trim() || state === 'saving'}>
        {own ? t.saveReview : t.postReview}</Button>
      <Button type="button" variant="ghost" onClick={onCancel}>{t.cancel}</Button>
      {own ? state === 'confirm-delete'
        ? <span className="ms-auto flex items-center gap-2 text-sm">{t.deleteConfirm}
          <Button type="button" size="sm" variant="destructive" onClick={() => void remove()}>{t.deleteReview}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setState('idle')}>{t.cancel}</Button></span>
        : <Button type="button" variant="ghost" className="ms-auto text-destructive-foreground"
          onClick={() => setState('confirm-delete')}>{t.deleteReview}</Button> : null}
    </div>
  </form>;
}

/**
 * Reader reviews on the Work page, as Goodreads' "Community Reviews": most
 * helpful or newest first, filtered by language and stars, spoilers behind a
 * gate, "Helpful" votes, and the reader's own review first with Edit. A
 * `#review-{id}` link (the home feed's review cards) scrolls to that review,
 * reading it on its own when it is not on the first page.
 */
function ReviewsPanel({ target, href, subject, context, scale, initial, reviewers: named, viewer, api: given, locale,
  messages, aggregate, controls }: ReviewsProps & { controls?: ReactNode }) {
  const t = materializeData(messages, { locale });
  const api = useMemo(() => given ?? mainReviewApi({ target, href, context,
    actingSubject: viewer.kind === 'reader' ? viewer.actingSubject : null }), [given, target, href, context, viewer]);
  const [filter, setFilter] = useState<ReviewFilter>({ sort: 'helpful' });
  const [page, setPage] = useState(initial);
  const [items, setItems] = useState<Review[]>(initial.ok ? initial.data.items : []);
  const [reviewers, setReviewers] = useState(named);
  const [loading, setLoading] = useState<'first' | 'more' | null>(null);
  const [editing, setEditing] = useState(false);
  const [linked, setLinked] = useState<Review | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const first = useRef(true);
  const own = viewer.kind === 'reader' ? items.find(item => item.author === viewer.actingSubject) ?? null : null;

  async function name(reviews: readonly Review[]) {
    const unknown = reviews.map(review => review.author).filter(author => !(author in reviewers));
    if (unknown.length) {
      const found = await api.reviewers(unknown);
      setReviewers(current => ({ ...current, ...found }));
    }
  }
  async function load(next: ReviewFilter) {
    setLoading('first');
    const read = await api.page(next);
    setPage(read);
    if (read.ok) {
      setItems(read.data.items);
      await name(read.data.items);
    }
    setLoading(null);
  }
  async function more() {
    if (!page.ok || !page.data.nextCursor) return;
    setLoading('more');
    const read = await api.page(filter, page.data.nextCursor);
    setPage(read.ok ? read : page);
    if (read.ok) {
      // A review can move between pages while votes change; keep one copy.
      setItems(current => [...current, ...read.data.items.filter(item => !current.some(seen => seen.id === item.id))]);
      await name(read.data.items);
    }
    setLoading(null);
  }
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void load(filter);
    // Reload only when the reader changes the filter.
  }, [filter]);

  // A page the browser read for another target arrives without its reviewers' names.
  useEffect(() => {
    if (initial.ok) void name(initial.data.items);
    // Only on arrival.
  }, []);

  // A followed `#review-{id}` link: scroll to the review, reading it on its own when it is not listed.
  useEffect(() => {
    const id = linkedReview(window.location.hash);
    if (!id) return;
    setHighlight(id);
    if (document.getElementById(`review-${id}`)) return;
    void api.one(id).then(async review => {
      if (!review) return;
      setLinked(review);
      await name([review]);
    });
    // Only on arrival.
  }, []);
  useEffect(() => {
    if (highlight) document.getElementById(`review-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [highlight, linked]);

  const update = (review: Review) => {
    setItems(current => current.map(item => item.id === review.id ? review : item));
    setLinked(current => current?.id === review.id ? review : current);
  };
  const filtered = Boolean(filter.language || filter.rating);
  const listed = linked && !items.some(item => item.id === linked.id) ? [linked, ...items] : items;
  const ratings = Array.from({ length: scale }, (_, index) => scale - index);
  const reviewLanguages = [...new Set([locale, ...items.map(item => item.language),
    ...(filter.language ? [filter.language] : [])])];

  return <section aria-labelledby={REVIEWS_REGION} aria-busy={loading === 'first' || undefined}
    className="grid min-w-0 content-start gap-5">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="grid gap-1">
        <h2 id={REVIEWS_REGION} className="font-semibold text-xl tracking-tight">{t.reviews}</h2>
        {subject ? <p className="text-muted-foreground text-sm">{subject}</p> : null}
      </div>
      {viewer.kind === 'reader' && viewer.canWrite && !own && !editing
        ? <Button pill onClick={() => setEditing(true)}><PencilIcon aria-hidden="true" />{t.writeReview}</Button>
        : viewer.kind === 'signed-out' ? <Link href={viewer.signInHref} className={buttonVariants({ pill: true,
          variant: 'outline' })}><PencilIcon aria-hidden="true" />{t.writeReview}
          <span className="sr-only"> — {t.signInToReview}</span></Link> : null}
    </div>
    {controls}
    <AggregateScope aggregate={aggregate ?? null} locale={locale} t={t} />
    {editing ? <ReviewEditor target={target} own={own} actingSubject={viewer.kind === 'reader' ? viewer.actingSubject : ''} api={api} locale={locale} t={t} onCancel={() => setEditing(false)}
      onSaved={() => { setEditing(false); void load(filter); }} /> : null}
    {/* Sorting and filtering help once there is something to sort. */}
    {listed.length || filtered || filter.sort !== 'helpful' ? <div className="flex flex-wrap items-center gap-x-4 gap-y-2
      text-sm">
      <div role="group" aria-label={t.sortReviews} className="flex gap-1 rounded-full border border-border/70 p-1">
        {(['helpful', 'new'] as const).map(sort => <button key={sort} type="button" aria-pressed={filter.sort === sort}
          onClick={() => setFilter(current => ({ ...current, sort }))}
          className="h-8 rounded-full px-3.5 font-medium text-muted-foreground outline-none transition-colors
            hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-foreground
            aria-pressed:text-background">{sort === 'helpful' ? t.sortHelpful : t.sortNew}</button>)}
      </div>
      <ChoiceSelect size="sm" value={filter.language ?? ''} className="w-44" label={t.reviewLanguage}
        onValueChange={language => setFilter(current => ({ ...current, language: language || undefined }))}
        options={[{ value: '', label: t.anyReviewLanguage }, ...reviewLanguages.map(tag =>
          ({ value: tag, label: languageName(tag, locale) }))]} />
      <ChoiceSelect size="sm" value={filter.rating ? String(filter.rating) : ''} className="w-36" label={t.ratingFilter}
        onValueChange={rating => setFilter(current => ({ ...current,
          rating: rating ? Number(rating) : undefined }))}
        options={[{ value: '', label: t.anyRating }, ...ratings.map(value =>
          ({ value: String(value), label: t.stars(value) }))]} />
    </div> : null}
    {!page.ok ? <p role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
      <TriangleAlertIcon aria-hidden="true" className="size-4 text-destructive-foreground" />
      <span className="flex-1">{t.reviewsUnavailable}. {failureText(page.failure, t)}</span>
      <Button size="sm" variant="outline" onClick={() => void load(filter)}>{t.retry}</Button>
    </p> : listed.length ? <ol className="grid gap-4">
      {listed.map(review => <li key={review.id}>
        <ReviewCard review={review} reviewer={reviewers[review.author]} own={review.id === own?.id}
          highlighted={review.id === highlight} viewer={viewer} api={api} scale={scale} onChange={update}
          onEdit={review.id === own?.id && viewer.kind === 'reader' && viewer.canWrite && !editing
            ? () => setEditing(true) : undefined} locale={locale} t={t} />
      </li>)}
    </ol> : <div className="grid justify-items-start gap-1 rounded-2xl bg-muted/60 px-5 py-4">
      <p className="flex items-center gap-2 font-medium"><MessageSquareTextIcon aria-hidden="true"
        className="size-4 text-muted-foreground" />{filtered ? t.noMatchingReviews : t.noReviews}</p>
      {filtered ? <Button size="sm" variant="link" className="px-0"
        onClick={() => setFilter(current => ({ sort: current.sort }))}>{t.clearFilters}</Button>
        : <p className="text-muted-foreground text-sm">{t.noReviewsBody}</p>}
    </div>}
    {page.ok && page.data.nextCursor ? <div className="flex justify-center">
      <Button variant="outline" pill isLoading={loading === 'more'} onClick={() => void more()}>
        {t.moreReviews}</Button></div> : null}
    <p aria-live="polite" className="sr-only">{loading ? t.loadingReviews
      : page.ok ? t.reviewsShown(listed.length) : ''}</p>
  </section>;
}

/** The reviews section's heading alone, for the moments a chosen target has no list to show yet. */
function ReviewsHeading({ t, subject }: { t: Translation; subject?: string }) {
  return <div className="grid gap-1">
    <h2 id={REVIEWS_REGION} className="font-semibold text-xl tracking-tight">{t.reviews}</h2>
    {subject ? <p className="text-muted-foreground text-sm">{subject}</p> : null}
  </div>;
}

/**
 * The Work's reviews, filterable by what they are of. The page's own target (the story) renders from the server's
 * first page; choosing an edition, a translation or a related Work reads that target's rating question, aggregate
 * and reviews in the browser, in the page's scope, and shows its aggregate scope beside them: one resource's
 * reviews never stand in for another's. Writing stays with the story, whose stars the page rates.
 */
export function ReviewsSection(props: ReviewsProps) {
  const { targets, scopeQuery, viewer, locale, messages, aggregate } = props;
  const t = materializeData(messages, { locale });
  const [chosen, setChosen] = useState<{ option: ReviewTarget; read: GrainRead | null } | null>(null);
  const latest = useRef<string | null>(null);
  const actingSubject = viewer.kind === 'reader' ? viewer.actingSubject : null;

  async function choose(option: ReviewTarget) {
    latest.current = option.target;
    if (option.target === props.target) { setChosen(null); return; }
    setChosen({ option, read: null });
    const read = await (props.grainReader ?? readGrain)(option.target, scopeQuery ?? { scope: 'global' }, actingSubject);
    // A later choice wins; an answer for an earlier one is dropped.
    if (latest.current === option.target) setChosen({ option, read });
  }
  const selected = chosen?.option.target ?? props.target;
  const chooser = targets && targets.length > 1
    ? <GrainChooser targets={targets} selected={selected} onSelect={option => void choose(option)} t={t} /> : null;

  if (!chosen) return <ReviewsPanel {...props} aggregate={aggregate} controls={chooser} />;
  const { option, read } = chosen;
  const subject = t.reviewsOf({ target: option.label });
  if (read?.kind === 'ready') {
    // Another target's reviews are read, not written: its stars are not the ones this page rates.
    const readOnly: ReviewViewer = viewer.kind === 'reader' ? { kind: 'reader', actingSubject: viewer.actingSubject, canWrite: false }
      : { kind: 'read-only' };
    return <ReviewsPanel key={option.target} target={option.target} context={read.context} scale={read.scale}
      initial={read.reviews} reviewers={{}} viewer={readOnly} locale={locale} messages={messages} subject={subject}
      aggregate={read.aggregate} controls={chooser} />;
  }
  return <section aria-labelledby={REVIEWS_REGION} aria-busy={read === null || undefined} className="grid min-w-0 content-start gap-5">
    <ReviewsHeading t={t} subject={subject} />
    {chooser}
    {read === null ? <p aria-live="polite" className="text-muted-foreground text-sm">{t.loadingReviews}</p>
      : read.kind === 'no-question' ? <p data-review-no-question className="rounded-2xl bg-muted/60 px-5 py-4 text-sm">
        {t.reviewsNoQuestion}</p>
        : <p role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
          <TriangleAlertIcon aria-hidden="true" className="size-4 text-destructive-foreground" />
          <span className="flex-1">{t.reviewsUnavailable}. {failureText(read.failure, t)}</span>
          <Button size="sm" variant="outline" onClick={() => void choose(option)}>{t.retry}</Button></p>}
  </section>;
}
