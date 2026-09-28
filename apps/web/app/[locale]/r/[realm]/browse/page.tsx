import { RealmBrowseRoute, realmMetadata, type RealmRouteProps } from '../../../../../features/realm/routes.tsx';

export const generateMetadata = (props: RealmRouteProps) => realmMetadata(props, 'browse');

export default function Page(props: RealmRouteProps) {
  return RealmBrowseRoute(props);
}
