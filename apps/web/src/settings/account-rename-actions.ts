import type { AccountRenameContext, AccountRenameReadResult } from './account-rename-data';
/** Server-projected navigation. The current read, rather than this DTO, supplies admission. */
export type AccountRenameNavigation = AccountRenameContext & { href?: string | null };
export type AccountRenameResult = AccountRenameReadResult<AccountRenameNavigation>;
