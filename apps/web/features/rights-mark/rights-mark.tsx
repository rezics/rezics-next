import { Fragment, type ReactNode } from 'react';
import type { MediaImageMetadata } from '@rezics/ui/media-image';
import { cn } from '@rezics/ui/utils';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkHeader } from '../work-page/types.ts';
import { messages, type RightsMarkCopy } from './messages.ts';

/** What a description or fact read reports. `unassessed` is also the hidden shape. */
export type DisplayObligations = WorkHeader['descriptionObligations'];
type Assessed = Extract<DisplayObligations, { status: 'assessed' }>;
type Obligation = Assessed['obligations'][number];

const linkClass = `rounded-sm text-primary underline decoration-primary/40 underline-offset-2 outline-none
  hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring`;

// Public names of Creative Commons deeds. The instrument is a URL; this only
// reads that URL. It does not name a content source.
const ccNames: Record<string, string> = {
  by: 'CC BY',
  'by-sa': 'CC BY-SA',
  'by-nc': 'CC BY-NC',
  'by-nc-sa': 'CC BY-NC-SA',
  'by-nd': 'CC BY-ND',
  'by-nc-nd': 'CC BY-NC-ND',
};

const noteKinds = ['share_alike', 'notice_retention', 'change_indication', 'non_commercial', 'no_derivatives'] as const;
const noteKey = {
  share_alike: 'shareAlike',
  notice_retention: 'noticeRetention',
  change_indication: 'changeIndication',
  non_commercial: 'nonCommercial',
  no_derivatives: 'noDerivatives',
} as const satisfies Record<typeof noteKinds[number], keyof RightsMarkCopy>;

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** The licence name a reader sees. A Creative Commons deed uses its public name; any other instrument stays the URL. */
export function licenceLabel(instrument: string): string {
  const url = httpUrl(instrument);
  if (!url) return instrument;
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'opendatacommons.org' && url.pathname === '/licenses/odbl/1-0/') return 'ODbL 1.0';
  if (host === 'opendatacommons.org' && url.pathname === '/licenses/dbcl/1-0/') return 'DbCL 1.0';
  if (host !== 'creativecommons.org') return instrument;
  const parts = url.pathname.split('/').filter(Boolean);
  const code = parts[1];
  const version = parts[2];
  if (parts[0] === 'licenses' && code && version && ccNames[code]) return `${ccNames[code]} ${version}`;
  if (parts[0] === 'publicdomain' && code === 'zero' && version) return `CC0 ${version}`;
  return instrument;
}

const urlPattern = /https?:\/\/[^\s<>"']+/g;

/**
 * The credit a reader sees. The notice's words are the name; a notice that is
 * only an address uses that address's host. The name links to the source, and
 * the full address is never the visible text.
 */
function sourceCredit(notice: string): { name: string; href: string | null } {
  let href: string | null = null;
  const words = notice.replace(urlPattern, raw => {
    const trimmed = raw.replace(/[),.;:!?]+$/u, '');
    const url = httpUrl(trimmed);
    if (url && !href) href = url.href;
    return ' ';
  });
  const name = words.replace(/\s+/g, ' ').replace(/^[\s,;:.·-]+|[\s,;:.·-]+$/g, '').trim();
  if (name) return { name, href };
  if (!href) return { name: notice.trim(), href: null };
  return { name: new URL(href).hostname.replace(/^www\./, ''), href };
}

function SourceCredit({ notice, label, linkedSourceHref }: { notice: string; label: string; linkedSourceHref?: string }) {
  const credit = sourceCredit(notice);
  const name = credit.href && credit.href !== linkedSourceHref
    ? <a href={credit.href} rel="noreferrer noopener" className={linkClass}>{credit.name}</a>
    : credit.name;
  return <span>{label}{name}</span>;
}

/** A recorded notice that is not the credit, with each http(s) address linked. */
function NoticeText({ notice }: { notice: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of notice.matchAll(urlPattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const trimmed = raw.replace(/[),.;:!?]+$/u, '');
    const url = httpUrl(trimmed);
    if (index > last) nodes.push(notice.slice(last, index));
    if (url) {
      nodes.push(<a key={`${index}-link`} href={url.href} rel="noreferrer noopener" className={linkClass}>{trimmed}</a>);
      const tail = raw.slice(trimmed.length);
      if (tail) nodes.push(tail);
    } else nodes.push(raw);
    last = index + raw.length;
  }
  if (last < notice.length) nodes.push(notice.slice(last));
  return <>{nodes}</>;
}

function LicenceLink({ instrument, copy }: { instrument: string; copy: RightsMarkCopy }) {
  const url = httpUrl(instrument);
  const label = instrument === 'https://www.gutenberg.org/policy/license.html'
    ? copy.publicDomain : licenceLabel(instrument);
  return url
    ? <a href={url.href} rel="noreferrer noopener" className={linkClass}>{label}</a>
    : <span>{label}</span>;
}

/**
 * What the mark shows, in read order: each source credit, then each distinct
 * licence, then a short note for every other duty. A recorded notice on those
 * duties stays, because notice retention is the notice itself.
 */
