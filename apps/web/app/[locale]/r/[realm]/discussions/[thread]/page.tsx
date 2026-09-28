import { RealmThreadRoute, realmThreadMetadata, type ThreadRouteProps } from '../../../../../../features/realm/thread-route.tsx';

export const generateMetadata = (props: ThreadRouteProps) => realmThreadMetadata(props);

export default function Page(props: ThreadRouteProps) {
  return RealmThreadRoute(props);
}
