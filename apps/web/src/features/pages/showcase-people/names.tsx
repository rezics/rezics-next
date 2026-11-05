import type { SubjectRead } from '@rezics/client';
import type { PageLink } from '../shared';
import { PeopleNamesEntry } from '../../catalogue/people-names/entry';

/** Keep the existing Person/Character mounting and its disclosed page/link adapter. */
export function SuppliedNames({
  reading,
}: {
  reading: { public: SubjectRead; locale: string; link?: PageLink; release?: object; reader?: object };
}) {
  return <PeopleNamesEntry reading={reading} />;
}
