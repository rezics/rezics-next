import { profileChanges, type ProfileValues } from '../../settings/ports/profile-editor';
import {
  ProfileEditor,
  profileFieldErrors,
  type ProfileEditorIO,
  type ProfileScope,
} from '../../settings/ports/profile-editor';

/** An approval belongs to this instance's exact viewer/target and visible, locked draft. */
export class AccountProfileEditor extends ProfileEditor {
  private confirmation: ProfileScope | null = null;
  private approvals = new Set<() => void>();
  confirmationSnapshot = () => this.confirmation;
  subscribeConfirmation = (listener: () => void) => {
    this.approvals.add(listener);
    return () => {
      this.approvals.delete(listener);
    };
  };
  constructor(io: ProfileEditorIO, initial: ProfileValues | null = null) {
    super(io, initial);
  }
  private announce(scope: ProfileScope | null) {
    this.confirmation = scope;
    this.approvals.forEach((listener) => listener());
  }
  override edit(patch: Partial<ProfileValues>) {
    if (!this.confirmation) super.edit(patch);
  }
  override async submit(scope: ProfileScope) {
    if (!this.canWrite()) return;
    const { known, draft, attempt, phase } = this.snapshot();
    if (!known || !draft || attempt || this.confirmation || ['saving', 'reloading', 'unavailable'].includes(phase))
      return;
    const after =
      scope === 'profile'
        ? {
            ...known,
            displayName: draft.displayName,
            biography: draft.biography,
            avatar: draft.avatar,
            links: draft.links,
          }
        : {
            ...known,
            publicViews: draft.publicViews,
            ...(known.kind === 'organization' ? { speakersListed: draft.speakersListed } : {}),
          };
    if (Object.keys(profileFieldErrors(after)).length || !Object.keys(profileChanges(known, after)).length) return;
    this.announce(scope);
  }
  cancelConfirmation = () => {
    this.announce(null);
  };
  async confirm() {
    const scope = this.confirmation;
    if (!scope) return;
    // Create the immutable command while the reviewed draft is still locked. Clearing
    // confirmation first would let a subscriber replace it before submit captures it.
    const pending = super.submit(scope);
    this.announce(null);
    await pending;
  }
  override retire() {
    super.retire();
    this.cancelConfirmation();
    this.approvals.clear();
  }
  override receive(current: ProfileValues) {
    this.cancelConfirmation();
    super.receive(current);
  }
  override async reload() {
    this.cancelConfirmation();
    await super.reload();
  }
}
