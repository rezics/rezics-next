import type { DiscoveryFilterDocument, FilterRange } from '@rezics/filter';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';

export function rangeDescription(range: FilterRange): string {
  const end = (value: unknown) => (typeof value === 'object' ? JSON.stringify(value) : String(value));
  return [
    range.gte === undefined ? '' : `≥ ${end(range.gte)}`,
    range.lte === undefined ? '' : `≤ ${end(range.lte)}`,
    range.unit ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Preserve the executed Boolean structure and same-statement qualifiers in the explanation. */
export function PredicateDescription({
  value,
  locale,
  label,
}: {
  value: DiscoveryFilterDocument;
  locale: string;
  label: (id: string) => string;
}) {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  const child = (node: DiscoveryFilterDocument, index = 0) => (
    <li key={index}>
      <PredicateDescription value={node} locale={locale} label={label} />
    </li>
  );
  if ('and' in value)
    return (
      <>
        {m.condition_and({}, options)}
        <ul>{value.and.map(child)}</ul>
      </>
    );
  if ('or' in value)
    return (
      <>
        {m.condition_or({}, options)}
        <ul>{value.or.map(child)}</ul>
      </>
    );
  if ('not' in value)
    return (
      <>
        {m.condition_not({}, options)}
        <ul>{child(value.not)}</ul>
      </>
    );
  if ('saved' in value) return <>{m.condition_saved_filter_label({ id: value.saved }, options)}</>;
  if ('statement' in value) {
    const statement = value.statement;
    const inverseDescription =
      'inverse' in statement && statement.inverse
        ? m.condition_relation_inverse(
            {
              property: label(statement.property),
              values: new Intl.ListFormat(options.locale, { style: 'long', type: 'conjunction' }).format(
                statement.in.map(label),
              ),
            },
            options,
          )
        : undefined;
    return (
      <>
        {label(statement.property)}:{' '}
        {'in' in statement ? statement.in.map(label).join(', ') : rangeDescription(statement.range)}
        {inverseDescription ? <p>{inverseDescription}</p> : null}
        {'in' in statement && statement.concept
          ? ` (${statement.concept.scheme}${statement.concept.includeChildren ? ' + ↓' : ''})`
          : null}
        {statement.qualifiers?.map((qualifier, i) => (
          <p key={i}>
            {m.condition_qualifier({}, options)}: {label(qualifier.property)} = {qualifier.in.map(label).join(', ')}
          </p>
        ))}
      </>
    );
  }
  if ('type' in value) return <>{value.type.in.map(label).join(', ')}</>;
  if ('kind' in value) return <>{value.kind.in.map(label).join(', ')}</>;
  if ('realm' in value) return <>Realm: {value.realm.id}</>;
  if ('ratingQuestion' in value)
    return <>{m.search_context_rating_question({ id: value.ratingQuestion.id }, options)}</>;
  // Private owner operands were admitted by the native reader, never resolved through public index data.
  return <>{m.search_context_owner({}, options)}</>;
}
