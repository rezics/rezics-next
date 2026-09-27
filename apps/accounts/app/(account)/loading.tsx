import { AccountShell } from '../../features/account/account-shell.tsx';
import { accountsConfig } from '../../features/config/env.ts';
import { SectionSkeleton } from '../../features/shell/skeletons.tsx';

export default function AccountLoading() {
  return <AccountShell webOrigin={accountsConfig().WEB_ORIGIN}><SectionSkeleton /></AccountShell>;
}
