import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CoverList } from '../../pages/cover-list';
import type { Item, RowValue } from '../../pages/overview';
import { SpoilerGate } from '../../pages/values';
import { m } from '../../../paraglide/messages.js';
import {
  withSubjectVisitReturn,
  workCastVisitReturn,
  workCastVisitReturnFragment,
} from '../../pages/subject-visit-navigation';
import { subjectHref, subjectViewHref } from '../../../subject/subject-href';
import { ValueExplanationEntry } from '../value-explanation-entry';
import type { CreditVisit } from '../credit-inspection/model';
import type { LinkProps } from '../../pages/shared';
import { castWindow } from './model';

type Presentation = 'character' | 'credit-order';
type WorkCastReturn = NonNullable<ReturnType<typeof workCastVisitReturn>>;
type WorkCastValue = RowValue & {
  subject?: string | null | undefined;
  subjectLabel?: string | undefined;
  realm?: string | undefined;
};

export type WorkCastNavigation = {
  view?: string;
  node?: string;
  cursor?: string | null;
  hasPrevious?: boolean;
  previousCursor?: string | null;
  previousHref?: string | undefined;
  returnHistory?: readonly (string | null)[] | undefined;
  previousHistory?: readonly (string | null)[] | undefined;
  returnState?: WorkCastReturn | undefined;
  restartHref?: string | undefined;
};

function optionClass(selected: boolean): string {
  return `min-h-11 min-w-11 rounded-md border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:bg-accent'
  }`;
}

function contextId(value: RowValue): string {
  return value.context?.id ?? PAGE_GLOBAL_CONTEXT;
}

function castAddressAt(baseHref: string, address: WorkCastReturn): string {
  const base = baseHref.split('#', 1)[0]!;
  const { history: _history, ...fixedAddress } = address;
  const fixedFragment = workCastVisitReturnFragment(fixedAddress);
  const historyBudget = Math.max(0, 32768 - base.length - fixedFragment.length - 16);
  return `${base}${workCastVisitReturnFragment(address, historyBudget)}`;
}

function returnAddress(
  value: WorkCastValue,
  navigation: WorkCastNavigation | undefined,
  presentation: Presentation,
  focus: { statement: string; character?: string },
): string | undefined {
  if (!value.subject || !focus.statement) return;
  const identity = { id: value.subject, label: value.subjectLabel ?? value.unlabelled };
  const href =
    navigation?.view && navigation.view !== 'overview'
      ? subjectViewHref(identity, value.locale, navigation.view)
      : subjectHref(identity, value.locale).href;
  const url = new URL(href, 'https://rezics.invalid');
  const realm = value.realm ?? (value.context?.population.kind === 'realm' ? value.context.population.id : undefined);
  if (realm) url.searchParams.set('realm', realm);
  if (navigation?.view && navigation.view !== 'overview' && navigation.node)
    url.searchParams.set('node', navigation.node);
  if (navigation?.view && navigation.view !== 'overview' && navigation.cursor)
    url.searchParams.set('cursor', navigation.cursor);
  const returnSelection: WorkCastReturn = {
    context: contextId(value),
    node: navigation?.node ?? 'work-cast',
    presentation,
    statement: focus.statement,
    ...(focus.character ? { character: focus.character } : {}),
    ...(navigation?.returnHistory ? { history: [...navigation.returnHistory] } : {}),
  };
  return castAddressAt(`${url.pathname}${url.search}`, returnSelection);
}

function restartAddress(value: WorkCastValue, navigation: WorkCastNavigation | undefined): string | undefined {
  if (!value.subject) return;
  const identity = { id: value.subject, label: value.subjectLabel ?? value.unlabelled };
  const href =
    navigation?.view && navigation.view !== 'overview'
      ? subjectViewHref(identity, value.locale, navigation.view)
      : subjectHref(identity, value.locale).href;
  const url = new URL(href, 'https://rezics.invalid');
  const realm = value.realm ?? (value.context?.population.kind === 'realm' ? value.context.population.id : undefined);
  if (realm) url.searchParams.set('realm', realm);
  if (navigation?.view && navigation.view !== 'overview' && navigation.node)
    url.searchParams.set('node', navigation.node);
  return `${url.pathname}${url.search}`;
}

function subjectIdFromHref(href: string): string | undefined {
  try {
    const segment = new URL(href, 'https://rezics.invalid').pathname.split('/')[3];
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return;
  }
}

