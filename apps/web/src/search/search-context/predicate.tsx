import type { DiscoveryFilterDocument, FilterRange, OwnerLeaf } from '@rezics/filter';
import type { ReactNode } from 'react';
import { calendarPrecision } from '../condition-calendar';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';

export function rangeDescription(
  range: FilterRange,
  locale = 'en',
  unitText?: (unit: string | undefined) => string | undefined,
): ReactNode {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  if (range.type === 'time') {
    const endpoint = (value: string | undefined) =>
      value === undefined ? calendarPrecision(undefined, locale) : `${value} (${calendarPrecision(value, locale)})`;
    return `${m.condition_range_calendar_mode({}, options)}: ≥ ${endpoint(range.gte)}; ≤ ${endpoint(range.lte)}. ${m.condition_calendar_overlap({}, options)}`;
  }
  const end = (value: unknown) => (typeof value === 'object' ? JSON.stringify(value) : String(value));
  const unit = unitText?.(range.unit) ?? range.unit;
  if (unit === undefined) {
    return [range.gte === undefined ? '' : `≥ ${end(range.gte)}`, range.lte === undefined ? '' : `≤ ${end(range.lte)}`]
      .filter(Boolean)
      .join(' ');
  }
  return (
    <>
      {range.gte !== undefined && <span>≥ {end(range.gte)}</span>}
      {range.lte !== undefined && (
        <span>
          {range.gte !== undefined ? ' ' : ''}≤ {end(range.lte)}
        </span>
      )}
      {unit !== undefined && (
        <span title={range.unit} data-unit-id={range.unit}>
          {range.gte !== undefined || range.lte !== undefined ? ' ' : ''}
          {unit}
        </span>
      )}
    </>
  );
}

function relationDescription(property: ReactNode, values: ReactNode, locale: string): ReactNode {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  const propertyToken = '\uE000property\uE001';
  const valuesToken = '\uE000values\uE001';
  const sentence = m.condition_relation_inverse({ property: propertyToken, values: valuesToken }, options);
  return sentence
    .split(/(\uE000property\uE001|\uE000values\uE001)/g)
    .map((part, index) =>
      part === propertyToken ? (
        <span key={index}>{property}</span>
      ) : part === valuesToken ? (
        <span key={index}>{values}</span>
      ) : (
        part
      ),
    );
}

function conceptDescription(scheme: ReactNode, match: string, locale: string): ReactNode {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  const schemeToken = '\uE000scheme\uE001';
  return m
    .condition_concept_predicate({ scheme: schemeToken, match }, options)
    .split(schemeToken)
    .flatMap((part, index) => (index === 0 ? [part] : [<span key={index}>{scheme}</span>, part]))
    .map((part, index) => (index === 0 ? ` (${part}` : part))
    .concat(')');
}

/** Labels enter by their meaning; statement values are admitted only for their property/value pair. */
export type PredicatePresentation = {
  property: (id: string) => ReactNode;
  catalogueType: (id: string) => ReactNode;
  discoveryType: (id: string) => ReactNode;
  value: (property: string, id: string) => ReactNode;
  conceptScheme: (id: string) => ReactNode;
};

function ownerDescription(owner: OwnerLeaf['owner'], locale: string): ReactNode {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  if ('presence' in owner) return m.search_context_owner_presence({}, options);
  if ('state' in owner) return m.search_context_owner_state({}, options);
  if ('label' in owner) return m.search_context_owner_label({}, options);
  if ('session' in owner) {
    switch (owner.session.lifecycle) {
      case 'active':
        return m.search_context_owner_session_active({}, options);
      case 'completed':
        return m.search_context_owner_session_completed({}, options);
      case 'abandoned':
        return m.search_context_owner_session_abandoned({}, options);
      default:
        return m.search_context_owner_unsupported({}, options);
    }
  }
  if ('holding' in owner) {
    const fields = [
      m.search_context_owner_holding_profile({}, options),
      ...(owner.holding.kind === undefined ? [] : [m.search_context_owner_holding_kind({}, options)]),
      ...(owner.holding.status === undefined ? [] : [m.search_context_owner_holding_status({}, options)]),
    ];
    return m.search_context_owner_holding({ fields: fields.join(', ') }, options);
  }
  return m.search_context_owner_unsupported({}, options);
}

