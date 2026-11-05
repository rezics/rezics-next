import { createFileRoute } from '@tanstack/react-router';
import { StoryArcProfileSession } from '../../features/catalogue/story-arc-profile-session';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/story-arc')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    work: typeof input.work === 'string' ? input.work : undefined,
    realm: validatePageRealm(input.realm),
    classificationHandoff: classificationHandoffSearch(input),
  }),
  head: () => ({ meta: [{ title: m.story_arc_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: StoryArcRoute,
});
function StoryArcRoute() {
  const { work, realm, classificationHandoff } = Route.useSearch();
  return (
    <StoryArcProfileSession
      locale={getLocale()}
      work={work}
      realm={realm}
      {...(classificationHandoff ? { classificationHandoffToken: classificationHandoff } : {})}
    />
  );
}
