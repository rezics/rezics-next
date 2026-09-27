'use client';

import { WorkDetailSkeleton } from '../../../features/work/work-states.tsx';
import { useShell } from '../../../features/shell/shell-provider.tsx';

export default function Loading() {
  return <WorkDetailSkeleton label={useShell().t.loading} />;
}
