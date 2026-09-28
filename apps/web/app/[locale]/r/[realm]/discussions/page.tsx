import { RealmDiscussionsRoute } from '../../../../../features/realm/discussions-route.tsx';
import { realmMetadata, type RealmRouteProps } from '../../../../../features/realm/routes.tsx';

export const generateMetadata = (props: RealmRouteProps) => realmMetadata(props, 'discussions');

export default function Page(props: RealmRouteProps) {
  return RealmDiscussionsRoute(props);
}
