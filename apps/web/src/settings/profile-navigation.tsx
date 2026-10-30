import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useBlocker, type ShouldBlockFn } from '@tanstack/react-router';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../paraglide/messages.js';
import { profileChanges } from './profile-data';
import type { ProfileAvatarUpload } from './profile-avatar-upload';
import type { ProfileEditor, ProfileEditorState } from './profile-write';

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
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
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
  const returnFocus = useRef<HTMLElement | null>(null);
  const stay = useRef<HTMLButtonElement | null>(null);
  const pendingEditor = useRef<ProfileEditor | null>(null);
  const shouldBlockFn = useCallback<ShouldBlockFn>(
    ({ current, next }) => {
      // Hash/section links (and query changes on this page) keep the same editor mounted.
      if (current.pathname === next.pathname || !shouldWarn()) return false;
      pendingEditor.current = editor;
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return true;
    },
    [editor, shouldWarn],
  );
  const blocker = useBlocker({
    shouldBlockFn,
    withResolver: true,
    disabled: !needsDecision,
    enableBeforeUnload: shouldWarn,
  });
  const pending = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    pending.current = blocker.proceed;
    // A saved profile or session teardown must not leave a navigation waiting on private editor state.
    if (blocker.status === 'blocked' && (!needsDecision || pendingEditor.current !== editor)) blocker.proceed();
  }, [blocker, editor, needsDecision]);
  useLayoutEffect(() => () => pending.current?.(), []);

  return (
    <UploadContext.Provider value={register}>
      {children}
      <AlertDialog
        open={blocker.status === 'blocked' && pendingEditor.current === editor && needsDecision}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <AlertDialogContent
          initialFocus={stay}
          finalFocus={returnFocus}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{m.settings_profile_leave_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.settings_profile_leave_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stay} className="min-h-11" onClick={() => blocker.reset?.()}>
              {m.settings_profile_stay()}
            </AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={() => blocker.proceed?.()}>
              {m.settings_profile_leave()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UploadContext.Provider>
  );
}
