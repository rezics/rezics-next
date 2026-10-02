import { RealmRulesRoute, realmMetadata, type RealmRouteProps } from '../../../../../features/realm/routes.tsx';
export const generateMetadata = (props: RealmRouteProps) => realmMetadata(props, 'rules');
export default function Page(props: RealmRouteProps) { return RealmRulesRoute(props); }
