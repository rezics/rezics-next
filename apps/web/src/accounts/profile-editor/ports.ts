import type { AccountSession } from '../../settings/ports/accounts';
import type { ProfileSaveResult } from '../../settings/ports/profile-editor';
import type { ProfilePage, Selection, Submission } from './data';

export interface ProfileSessionLease {
  isCurrent(): boolean;
  attach(retire: () => void): () => void;
}
export interface ProfileSessionObservation {
  session: AccountSession;
  observation: string;
  bind(viewerId: string, csrfToken: string): ProfileSessionLease;
}
/** Route composition supplies native IO and the browser session lifetime, independently of presentation. */
export interface AccountProfileRuntime {
  useSession(): ProfileSessionObservation;
  read(target: Selection, signal?: AbortSignal): Promise<ProfilePage>;
  save(submission: Submission, csrfToken: string, signal?: AbortSignal): Promise<ProfileSaveResult>;
}
