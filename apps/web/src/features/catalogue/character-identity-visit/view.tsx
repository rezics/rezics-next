import { useState } from 'react';
import { m } from '../../../paraglide/messages.js';
import { ValueExplanationEntry } from '../value-explanation-entry';
import { CoverList } from '../../pages/cover-list';
import type { Item, OverviewValue, Section } from '../../pages/overview';
import type { ConnectionSection } from '../../pages/subject-connections';
import { PlainLink } from '../../pages/shared';
import { connectionReturnHref, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { identityProperty } from '../character-relationships/reading';
import { characterAssociationDisclosure, exactAssertionId } from './reading';

type Current = ConnectionSection & { section: Extract<Section, { ok: true }> };

export function CharacterIdentityVisit({
  current,
  items,
  value,
  more,
  identityAvailable,
}: {
  current: Current;
  items: Item[];
  value: OverviewValue;
  more: boolean;
  identityAvailable: boolean;
}) {
  const [showSpoilers, setShowSpoilers] = useState(false);
  const o = { locale: value.locale as never };
  const disclosure = characterAssociationDisclosure(current, items);
  const rows = showSpoilers ? [...disclosure.visible, ...disclosure.spoiler] : disclosure.visible;
  const spoilerHidden = disclosure.spoiler.length > 0 && !showSpoilers;
  const identity = current.stream.property === identityProperty;

  function visitFor(item: Item) {
    const holder = current.stream.direction === 'in' ? item.id : (value.subject ?? '');
    const holderLabel =
      current.stream.direction === 'in' ? item.label.text || value.unlabelled : value.subjectLabel || value.unlabelled;
    const statement = exactAssertionId(item.statement) ? item.statement : undefined;
    const holderAddressable = exactAssertionId(holder);
    const returnWindow = {
      stream: current.stream.key,
      ...(current.reading ? { reading: current.reading } : {}),
      ...(current.reading && 'cursor' in current.section.read && current.section.read.cursor
        ? { cursor: current.section.read.cursor }
        : {}),
      ...(current.reading && statement && holderAddressable ? { focus: statement, holder } : {}),
    };
    const returnTo = connectionReturnHref(
      value.subject ?? '',
      value.subjectLabel ?? value.unlabelled,
      value.locale,
      value.realm,
      returnWindow,
    );
    const TargetLink: typeof PlainLink = (props) => (
      <value.link {...props} href={withSubjectVisitReturn(props.href, returnTo, value.locale)} />
    );
    return {
      holder,
      holderLabel,
      statement,
      returnTo,
      link: TargetLink,
      ...(current.reading && statement && holderAddressable ? { focusHolder: holder } : {}),
      details: (
        <div className="space-y-2 px-4 pb-4 [overflow-wrap:anywhere]">
          <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-sm font-medium">{m.character_identity_visit_original_holder({}, o)}</dt>
              <dd>{holderLabel}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm font-medium">{m.character_identity_visit_meaning({}, o)}</dt>
              <dd lang={current.stream.language ?? undefined}>{current.stream.label}</dd>
            </div>
            {current.stream.direction === 'in' && current.stream.forwardLabel !== current.stream.label && (
              <div className="min-w-0">
                <dt className="text-sm font-medium">{m.character_identity_visit_property({}, o)}</dt>
                <dd>{current.stream.forwardLabel}</dd>
              </div>
            )}
          </dl>
          <nav aria-label={m.character_identity_visit_heading({}, o)}>
            {statement && holderAddressable ? (
              <ValueExplanationEntry
                id={holder}
                title={holderLabel}
                property={current.stream.property}
                statement={statement}
                locale={value.locale}
                returnTo={returnTo}
                label={m.character_identity_visit_evidence({}, o)}
                {...(value.context?.id ? { context: value.context.id } : {})}
              />
            ) : (
              <p role="status">{m.character_identity_visit_evidence_unavailable({}, o)}</p>
            )}
          </nav>
        </div>
      ),
    };
  }

  return (
    <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]" data-slot="character-identity-visit">
      {identity && (
        <p className="max-w-prose text-sm text-muted-foreground">
          {m.character_identity_visit_identity_note({}, o)}
        </p>
      )}
      {!identityAvailable && <p role="status">{m.character_identity_visit_unavailable({}, o)}</p>}
      <div className="space-y-3" data-direction={current.stream.direction}>
        <p className="text-sm font-medium" lang={current.stream.language ?? undefined}>
          {current.stream.label}
        </p>
        {rows.length ? (
          <CoverList
            items={rows}
            value={value}
            label={current.stream.label}
            itemVisit={(item) => {
              const visit = visitFor(item);
              return {
                link: visit.link,
                details: visit.details,
                ...(visit.focusHolder ? { holder: visit.focusHolder } : {}),
              };
            }}
          />
        ) : !spoilerHidden && !disclosure.withheld ? (
          <p role="status">{m.subject_relation_empty_page({}, o)}</p>
        ) : null}
      </div>
      {spoilerHidden && (
        <div className="space-y-2">
          <p role="status">{m.character_identity_visit_spoiler_hidden({}, o)}</p>
          <button
            type="button"
            className="inline-flex min-h-11 min-w-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            aria-expanded={showSpoilers}
            onClick={() => setShowSpoilers(true)}
          >
            {m.character_identity_visit_reveal({}, o)}
          </button>
        </div>
      )}
      {showSpoilers && disclosure.spoiler.length > 0 && (
        <button
          type="button"
          className="inline-flex min-h-11 min-w-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          aria-expanded={showSpoilers}
          onClick={() => setShowSpoilers(false)}
        >
          {m.subject_spoiler_hide({}, o)}
        </button>
      )}
      {disclosure.withheld && <p role="status">{m.character_identity_visit_withheld({}, o)}</p>}
      {more && <p role="status">{m.character_identity_visit_partial({}, o)}</p>}
    </div>
  );
}
