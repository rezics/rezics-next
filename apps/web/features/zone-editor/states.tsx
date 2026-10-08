import { CloudOffIcon, LockIcon, SearchXIcon } from 'lucide-react';
import type { ReadFailure } from '../manage/types.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import type { ZoneEditorMessages } from './messages.ts';

const shown: Partial<Record<ReadFailure, 'denied' | 'missing' | 'unavailable'>> = {
  denied: 'denied', missing: 'missing', 'sign-in': 'denied', moved: 'unavailable', invalid: 'unavailable',
  budget: 'unavailable', unavailable: 'unavailable',
};

/** Why the editor has nothing to open. A hidden Zone and a missing one share the editor's refusal. */
export function ZoneAuthoringFailure({ failure, copy }: { failure: ReadFailure; copy: ZoneEditorMessages }) {
  const kind = shown[failure] ?? 'unavailable';
  const text = {
    denied: [copy.deniedTitle, copy.deniedBody, LockIcon],
    missing: [copy.missingTitle, copy.missingBody, SearchXIcon],
    unavailable: [copy.unavailableTitle, copy.unavailableBody, CloudOffIcon],
  } as const;
  const [title, description, icon] = text[kind];
  return <EmptyState icon={icon} title={title} description={description} tone={kind === 'denied' ? 'destructive' : 'default'} role="alert" />;
}
