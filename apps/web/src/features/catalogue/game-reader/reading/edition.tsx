import { useId, useLayoutEffect, useRef } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../../paraglide/messages.js';
import type { GameReaderReady } from '../model';
import { subjectHref, subjectUrlForView } from '../../../../subject/subject-href';
import { action } from './controls';
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
  link: typeof import('../../../pages/shared').PlainLink;
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
      className="space-y-4 rounded-lg border-2 border-primary p-4"
    >
      <h4
        ref={heading}
        tabIndex={-1}
        id={id}
        className="font-semibold focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.game_reader_inspection({}, o)}
      </h4>
      <p>{m.game_reader_association_meaning({}, o)}</p>
      {row.summary?.label?.value ? (
        <p lang={row.summary.label.language}>{row.summary.label.value}</p>
      ) : (
        <p>{m.work_parts_unresolved({}, o)}</p>
      )}
      {statement && row.summary?.label?.value && page.editionTypes.includes(row.summary.type) ? (
        <nav className="flex flex-wrap gap-x-4" aria-label={m.game_reader_open({}, o)}>
          <Link href={subjectHref({ id: row.summary.id, label: row.summary.label.value }, locale).href}>
            {m.game_reader_open({}, o)}
          </Link>
          <Link
            href={subjectUrlForView(
              subjectHref({ id: row.summary.id, label: row.summary.label.value }, locale),
              'release',
            )}
          >
            {m.game_reader_release_detail({}, o)}
          </Link>
        </nav>
      ) : null}
      <dl className="space-y-3">
        <div>
          <dt className="font-medium">{m.game_reader_holder({}, o)}</dt>
          <dd>
            <code>{row.subject}</code>
          </dd>
        </div>
        <div>
          <dt className="font-medium">{m.game_reader_statement({}, o)}</dt>
          <dd>
            <code>{row.statement}</code>
          </dd>
        </div>
        <div>
          <dt className="font-medium">{m.statement_consent_relationship({}, o)}</dt>
          <dd>
            <code>{row.property}</code>
          </dd>
        </div>
        <div>
          <dt className="font-medium">{m.relation_target({}, o)}</dt>
          <dd>
            <code>{page.public.subject.id}</code>
          </dd>
        </div>
        <div>
          <dt className="font-medium">{m.game_reader_released_type({}, o)}</dt>
          <dd>
            <code>{row.summary?.type ?? row.type}</code>
          </dd>
        </div>
      </dl>
      {statement ? (
        <>
          <p>
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
        className={`${buttonVariants({ variant: 'outline' })} ${action}`}
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
