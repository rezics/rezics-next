import { RealmHomeRoute, realmMetadata, type RealmRouteProps } from '../../../../features/realm/routes.tsx';

export const generateMetadata = (props: RealmRouteProps) => realmMetadata(props, 'home');

export default function Page(props: RealmRouteProps) {
  return RealmHomeRoute(props);
}
