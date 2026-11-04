import type { DiscoveryFilterDocument, FilterRange } from '@rezics/filter';
import type { ReactNode } from 'react';
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
  saved,
  previewNodes,
}: {
  value: DiscoveryFilterDocument;
  locale: string;
  label: (id: string) => ReactNode;
  saved?: ((id: string) => ReactNode) | undefined;
  previewNodes?: ReadonlySet<DiscoveryFilterDocument> | undefined;
}) {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  const shortened = <span>{m.condition_preset_shortened({}, options)}</span>;
  const terms = (ids: readonly string[]) => (
    <>
      {(previewNodes ? ids.slice(0, 6) : ids).map((id, i) => (
        <span key={i}>
          {i > 0 && ', '}
          {label(id)}
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
              label={label}
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
    return (
      <>
        {label(statement.property)}: {'in' in statement ? terms(statement.in) : rangeDescription(statement.range)}
        {'inverse' in statement && statement.inverse ? ' ←' : null}
        {'in' in statement && statement.concept
          ? ` (${statement.concept.scheme}${statement.concept.includeChildren ? ' + ↓' : ''})`
          : null}
        {(previewNodes ? statement.qualifiers?.slice(0, 2) : statement.qualifiers)?.map((qualifier, i) => (
          <p key={i}>
            {m.condition_qualifier({}, options)}: {label(qualifier.property)} = {terms(qualifier.in)}
          </p>
        ))}
        {previewNodes && (statement.qualifiers?.length ?? 0) > 2 && shortened}
      </>
    );
  }
  if ('type' in value) return <>{terms(value.type.in)}</>;
  if ('kind' in value) return <>{terms(value.kind.in)}</>;
  if ('realm' in value) return <>Realm: {value.realm.id}</>;
  if ('ratingQuestion' in value)
    return <>{m.search_context_rating_question({ id: value.ratingQuestion.id }, options)}</>;
  // Private owner operands were admitted by the native reader, never resolved through public index data.
  return <>{m.search_context_owner({}, options)}</>;
}
