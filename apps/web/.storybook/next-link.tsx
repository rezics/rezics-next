// `next/link` in stories: a plain anchor, since there is no router to prefetch with.
import type { ComponentProps } from 'react';

export default function Link({ href, prefetch: _prefetch, replace: _replace, scroll: _scroll, ...props }:
  Omit<ComponentProps<'a'>, 'href'> & { href: string; prefetch?: boolean; replace?: boolean; scroll?: boolean }) {
  return <a href={href} {...props} />;
}
