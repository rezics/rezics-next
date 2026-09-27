'use client';

import { useShell } from '../../../../../features/shell/shell-provider.tsx';
import { WorkViewSkeleton } from '../../../../../features/work-page/work-states.tsx';

export default function Loading() {
  return <WorkViewSkeleton label={useShell().t.loading} />;
}
