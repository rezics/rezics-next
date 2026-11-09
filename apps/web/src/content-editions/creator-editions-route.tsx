import { getRouteApi } from '@tanstack/react-router';
import { CreatorEditionsOriginView } from './creator-editions-view';

const Route = getRouteApi('/editions/');

export function CreatorEditionsRoute() {
  const { cursor } = Route.useSearch();
  return <CreatorEditionsOriginView page={Route.useLoaderData()} {...(cursor ? { cursor } : {})} />;
}
