import { RealmWorksRoute, realmMetadata, type RealmRouteProps } from '../../../../../features/realm/routes.tsx';

export const generateMetadata = (props: RealmRouteProps) => realmMetadata(props, 'works');

export default function Page(props: RealmRouteProps) {
  return RealmWorksRoute(props);
}
