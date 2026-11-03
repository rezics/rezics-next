import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../../subject/subject-href';
import { m } from '../../../paraglide/messages.js';
import { isFileOrGroupType } from './model';
import type { Release } from '@rezics/definitions';

export function CatalogueFileProfileEntry({
  id,
  type,
  label,
  locale,
  release,
}: {
  id: string;
  type: string;
  label: string;
  locale: string;
  release?: Pick<Release, 'types' | 'properties'> | undefined;
}) {
  if (release ? !isFileOrGroupType(release, type) : !['schema:MediaObject', 'rezics:CatalogueFile', 'rezics:ReleaseGroup', 'wd:Q82753', 'wd:Q55327'].includes(type))
    return null;
  return (
    <a
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
      href={`${subjectHref({ id, label }, locale).href}/file`}
    >
      {m.catalogue_file_title({}, { locale: locale as never })}
    </a>
  );
}
