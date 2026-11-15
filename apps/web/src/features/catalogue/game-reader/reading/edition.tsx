import { useId, useLayoutEffect, useRef } from 'react';
import { cn } from '@rezics/ui/utils';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../../paraglide/messages.js';
import type { GameReaderReady } from '../model';
import { subjectHref, subjectUrlForView } from '../../../../subject/load-subject';
import type { WorkReadingLink } from '../../work-reading-port';
import { action, linkClass } from './controls';
import { GameEvidence } from './evidence';

export type EditionSelection = {
  page: GameReaderReady;
  row: GameReaderReady['editions'][number];
  opener: HTMLButtonElement;
  keyboard: boolean;
};

/** A selection belongs to this exact admitted row object, never a release label or target ID. */
export function EditionInspection({
  selection,
  page,
  locale,
  current,
  link: Link,
  close,
}: {
  selection: EditionSelection;
  page: GameReaderReady;
  locale: string;
  current: () => boolean;
  link: WorkReadingLink;
  close: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const { row, opener, keyboard } = selection;
  const o = { locale: locale as never };
  useLayoutEffect(() => {
    if (current() && keyboard && document.activeElement === opener) heading.current?.focus();
  }, [selection]);
  if (!current() || selection.page !== page || !page.editions.includes(row)) return null;
  const statement = row.assertion;
  const related = Object.fromEntries(
    Object.entries(row.related ?? {}).map(([key, item]) => [
      key,
      {
        type: item.type,
        labels: item.label ? { [item.label.language]: item.label.value } : {},
      },
    ]),
  );
  return (
    <section
      ref={panel}
      aria-labelledby={id}
      data-slot="game-edition-inspection"
      className="min-w-0 space-y-4 rounded-lg border-2 border-primary bg-card p-4 sm:p-5"
    >
      <h4
        ref={heading}
        tabIndex={-1}
        id={id}
        className="font-semibold focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.game_reader_inspection({}, o)}
      </h4>
      <p className="rounded-md border-l-2 border-primary bg-muted/40 px-3 py-2">
        {statement ? m.game_reader_association_meaning({}, o) : m.game_reader_assertion_unavailable({}, o)}
      </p>
      {row.summary?.label?.value ? (
        <p lang={row.summary.label.language} className="break-words text-lg font-semibold">
          {row.summary.label.value}
        </p>
      ) : (
        <p>{m.work_parts_unresolved({}, o)}</p>
      )}
      {statement && row.summary?.label?.value && page.editionTypes.includes(row.summary.type) ? (
        <nav className="flex min-w-0 flex-wrap gap-x-4 gap-y-2" aria-label={m.game_reader_open({}, o)}>
          <Link
            className={linkClass}
            href={subjectHref({ id: row.summary.id, label: row.summary.label.value }, locale).href}
          >
            {m.game_reader_open({}, o)}
          </Link>
          <Link
            className={linkClass}
            href={subjectUrlForView(
              subjectHref({ id: row.summary.id, label: row.summary.label.value }, locale),
              'release',
            )}
          >
            {m.game_reader_release_detail({}, o)}
          </Link>
        </nav>
      ) : null}
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="min-w-0 rounded-md bg-muted/30 p-3">
          <dt className="font-medium">{m.game_reader_holder({}, o)}</dt>
          <dd className="min-w-0">
            <code className="break-all font-mono text-xs">{row.subject}</code>
          </dd>
        </div>
        <div className="min-w-0 rounded-md bg-muted/30 p-3">
          <dt className="font-medium">{m.game_reader_statement({}, o)}</dt>
          <dd className="min-w-0">
            <code className="break-all font-mono text-xs">{row.statement}</code>
          </dd>
        </div>
        <div className="min-w-0 rounded-md bg-muted/30 p-3">
          <dt className="font-medium">{m.statement_consent_relationship({}, o)}</dt>
          <dd className="min-w-0">
            <code className="break-all font-mono text-xs">{row.property}</code>
          </dd>
        </div>
        <div className="min-w-0 rounded-md bg-muted/30 p-3">
          <dt className="font-medium">{m.relation_target({}, o)}</dt>
          <dd className="min-w-0">
            {statement?.value.type === 'value' && typeof statement.value.content === 'string' ? (
              <code className="break-all font-mono text-xs">{statement.value.content}</code>
            ) : (
              m.game_reader_assertion_unavailable({}, o)
            )}
          </dd>
        </div>
        <div className="min-w-0 rounded-md bg-muted/30 p-3">
          <dt className="font-medium">{m.game_reader_released_type({}, o)}</dt>
          <dd className="min-w-0">
            <code className="break-all font-mono text-xs">{row.summary?.type ?? row.type}</code>
          </dd>
        </div>
      </dl>
      {statement ? (
        <>
          <p className="border-t border-border pt-3">
            {m.candidate_rank({}, o)}: <code>{statement.rank}</code>
          </p>
          <h5 className="font-semibold">{m.subject_qualifiers({}, o)}</h5>
          {!statement.qualifiers.length ? <p>{m.game_reader_no_qualifiers({}, o)}</p> : null}
          <GameEvidence statement={statement} page={page} related={related} locale={locale} link={Link} />
          {!statement.references.length ? <p>{m.game_reader_no_references({}, o)}</p> : null}
        </>
      ) : (
        <p role="status">{m.game_reader_assertion_unavailable({}, o)}</p>
      )}
      <button
        type="button"
        className={cn(buttonVariants({ variant: 'outline' }), action)}
        onClick={(event) => {
          if (!current()) return;
          const restore =
            event.detail === 0 && keyboard && opener.isConnected && !!panel.current?.contains(document.activeElement);
          close();
          if (restore) opener.focus();
        }}
      >
        {m.game_reader_close_inspection({}, o)}
      </button>
    </section>
  );
}
