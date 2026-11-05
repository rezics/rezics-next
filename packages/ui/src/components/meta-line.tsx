import type { ReactNode } from 'react';

export type MetaItem = ReactNode | null | undefined | false;

/** Join optional text values with the metadata separator spacing for string-valued props. */
export function metaText(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ·\u00a0');
}

/** Render one inline metadata line. A break can occur before each separator, never after it. */
export function MetaLine({ items, className }: { items: readonly MetaItem[]; className?: string }) {
  const visible = items.filter((item) => item !== null && item !== undefined && item !== false && item !== '');
  return (
    <span className={className}>
      {visible.map((item, index) => (
        <span key={index}>
          {index > 0 ? (
            <>
              {' '}
              <span aria-hidden="true">·</span>
              {'\u00a0'}
            </>
          ) : null}
          {item}
        </span>
      ))}
    </span>
  );
}
