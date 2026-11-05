import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../../subject/subject-href';
import { m } from '../../../paraglide/messages.js';
import { isFileOrGroupType } from './model';
import type { Release } from '@rezics/definitions';
import { catalogueFileCorrectionHref } from '../catalogue-file-reader/navigation';
import { catalogueFileCorrectionOriginParam, type CatalogueFileCorrectionOrigin } from './origin';

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
  origin,
}: {
  id?: string;
  type?: string;
  label?: string;
  locale: string;
  release?: Pick<Release, 'types' | 'properties'> | undefined;
  returnSourceId?: string | undefined;
  /** Exact current public reading intent; absent legacy callers open a named fresh Global visit. */
  origin?: CatalogueFileCorrectionOrigin | undefined;
}) {
  if (id) {
    if (!admittedFileType(type, release)) return null;
    const base = `${subjectHref({ id, label: label ?? '' }, locale).href}/file`;
    const correction = returnSourceId ? catalogueFileCorrectionHref(base, returnSourceId, locale) : base;
    const href = (() => {
      if (!correction) return;
      if (!origin) return correction;
      const url = new URL(correction, 'https://rezics.invalid');
      url.searchParams.set(
        'origin',
        catalogueFileCorrectionOriginParam(origin, locale, returnSourceId, id, type) ?? '!',
      );
      return `${url.pathname}${url.search}${url.hash}`;
    })();
    if (!href) return null;
    return (
      <a className={entryClass} href={href}>
        {origin
          ? m.catalogue_file_title({}, { locale: locale as never })
          : m.catalogue_file_global_correction_entry({}, { locale: locale as never })}
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
