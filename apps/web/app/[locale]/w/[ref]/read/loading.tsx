'use client';

import { useShell } from '../../../../../features/shell/shell-provider.tsx';
import { ChapterSkeleton } from '../../../../../features/work-page/work-states.tsx';

export default function Loading() {
  return <ChapterSkeleton label={useShell().t.loading} />;
}