/** Preserve the executed Boolean structure and same-statement qualifiers in the explanation. */
export function PredicateDescription({
  value,
  locale,
  presentation,
  unitText,
  saved,
  previewNodes,
}: {
  value: DiscoveryFilterDocument;
  locale: string;
  presentation: PredicatePresentation;
  unitText?: ((property: string, unit: string | undefined) => string | undefined) | undefined;
  saved?: ((id: string) => ReactNode) | undefined;
  previewNodes?: ReadonlySet<DiscoveryFilterDocument> | undefined;
}) {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  const shortened = <span>{m.condition_preset_shortened({}, options)}</span>;
  const terms = (ids: readonly string[], present: (id: string) => ReactNode) => (
    <>
      {(previewNodes ? ids.slice(0, 6) : ids).map((id, i) => (
        <span key={i}>
          {i > 0 && ', '}
          {present(id)}
        </span>
      ))}
      {previewNodes && ids.length > 6 && shortened}
    </>
  );
  const children = (nodes: readonly DiscoveryFilterDocument[]) => {
    const visible = previewNodes ? nodes.filter((node) => previewNodes.has(node)) : nodes;
    return (
      <ul>
        {visible.map((node, index) => (
          <li key={index}>
            <PredicateDescription
              value={node}
              locale={locale}
              presentation={presentation}
              unitText={unitText}
              saved={saved}
              previewNodes={previewNodes}
            />
          </li>
        ))}
        {visible.length < nodes.length && <li>{shortened}</li>}
      </ul>
    );
  };
  if ('and' in value)
    return (
      <>
        {m.condition_and({}, options)}
        {children(value.and)}
      </>
    );
  if ('or' in value)
    return (
      <>
        {m.condition_or({}, options)}
        {children(value.or)}
      </>
    );
  if ('not' in value)
    return (
      <>
        {m.condition_not({}, options)}
        {children([value.not])}
      </>
    );
  if ('saved' in value)
    return <>{saved ? saved(value.saved) : m.condition_saved_filter_label({ id: value.saved }, options)}</>;
  if ('statement' in value) {
    const statement = value.statement;
    const inverseDescription =
      'inverse' in statement && statement.inverse && 'in' in statement
        ? relationDescription(
            presentation.property(statement.property),
            terms(statement.in, (id) => presentation.value(statement.property, id)),
            locale,
          )
        : undefined;
    return (
      <>
        {presentation.property(statement.property)}:{' '}
        {'in' in statement
          ? terms(statement.in, (id) => presentation.value(statement.property, id))
          : rangeDescription(statement.range, locale, (unit) => unitText?.(statement.property, unit))}
        {inverseDescription ? <p>{inverseDescription}</p> : null}
        {'inverse' in statement && statement.inverse && !('in' in statement) ? ' ←' : null}
        {'in' in statement && statement.concept
          ? conceptDescription(
              presentation.conceptScheme(statement.concept.scheme),
              statement.concept.includeChildren
                ? m.condition_concept_descendants({}, options)
                : m.condition_concept_exact({}, options),
              locale,
            )
          : null}
        {(previewNodes ? statement.qualifiers?.slice(0, 2) : statement.qualifiers)?.map((qualifier, i) => (
          <p key={i}>
            {m.condition_qualifier({}, options)}: {presentation.property(qualifier.property)} ={' '}
            {terms(qualifier.in, (id) => presentation.value(qualifier.property, id))}
          </p>
        ))}
        {previewNodes && (statement.qualifiers?.length ?? 0) > 2 && shortened}
      </>
    );
  }
  if ('type' in value)
    return (
      <>
        {m.search_context_catalogue_type({}, options)} {terms(value.type.in, presentation.catalogueType)}
      </>
    );
  if ('kind' in value)
    return (
      <>
        {m.search_context_exact_type({}, options)} {terms(value.kind.in, presentation.discoveryType)}
      </>
    );
  if ('realm' in value) return <>{m.search_context_realm({ id: value.realm.id }, options)}</>;
  if ('ratingQuestion' in value)
    return <>{m.search_context_rating_question({ id: value.ratingQuestion.id }, options)}</>;
  if ('owner' in value) return <>{ownerDescription(value.owner, locale)}</>;
  return <>{m.search_context_owner_unsupported({}, options)}</>;
}
