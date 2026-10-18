'use client';
import { SearchField } from '../../../apps/web/features/shell/search-field.tsx';
import { ShellProvider } from '../../../apps/web/features/shell/shell-provider.tsx';
import { messages } from '../../../apps/web/features/shell/messages.ts';
import { SidebarProvider, SidebarTrigger } from '../../../packages/ui/src/components/sidebar.tsx';

export function NativeOwners({ act, children }: any) {
  return <ShellProvider locale="en" messages={messages} initialTheme="light" initialCollapsed={false}>
    <SidebarProvider style={{ minHeight: 0 }} onOpenChange={() => act('sidebar')}>
      <div className="w-full" onFocus={event => {
        if ((event.target as HTMLElement).getAttribute('type') === 'search') act('search');
      }}>
        <SearchField />
        <SidebarTrigger aria-label="Toggle sidebar" />
        {children}
      </div>
    </SidebarProvider>
  </ShellProvider>;
}
