import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../../subject/subject-href';
import { m } from '../../../paraglide/messages.js';
import { isFileOrGroupType } from './model';
import type { Release } from '@rezics/definitions';

const fileTypes = ['schema:MediaObject', 'rezics:CatalogueFile', 'rezics:ReleaseGroup', 'wd:Q82753', 'wd:Q55327'];

function admittedFileType(
  type: string | undefined,
  release: Pick<Release, 'types' | 'properties'> | undefined,
): boolean {
  if (!type) return false;
  return release ? isFileOrGroupType(release, type) : fileTypes.includes(type);
}

export function CatalogueFileProfileEntry({
  id,
  type,
  label,
  locale,
  release,
}: {
  id?: string;
  type?: string;
  label?: string;
  locale: string;
  release?: Pick<Release, 'types' | 'properties'> | undefined;
}) {
  if (id) {
    if (!admittedFileType(type, release)) return null;
    return (
      <a
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
        href={`${subjectHref({ id, label: label ?? '' }, locale).href}/file`}
      >
        {m.catalogue_file_title({}, { locale: locale as never })}
      </a>
    );
  }
  if (type && !admittedFileType(type, release)) return null;
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={`/${locale}/catalogue/file`}>
      {m.catalogue_file_create_title({}, { locale: locale as never })}
    </a>
  );
}
