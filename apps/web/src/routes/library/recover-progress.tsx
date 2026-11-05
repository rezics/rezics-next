import { createFileRoute } from '@tanstack/react-router';
import { prepareExposure } from '../../kernel/exposure';
import { ArchiveProgressRecoveryPage } from '../../library/archive-progress-recovery/page';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/recover-progress')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead(
      { title: m.library_archive_progress_title(), robots: 'noindex, nofollow' },
      pageHeadContext(match.pathname),
    ),
  component: ArchiveProgressRecoveryPage,
});
