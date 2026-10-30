import { catalogueEntries } from './catalogue-entry';

export function SubjectChangesLink({ id, title, locale }: { id: string; title: string; locale: string }) {
  const entry = catalogueEntries.changes({ id, title, locale });
  return (
    <a className="text-sm text-primary underline underline-offset-4" href={entry.href}>
      {entry.label}
    </a>
  );
}
