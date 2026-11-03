import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../../subject/subject-href';
import { m } from '../../../paraglide/messages.js';
import { isReleaseType } from './model';
import type { Release } from '@rezics/definitions';

export function ReleaseFidelityEntry({
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
  if (release && !isReleaseType(release, type)) return null;
  if (!release && !['bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656'].includes(type)) return null;
  return (
    <a
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
      href={`${subjectHref({ id, label }, locale).href}/release`}
    >
      {m.release_fidelity_title({}, { locale: locale as never })}
    </a>
  );
}
