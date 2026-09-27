'use client';

import { useShell } from '../../../features/shell/shell-provider.tsx';
import { WorkSkeleton } from '../../../features/work-page/work-states.tsx';

export default function Loading() {
  return <WorkSkeleton label={useShell().t.loading} />;
}
