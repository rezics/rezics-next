import { authorSeparator, type CatalogueAuthor } from './work.ts';
import Link from '../shell/localized-link.tsx';

/** Credited names stay separate focus stops from the Work title and cover. */
export function AuthorNames({ authors }: { authors: readonly CatalogueAuthor[] }) {
  const separator = authorSeparator(authors.map(author => author.name));
  return <>{authors.map((author, index) => <span key={`${author.name}-${index}`}>
    {index ? separator : null}
    {author.href ? <Link href={author.href} className="rounded-sm outline-none decoration-1 underline-offset-2
      hover:underline focus-visible:ring-2 focus-visible:ring-ring">{author.name}</Link> : author.name}
  </span>)}</>;
}
