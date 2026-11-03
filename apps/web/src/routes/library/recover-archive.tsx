import { createFileRoute } from '@tanstack/react-router';
import { setResponseHeader } from '@tanstack/react-start/server';
import { prepareExposure } from '../../kernel/exposure';
import { ArchiveEntryRecoveryPage } from '../../library/archive-entry-recovery';
import { archiveRecoveryAdmission } from '../../library/archive-entry-recovery/native';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/recover-archive')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  loader: () => {
    setResponseHeader('cache-control', 'private, no-store');
    return archiveRecoveryAdmission();
  },
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_archive_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ArchiveEntryRecoveryPage,
});
