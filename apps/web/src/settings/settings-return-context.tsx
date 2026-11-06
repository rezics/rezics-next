import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { captureProfileReturn, type ProfileReturnSnapshot } from './settings-return';
import type { ProfileEditor } from './profile-write';

export type SettingsSectionFocus = 'keyboard' | 'pointer' | null;

type ProfileReturnOwner = {
  register: (read: () => ProfileReturnSnapshot | null) => () => void;
  snapshot: ProfileReturnSnapshot | null;
  consume: (editor: ProfileEditor) => void;
  capture: () => ProfileReturnSnapshot | null;
};

const ProfileReturnContext = createContext<ProfileReturnOwner | null>(null);
const SectionFocusContext = createContext<SettingsSectionFocus>(null);

export function useSettingsProfileReturn() {
  return useContext(ProfileReturnContext);
}

export function useSettingsSectionFocus() {
  return useContext(SectionFocusContext);
}

export function SettingsReturnProvider({
  initialProfile,
  sectionFocus,
  children,
}: {
  initialProfile: ProfileReturnSnapshot | null;
  sectionFocus: SettingsSectionFocus;
  children: ReactNode;
}) {
  const reader = useRef<() => ProfileReturnSnapshot | null>(() => null);
  const [pending, setPending] = useState(initialProfile);
  const owner = useMemo<ProfileReturnOwner>(
    () => ({
      register: (read) => {
        reader.current = read;
        return () => {
          if (reader.current === read) reader.current = () => null;
        };
      },
      snapshot: pending,
      consume: (editor) => {
        if (!pending) return;
        editor.restoreReturn(pending);
        setPending(null);
      },
      capture: () => {
        const live = reader.current();
        if (!live) return null;
        return captureProfileReturn(live.known, live.draft, live.lastFocus);
      },
    }),
    [pending],
  );
  return (
    <ProfileReturnContext.Provider value={owner}>
      <SectionFocusContext.Provider value={sectionFocus}>{children}</SectionFocusContext.Provider>
    </ProfileReturnContext.Provider>
  );
}