function markPieces(rights: Assessed, copy: RightsMarkCopy, linkedSourceHref?: string): ReactNode[] {
  const pieces: ReactNode[] = [];
  for (const [index, item] of rights.obligations.entries()) {
    const notice = item.kind === 'attribution' ? item.notice?.trim() : '';
    if (notice) pieces.push(<SourceCredit key={`attribution-${index}`} notice={notice} label={copy.source}
      linkedSourceHref={linkedSourceHref} />);
  }
  const instruments = [rights.instrument, ...rights.obligations.map(item => item.instrument)]
    .filter((instrument): instrument is string => Boolean(instrument));
  for (const instrument of [...new Set(instruments)]) {
    pieces.push(<LicenceLink key={`instrument-${instrument}`} instrument={instrument} copy={copy} />);
  }
  const seen = new Set<string>();
  for (const kind of noteKinds) {
    const matching = rights.obligations.filter(item => item.kind === kind);
    if (!matching.length) continue;
    pieces.push(<span key={kind}>{copy[noteKey[kind]]}</span>);
    for (const item of matching) pushNotice(pieces, seen, kind, item);
  }
  const others = rights.obligations.filter(item => item.kind === 'other');
  const otherNotices = others.flatMap(item => {
    const notice = item.notice?.trim();
    return notice ? [notice] : [];
  });
  if (otherNotices.length) {
    for (const notice of new Set(otherNotices)) pieces.push(<NoticeText key={`other-${notice}`} notice={notice} />);
  } else if (others.length) pieces.push(<span key="other">{copy.otherTerms}</span>);
  return pieces;
}

function pushNotice(pieces: ReactNode[], seen: Set<string>, kind: string, item: Obligation) {
  const notice = item.notice?.trim();
  if (!notice || seen.has(`${kind}\0${notice}`)) return;
  seen.add(`${kind}\0${notice}`);
  pieces.push(<NoticeText key={`${kind}-${notice}`} notice={notice} />);
}

function sameRights(left: DisplayObligations, right: DisplayObligations): boolean {
  return rightsKey(left) === rightsKey(right);
}

function rightsKey(rights: DisplayObligations): string {
  if (rights.status === 'unassessed') return 'unassessed';
  const obligations = rights.obligations.map(item =>
    [item.kind, item.instrument, item.appliesTo, item.notice ?? ''].join('\u0000')).join('\u0001');
  return ['assessed', rights.instrument ?? '', obligations].join('\u0001');
}

/** Consecutive rows that carry the same rights. A page-level read is one run. */
export function rightsRuns<T>(items: readonly T[], rightsOf: (item: T) => DisplayObligations):
  Array<{ rights: DisplayObligations; items: T[] }> {
  const runs: Array<{ rights: DisplayObligations; items: T[] }> = [];
  for (const item of items) {
    const rights = rightsOf(item);
    const last = runs.at(-1);
    if (last && sameRights(last.rights, rights)) last.items.push(item);
    else runs.push({ rights, items: [item] });
  }
  return runs;
}

/**
 * The source's credit and licence, and nothing when the read is unassessed.
 * The mark does not decide rights; it shows the read.
 */
export function RightsMark({ rights, locale = 'en', linkedSourceHref }: {
  rights: DisplayObligations; locale?: UiLocale;
  /** A preceding publication link owns this address; retain every credit and duty as text. */
  linkedSourceHref?: string;
}) {
  if (rights.status !== 'assessed') return null;
  const pieces = markPieces(rights, messages[locale], linkedSourceHref ? httpUrl(linkedSourceHref)?.href : undefined);
  if (!pieces.length) return null;
  return <p data-rights-mark dir="auto"
    className="min-w-0 max-w-3xl text-pretty text-muted-foreground text-xs/5 [overflow-wrap:anywhere]">
    {pieces.map((piece, index) => <Fragment key={index}>{index > 0 ? ' · ' : null}{piece}</Fragment>)}
  </p>;
}

/** An identifying cover's recorded credit, separate from fact and text licences. */
export function CoverCreditMark({ credit, locale = 'en', className }: {
  credit?: MediaImageMetadata['coverCredit'];
  locale?: UiLocale;
  className?: string;
}) {
  if (!credit) return null;
  const copy = messages[locale];
  const sourceUrl = httpUrl(credit.source.href);
  return <p data-cover-credit dir="ltr" className={cn(
    'min-w-0 text-pretty text-muted-foreground text-xs/5 [overflow-wrap:anywhere]', className,
  )}>
    {copy.coverCredit}<bdi dir="auto">{credit.text}</bdi>{' · '}{copy.source}
    {sourceUrl
      ? <a href={credit.source.href} rel="noreferrer noopener" className={linkClass}>
        <bdi dir="auto">{credit.source.name}</bdi>
      </a>
      : <bdi dir="auto">{credit.source.name}</bdi>}
  </p>;
}

/** Rows in the order they are read, with one mark beside each run of identical rights. */
export function RightsRunRows({ rows, locale = 'en' }: {
  rows: readonly { id: string; rights: DisplayObligations; children: ReactNode }[];
  locale?: UiLocale;
}) {
  return <div className="grid gap-4">
    {rightsRuns(rows, row => row.rights).map(run => <div key={run.items.map(item => item.id).join(' ')}
      data-rights-run className="grid min-w-0 gap-1">
      <ul className="grid min-w-0 gap-1">
        {run.items.map(item => <li key={item.id} className="min-w-0">{item.children}</li>)}
      </ul>
      <RightsMark rights={run.rights} locale={locale} />
    </div>)}
  </div>;
}
