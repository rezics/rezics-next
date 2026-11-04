import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../../subject/subject-href';
import { m } from '../../../paraglide/messages.js';
import { isFileOrGroupType } from './model';
import type { Release } from '@rezics/definitions';
import { catalogueFileCorrectionHref } from '../catalogue-file-reader/navigation';

const entryClass = `${buttonVariants({ variant: 'outline', size: 'sm' })} h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8`;

function admittedFileType(
  type: string | undefined,
  release: Pick<Release, 'types' | 'properties'> | undefined,
): boolean {
  if (!type) return false;
  return !!release && isFileOrGroupType(release, type);
}

export function CatalogueFileProfileEntry({
  id,
  type,
  label,
  locale,
  release,
  returnSourceId,
}: {
  id?: string;
  type?: string;
  label?: string;
  locale: string;
  release?: Pick<Release, 'types' | 'properties'> | undefined;
  returnSourceId?: string | undefined;
}) {
  if (id) {
    if (!admittedFileType(type, release)) return null;
    const base = `${subjectHref({ id, label: label ?? '' }, locale).href}/file`;
    const href = returnSourceId ? catalogueFileCorrectionHref(base, returnSourceId, locale) : base;
    if (!href) return null;
    return (
      <a className={entryClass} href={href}>
        {m.catalogue_file_title({}, { locale: locale as never })}
      </a>
    );
  }
  if (type && !admittedFileType(type, release)) return null;
  return (
    <a className={entryClass} href={`/${locale}/catalogue/file`}>
      {m.catalogue_file_create_title({}, { locale: locale as never })}
    </a>
  );
}
