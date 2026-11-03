import { createFileRoute } from '@tanstack/react-router';
import { ScreenProfileSession } from '../../features/catalogue/screen-profile-session';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { screenSeriesId } from '../../features/catalogue/screen-episode-membership';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/screen')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    series: screenSeriesId(input.series),
    classificationHandoff: classificationHandoffSearch(input),
  }),
  head: () => ({ meta: [{ title: m.screen_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: ScreenRoute,
});
function ScreenRoute() {
  const { series, classificationHandoff } = Route.useSearch();
  return (
    <ScreenProfileSession
      key={`${series ?? ''}:${classificationHandoff ?? ''}`}
      locale={getLocale()}
      series={series}
      {...(classificationHandoff ? { classificationHandoffToken: classificationHandoff } : {})}
    />
  );
}
