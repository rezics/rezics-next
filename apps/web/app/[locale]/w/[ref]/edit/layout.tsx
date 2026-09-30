import type { ReactNode } from 'react';
import { PageContainer } from '../../../../../features/shell/page.tsx';

// The edit pages sit beside the Work's hub, not inside it: they have their own frame and no Work tabs.
export default function EditLayout({ children }: { children: ReactNode }) {
  return <PageContainer className="grid gap-7 [text-autospace:normal]">{children}</PageContainer>;
}
