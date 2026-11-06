import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  SettingsNavigationProvider,
  useSettingsNavigationDraft,
  useSettingsNavigationOwner,
} from './reading-navigation';
import { profileChanges } from './profile-data';
import type { ProfileAvatarUpload } from './profile-avatar-upload';
import type { ProfileEditor, ProfileEditorState } from './profile-write';
import { useSettingsProfileReturn } from './settings-return-context';

type UploadState = ReturnType<ProfileAvatarUpload['snapshot']>;
const noUpload = { phase: 'idle', url: null } as const;
const noSubscription = () => () => {};
const currentViewer = () => true;

/** The shared profile/view draft, original command and local image all belong to this mounted editor. */
export function profileNeedsNavigationDecision(state: ProfileEditorState, upload: UploadState = noUpload) {
  return (
    !!state.attempt ||
    (!!state.known && !!state.draft && Object.keys(profileChanges(state.known, state.draft)).length > 0) ||
    !!upload.url ||
    upload.phase === 'uploading' ||
    upload.phase === 'error'
  );
}

// A card lends its existing upload controller to the one navigation owner; it never clears a visible preview.
const UploadContext = createContext<((upload: ProfileAvatarUpload) => () => void) | null>(null);

export function useProfileNavigationUpload(upload: ProfileAvatarUpload) {
  const register = useContext(UploadContext);
  useLayoutEffect(() => register?.(upload), [register, upload]);
}

export function ProfileNavigation({
  editor,
  writable = true,
  isCurrent = currentViewer,
  children,
}: {
  editor: ProfileEditor;
  writable?: boolean;
  isCurrent?: () => boolean;
  children: ReactNode;
}) {
  const owner = useSettingsNavigationOwner();
  const content = (
    <ProfileNavigationRegistration editor={editor} writable={writable} isCurrent={isCurrent}>
      {children}
    </ProfileNavigationRegistration>
  );
  return owner ? content : <SettingsNavigationProvider>{content}</SettingsNavigationProvider>;
}

function ProfileNavigationRegistration({
  editor,
  writable,
  isCurrent,
  children,
}: {
  editor: ProfileEditor;
  writable: boolean;
  isCurrent: () => boolean;
  children: ReactNode;
}) {
  const navigation = useSettingsNavigationOwner();
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  useLayoutEffect(
    () =>
      editor.subscribe(() => {
        if (editor.isActive() && isCurrent()) return;
        // Cancel an outstanding departure before the dirty-state refresh could release its old destination.
        if (navigation?.blocked) navigation.stay();
        navigation?.refresh();
      }),
    [editor, isCurrent, navigation],
  );
  const [upload, setUpload] = useState<ProfileAvatarUpload | null>(null);
  const uploadState = useSyncExternalStore(
    upload?.subscribe ?? noSubscription,
    upload?.snapshot ?? (() => noUpload),
    () => noUpload,
  );
  const register = useCallback((controller: ProfileAvatarUpload) => {
    setUpload(controller);
    return () => setUpload((current) => (current === controller ? null : current));
  }, []);
  const needsDecision = writable && isCurrent() && profileNeedsNavigationDecision(state, uploadState);
  const shouldWarn = useCallback(
    () => writable && isCurrent() && profileNeedsNavigationDecision(editor.snapshot(), upload?.snapshot()),
    [editor, isCurrent, upload, writable],
  );
  useSettingsNavigationDraft('profile', needsDecision, shouldWarn, editor);
  const profileReturn = useSettingsProfileReturn();
  useLayoutEffect(() => {
    if (!profileReturn) return;
    return profileReturn.register(() => {
      if (!writable || !isCurrent()) return null;
      const captured = editor.captureReturn();
      return captured ? { ...captured, lastFocus: editor.lastFocus } : null;
    });
  }, [editor, isCurrent, profileReturn, writable]);
  useLayoutEffect(() => {
    if (!profileReturn?.snapshot || state.readAuthority !== 'allowed' || !state.known) return;
    profileReturn.consume(editor);
  }, [editor, profileReturn, state.known, state.readAuthority]);
  return <UploadContext.Provider value={register}>{children}</UploadContext.Provider>;
}
