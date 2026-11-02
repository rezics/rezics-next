import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function CreateSubjectEntry({ locale }: { locale: string }) {
  const entry = catalogueEntries.create({ locale });
  return (
    <a
      href={entry.href}
      className={buttonVariants({
        variant: 'outline',
        size: 'sm',
        className:
          'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1',
      })}
    >
      {entry.label}
    </a>
  );
}
