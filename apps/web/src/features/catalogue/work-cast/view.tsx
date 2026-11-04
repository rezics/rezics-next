import { CoverList } from '../../pages/cover-list';
import type { Item, RowValue } from '../../pages/overview';
import { m } from '../../../paraglide/messages.js';
import { castWindow } from './model';
import type { LinkProps } from '../../pages/shared';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { subjectHref } from '../../../subject/subject-href';
import type { CreditVisit } from '../credit-inspection/model';
import { useState } from 'react';

type Presentation = 'character' | 'credit-order';

function optionClass(selected: boolean): string {
  return `min-h-11 min-w-11 rounded-md border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:bg-accent'
  }`;
}

/** A local presentation of the existing bounded P725 window. Target pages open in a new tab to retain this visit. */
export function WorkCastWindow({
  items,
  value,
  creditVisit,
  label,
}: {
  items: Item[];
  value: RowValue & {
    subject?: string | null | undefined;
    subjectLabel?: string | undefined;
    realm?: string | undefined;
  };
  creditVisit?: CreditVisit | undefined;
  label: string;
}) {
  const [presentation, setPresentation] = useState<Presentation>('character');
  const actionableTargets = new Set(
    items.flatMap((item) => [
      item.id,
      ...(item.qualified ?? []).flatMap((note) =>
        note.property === 'wdt:P453' && note.subject ? [note.subject.id] : [],
      ),
    ]),
  );
  const unlabelledTargets = new Set(items.filter((item) => !item.label.text.trim()).map((item) => item.id));
  const CurrentLink = value.link;
  const returnTo = value.subject
    ? subjectHref({ id: value.subject, label: value.subjectLabel ?? value.unlabelled }, value.locale).href
    : '';
  const returnUrl = new URL(returnTo || '/', 'https://rezics.invalid');
  if (value.context?.population.kind === 'realm') returnUrl.searchParams.set('realm', value.context.population.id);
  const returnAddress = returnTo ? `${returnUrl.pathname}${returnUrl.search}` : '';
  const CastTargetLink = ({ href, lang, className, children }: LinkProps) => {
    const target = [...actionableTargets].find((id) => href.includes(`/subjects/${encodeURIComponent(id)}/`));
    if (target && unlabelledTargets.has(target))
      return (
        <span lang={lang} className={className}>
          {children}
        </span>
      );
    if (target)
      return (
        <a
          href={withSubjectVisitReturn(href, returnAddress, value.locale)}
          lang={lang}
          className={className}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    return (
      <CurrentLink href={href} lang={lang} className={className}>
        {children}
      </CurrentLink>
    );
  };
  const { subject: subjectId, ...rowValue } = value;
  const targetValue: RowValue & { subject?: string | null } = {
    ...rowValue,
    ...(subjectId !== undefined ? { subject: subjectId } : {}),
    link: CastTargetLink,
  };
  const window = castWindow(items);
  const options = { locale: value.locale as never };

  return (
    <div data-slot="work-cast-window" data-presentation={presentation} className="min-w-0 space-y-4">
      <div role="group" aria-label={m.work_cast_presentation({}, options)} className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={presentation === 'character'}
          className={optionClass(presentation === 'character')}
          onClick={() => setPresentation('character')}
        >
          {m.work_cast_group_by_character({}, options)}
        </button>
        <button
          type="button"
          aria-pressed={presentation === 'credit-order'}
          className={optionClass(presentation === 'credit-order')}
          onClick={() => setPresentation('credit-order')}
        >
          {m.work_cast_original_order({}, options)}
        </button>
      </div>
      <p className="text-sm text-muted-foreground">{m.work_cast_window_scope({}, options)}</p>
      {presentation === 'credit-order' ? (
        <CoverList items={items} value={targetValue} label={label} creditVisit={creditVisit} />
      ) : (
        <div className="min-w-0 space-y-6">
          {window.groups.map(({ character, performances }) => (
            <section key={character.id} className="min-w-0 space-y-3">
              <h3 className="text-lg font-semibold [overflow-wrap:anywhere]">{character.label}</h3>
              <ul aria-label={character.label} className="grid min-w-0 gap-4">
                {performances.map(({ performer, character: target }) => {
                  const performerItem: Item = {
                    ...performer,
                    ...(performer.qualified
                      ? {
                          qualified: performer.qualified.filter(
                            (note) => note.property !== 'wdt:P453' || !note.subject,
                          ),
                        }
                      : {}),
                  };
                  const characterItem: Item = {
                    id: target.id,
                    label: {
                      text: target.label,
                      lang:
                        target.summary?.label && typeof target.summary.label === 'object'
                          ? target.summary.label.language
                          : undefined,
                    },
                    ...(target.summary ? { summary: target.summary } : {}),
                    notes: [],
                    qualified: [],
                    statement: performer.statement,
                    gated: false,
                  };
                  return (
                    <li
                      key={performer.statement}
                      data-statement={performer.statement}
                      className="grid min-w-0 gap-3 rounded-md border p-3 sm:grid-cols-2"
                    >
                      <div className="min-w-0 space-y-2">
                        <h4 className="font-medium">{m.work_cast_character({}, options)}</h4>
                        <CoverList
                          items={[characterItem]}
                          value={targetValue}
                          label={m.work_cast_character({}, options)}
                          creditVisit={creditVisit}
                        />
                      </div>
                      <div className="min-w-0 space-y-2">
                        <h4 className="font-medium">{m.work_cast_performer({}, options)}</h4>
                        <CoverList
                          items={[performerItem]}
                          value={targetValue}
                          label={m.work_cast_performer({}, options)}
                          creditVisit={creditVisit}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {window.unpaired.length > 0 && (
            <section className="min-w-0 space-y-3">
              <h3 className="text-lg font-semibold">{m.work_cast_unpaired({}, options)}</h3>
              <CoverList
                items={window.unpaired}
                value={targetValue}
                label={m.work_cast_unpaired({}, options)}
                creditVisit={creditVisit}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
