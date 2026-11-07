import { ResourceAccessLink } from '../../accounts/resource-access/link';

/** Integration with the existing Accounts presentation; the link supplies no permission or management admission. */
export function CommunityResourceAccess({ resourceId }: { resourceId: string }) {
  return <ResourceAccessLink resourceId={resourceId} />;
}
