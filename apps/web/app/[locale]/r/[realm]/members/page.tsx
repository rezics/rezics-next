import { RealmMembersRoute, realmMetadata, type RealmRouteProps } from '../../../../../features/realm/routes.tsx';
export const generateMetadata = (props: RealmRouteProps) => realmMetadata(props, 'members');
export default function Page(props: RealmRouteProps) { return RealmMembersRoute(props); }
