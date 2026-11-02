import type { CollectionFilterParams } from './collection-filter-params';
import { collectionFilterAddress } from './collection-filter-params';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

/** The requested address and the complete accepted groups remain inspectable before correction. */
export function CollectionFilterAddressState({
  id,
  type,
  params,
  search,
}: {
  id: string;
  type: string;
  params: CollectionFilterParams;
  search: string;
}) {
  const issues = params.issues ?? [];
  const accepted = [
    ...Object.entries(params.selected).flatMap(([property, values]) => values.map((value) => [`f.${property}`, value])),
    ...Object.entries(params.ranges).map(([property, range]) => [
      `r.${property}`,
      `${range.from ?? ''},${range.to ?? ''}`,
    ]),
  ];
  if (!issues.length && !accepted.length) return null;
  const context = new URLSearchParams(search);
  const original = `/${getLocale()}/collections/${encodeURIComponent(id)}${search}`;
  return (
    <div className="min-w-0 space-y-2 break-words">
      {issues.length ? (
        <div role="alert">
          <p>{m.collection_filter_address_rejected()}</p>
          <ul>
            {issues.map(({ key, reason }) => (
              <li key={key}>
                <code>{key}</code>:{' '}
                {reason === 'limit'
                  ? m.collection_filter_address_limit()
                  : reason === 'ambiguous'
                    ? m.collection_filter_address_ambiguous()
                    : m.collection_filter_address_invalid()}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3 py-2">
            <a
              href={collectionFilterAddress(
                getLocale(),
                id,
                params.selected,
                params.ranges,
                params.selectedLabels,
                type,
                context,
              )}
            >
              {m.collection_filter_address_correct()}
            </a>
            <a href={collectionFilterAddress(getLocale(), id, {}, {}, {}, type, context)}>
              {m.collection_filter_clear()}
            </a>
          </div>
        </div>
      ) : null}
      <details>
        <summary>{m.collection_filter_address_inspect()}</summary>
        <a href={original}>{m.collection_filter_address_original()}</a>
        <pre className="whitespace-pre-wrap break-all">{search}</pre>
        <p>{m.collection_filter_address_accepted()}</p>
        <ul>
          {accepted.map(([key, value]) => (
            <li key={`${key}:${value}`}>
              <code>
                {key}={value}
              </code>
            </li>
          ))}
        </ul>
        {Object.keys(params.selectedLabels).length ? <p>{m.collection_filter_address_labels()}</p> : null}
      </details>
    </div>
  );
}
