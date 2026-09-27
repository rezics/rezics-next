import { RealmDecisionsRoute, realmMetadata, type RealmRouteProps } from '../../../../../features/realm/routes.tsx';

export const generateMetadata = (props: RealmRouteProps) => realmMetadata(props, 'decisions');

export default function Page(props: RealmRouteProps) {
  return RealmDecisionsRoute(props);
}