type ReturnFocusIntent = {
  key: string;
  addressKey: string;
  status: 'pending' | 'cancelled' | 'consumed';
  origin: Element | null;
};

function currentHeading(root: HTMLDivElement | null): HTMLElement | null {
  const section = root?.closest<HTMLElement>('section[aria-labelledby]');
  const document = section?.ownerDocument;
  const labelledBy = section?.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
  for (const id of labelledBy) {
    const heading = document?.getElementById(id);
    if (heading && /^H[1-6]$/.test(heading.tagName)) return heading;
  }
  return null;
}

function canReceiveRestoredFocus(target: HTMLElement): boolean {
  if (
    !target.isConnected ||
    target.closest('[hidden], [inert], [aria-hidden="true"]') ||
    target.getClientRects().length === 0
  )
    return false;
  const view = target.ownerDocument.defaultView;
  if (!view) return false;
  for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
    const style = view.getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

function InspectTab({ href, lang, className, children }: LinkProps) {
  return (
    <a href={href} lang={lang} className={className} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function OriginalCredit({ item, value, returnTo }: { item: Item; value: WorkCastValue; returnTo: string | undefined }) {
  const options = { locale: value.locale as never };
  if (!item.credit)
    return (
      <p role="note" className="text-sm text-muted-foreground">
        {m.work_cast_inspection_unavailable({}, options)}
      </p>
    );
  return (
    <ValueExplanationEntry
      id={item.credit.holder}
      property={item.credit.statement.property.id}
      statement={item.credit.statement.id}
      context={contextId(value)}
      title={value.subjectLabel ?? value.unlabelled}
      locale={value.locale}
      {...(returnTo ? { returnTo } : {})}
      label={m.work_cast_inspect_original({}, options)}
      link={InspectTab}
    />
  );
}

/** A presentation of one admitted forward P725 page. Inspection and target visits retain exact current identities. */
export function WorkCastWindow({
  items,
  value,
  creditVisit,
  label,
  navigation,
}: {
  items: Item[];
  value: WorkCastValue;
  creditVisit?: CreditVisit | undefined;
  label: string;
  navigation?: WorkCastNavigation | undefined;
}) {
  const locationHash = typeof window === 'undefined' ? undefined : window.location.hash;
  const initialReturn = useMemo(
    () => navigation?.returnState ?? (locationHash !== undefined ? workCastVisitReturn(locationHash) : undefined),
    [navigation?.returnState, locationHash],
  );
  const currentContext = contextId(value);
  const currentNode = navigation?.node ?? initialReturn?.node;
  const returnKey = JSON.stringify(initialReturn ?? null);
  const returnFocusKey = JSON.stringify([
    returnKey,
    currentContext,
    currentNode ?? null,
    initialReturn?.statement ?? null,
    initialReturn?.character ?? null,
  ]);
  const [presentation, setPresentation] = useState<Presentation>(() =>
    initialReturn?.context === currentContext && (!currentNode || initialReturn.node === currentNode)
      ? initialReturn.presentation
      : 'character',
  );
  const [returnChanged, setReturnChanged] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const returnFocusIntent = useRef<ReturnFocusIntent | null>(null);
  const disclosedTargets = new Set(
    items.flatMap((item) => [
      ...(item.label.text.trim() ? [item.id] : []),
      ...(item.qualified ?? []).flatMap((note) =>
        note.property === 'wdt:P453' && note.subject?.label.trim() ? [note.subject.id] : [],
      ),
    ]),
  );
  const projected = useMemo(() => castWindow(items), [items]);
  const options = { locale: value.locale as never };
  const fallbackRestart = restartAddress(value, navigation);
  const restartHref = navigation?.restartHref ?? fallbackRestart;
  const previousWindowHref =
    navigation?.hasPrevious && navigation.previousHref
      ? castAddressAt(navigation.previousHref, {
          context: currentContext,
          node: navigation.node ?? 'work-cast',
          presentation,
          ...(navigation.previousHistory ? { history: [...navigation.previousHistory] } : {}),
        })
      : undefined;

  useLayoutEffect(() => {
    if (returnKey === 'null') return;
    const element = root.current;
    const ownerDocument = element?.ownerDocument;
    if (!element || !ownerDocument) return;
    let intent = returnFocusIntent.current;
    if (!intent || intent.addressKey !== returnKey) {
      intent = { key: returnFocusKey, addressKey: returnKey, status: 'pending', origin: ownerDocument.activeElement };
      returnFocusIntent.current = intent;
    } else if (intent.key !== returnFocusKey) {
      intent.key = returnFocusKey;
    }
    if (intent.status !== 'pending') return;

    const heading = currentHeading(element);
    const onFocusIn = (event: FocusEvent) => {
      if (intent.status !== 'pending') return;
      if (
        event.target === intent.origin ||
        event.target === ownerDocument.body ||
        event.target === ownerDocument.documentElement ||
        event.target === heading
      )
        return;
      intent.status = 'cancelled';
    };
    ownerDocument.addEventListener('focusin', onFocusIn, true);
    return () => ownerDocument.removeEventListener('focusin', onFocusIn, true);
  }, [returnFocusKey, returnKey]);

  useEffect(() => {
    if (!initialReturn) return;
    const intent = returnFocusIntent.current;
    const element = root.current;
    const ownerDocument = element?.ownerDocument;
    if (!intent || intent.key !== returnFocusKey || !element || !ownerDocument || intent.status === 'consumed') return;

    const heading = currentHeading(element);
    const ownsFocus = () => {
      if (intent.status !== 'pending') return false;
      const active = ownerDocument.activeElement;
      if (
        active === intent.origin ||
        active === ownerDocument.body ||
        active === ownerDocument.documentElement ||
        active === heading
      )
        return true;
      intent.status = 'cancelled';
      return false;
    };
    const focusOnce = (target: HTMLElement | null) => {
      if (intent.status !== 'pending') return;
      const stillOwnsFocus = ownsFocus();
      if (!stillOwnsFocus) return;
      intent.status = 'consumed';
      if (!target || !canReceiveRestoredFocus(target)) return;
      target.tabIndex = -1;
      target.focus();
    };

    if (
      initialReturn.context !== currentContext ||
      (navigation?.node !== undefined && initialReturn.node !== navigation.node)
    ) {
      if (intent.status === 'pending') setPresentation('character');
      setReturnChanged(true);
      focusOnce(heading);
      return;
    }
    if (!initialReturn.statement) {
      setReturnChanged(false);
      focusOnce(null);
      return;
    }
    const admitted = initialReturn.character
      ? projected.groups.some(
          (group) =>
            group.character.id === initialReturn.character &&
            group.performances.some((entry) => entry.performer.statement === initialReturn.statement),
        )
      : items.some((item) => item.statement === initialReturn.statement && !item.gated);
    const selector = initialReturn.character
      ? `li[data-statement="${initialReturn.statement}"][data-character="${initialReturn.character}"]`
      : `[data-statement="${initialReturn.statement}"]`;
    const row = admitted ? root.current?.querySelector<HTMLElement>(selector) : null;
    if (!row || !canReceiveRestoredFocus(row)) {
      setReturnChanged(true);
      focusOnce(heading);
      return;
    }
    setReturnChanged(false);
    focusOnce(row);
  }, [returnFocusKey, returnKey, items, projected, currentContext, currentNode, navigation?.node, initialReturn]);

  function choosePresentation(next: Presentation) {
    if (returnFocusIntent.current?.status === 'pending') returnFocusIntent.current.status = 'cancelled';
    setPresentation(next);
  }

  function valueFor(focus: { statement: string; character?: string }): RowValue & { subject?: string | null } {
    const CurrentLink = value.link;
    const TargetLink = ({ href, lang, className, children }: LinkProps) => {
      const id = subjectIdFromHref(href);
      if (!id || !focus.statement || !disclosedTargets.has(id))
        return (
          <span lang={lang} className={className}>
            {children}
          </span>
        );
      const address = returnAddress(value, navigation, presentation, focus);
      return (
        <a
          href={address ? withSubjectVisitReturn(href, address, value.locale) : href}
          lang={lang}
          className={className}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    };
    const { subject: subjectId, ...rest } = value;
    return {
      ...rest,
      ...(subjectId !== undefined ? { subject: subjectId } : {}),
      link: ({ href, lang, className, children }: LinkProps) => {
        const id = subjectIdFromHref(href);
        if (id) {
          if (!disclosedTargets.has(id))
            return (
              <span lang={lang} className={className}>
                {children}
              </span>
            );
          return (
            <TargetLink href={href} lang={lang} className={className}>
              {children}
            </TargetLink>
          );
        }
        return (
          <CurrentLink href={href} lang={lang} className={className}>
            {children}
          </CurrentLink>
        );
      },
    };
  }

  function card(item: Item, focus: { statement: string; character?: string }, rowLabel: string) {
    const visibleItem = item.gated ? { ...item, gated: false } : item;
    const returnTo = returnAddress(value, navigation, presentation, focus);
    const content = (
      <>
        <CoverList items={[visibleItem]} value={valueFor(focus)} label={rowLabel} creditVisit={creditVisit} />
        <div className="ps-1">
          <OriginalCredit item={item} value={value} returnTo={returnTo} />
        </div>
      </>
    );
    return item.gated ? (
      <SpoilerGate label={value.spoilerShow} hideLabel={value.labels.spoilerHide} unmountOnHide>
        {content}
      </SpoilerGate>
    ) : (
      content
    );
  }

  return (
    <div ref={root} data-slot="work-cast-window" data-presentation={presentation} className="min-w-0 space-y-4">
      {returnChanged && (
        <div role="status" className="space-y-2">
          <p>{m.work_cast_window_changed({}, options)}</p>
          {restartHref && (
            <a data-slot="restart-group" className="inline-flex min-h-11 items-center underline" href={restartHref}>
              {m.subject_relation_restart({}, options)}
            </a>
          )}
        </div>
      )}
      <div role="group" aria-label={m.work_cast_presentation({}, options)} className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={presentation === 'character'}
          className={optionClass(presentation === 'character')}
          onClick={() => choosePresentation('character')}
        >
          {m.work_cast_group_by_character({}, options)}
        </button>
        <button
          type="button"
          aria-pressed={presentation === 'credit-order'}
          className={optionClass(presentation === 'credit-order')}
          onClick={() => choosePresentation('credit-order')}
        >
          {m.work_cast_original_order({}, options)}
        </button>
      </div>
      <p className="text-sm text-muted-foreground">{m.work_cast_window_scope({}, options)}</p>
      {previousWindowHref && (
        <a
          data-slot="previous-group"
          href={previousWindowHref}
          className="inline-flex min-h-11 items-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.work_cast_previous_window({}, options)}
        </a>
      )}
      {items.length === 0 ? (
        <p role="status">{m.subject_relation_empty_page({}, options)}</p>
      ) : presentation === 'credit-order' ? (
        <ol aria-label={label} className="min-w-0 list-none space-y-4 p-0">
          {items.map((item) => {
            const statement = item.statement;
            if (!statement) return null;
            return (
              <li
                key={statement}
                data-statement={statement}
                data-work-cast-row={statement}
                className="min-w-0 rounded-md border p-2"
              >
                {card(item, { statement }, label)}
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="min-w-0 space-y-6">
          {projected.groups.map(({ character, performances }) => (
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
                  const focus = { statement: performer.statement!, character: target.id };
                  return (
                    <li
                      key={`${performer.statement}:${target.id}`}
                      data-statement={performer.statement}
                      data-character={target.id}
                      className="grid min-w-0 gap-3 rounded-md border p-3 sm:grid-cols-2"
                    >
                      <div className="min-w-0 space-y-2">
                        <h4 className="font-medium">{m.work_cast_character({}, options)}</h4>
                        <CoverList
                          items={[characterItem]}
                          value={valueFor(focus)}
                          label={m.work_cast_character({}, options)}
                          creditVisit={creditVisit}
                        />
                      </div>
                      <div className="min-w-0 space-y-2">
                        <h4 className="font-medium">{m.work_cast_performer({}, options)}</h4>
                        <CoverList
                          items={[performerItem]}
                          value={valueFor(focus)}
                          label={m.work_cast_performer({}, options)}
                          creditVisit={creditVisit}
                        />
                        <div className="ps-1">
                          <OriginalCredit
                            item={performer}
                            value={value}
                            returnTo={returnAddress(value, navigation, presentation, focus)}
                          />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {projected.unpaired.length > 0 && (
            <section className="min-w-0 space-y-3">
              <h3 className="text-lg font-semibold">{m.work_cast_unpaired({}, options)}</h3>
              <div className="grid min-w-0 gap-4">
                {projected.unpaired.map((item, index) => {
                  const statement = item.statement ?? `unpaired-${index}`;
                  return (
                    <div
                      key={`${statement}:${index}`}
                      data-work-cast-row={item.statement}
                      className="min-w-0 rounded-md border p-2"
                    >
                      {card(item, { statement: item.statement ?? '' }, m.work_cast_unpaired({}, options))}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
