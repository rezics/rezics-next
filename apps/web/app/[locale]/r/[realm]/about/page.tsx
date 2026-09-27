import { RealmAboutRoute, realmMetadata, type RealmRouteProps } from '../../../../../features/realm/routes.tsx';

export const generateMetadata = (props: RealmRouteProps) => realmMetadata(props, 'about');

export default function Page(props: RealmRouteProps) {
  return RealmAboutRoute(props);
}
