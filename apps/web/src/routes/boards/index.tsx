import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { BoardDirectory } from '../../threads/board-directory-view';
import { boardDirectoryQuery } from '../../threads/board-directory-read';
import {
  boardDirectoryPrevious,
  boardDirectoryRequest,
  type BoardDirectoryPrevious,
  type BoardDirectoryRequest,
} from '../../threads/board-directory';

export const Route = createFileRoute('/boards/')({
  validateSearch: (input: Record<string, unknown>) => {
    const { purpose, cursor } = boardDirectoryRequest(input);
    return { purpose, ...(cursor ? { cursor } : {}) };
  },
  loaderDeps: ({ search }) => boardDirectoryRequest(search),
  loader: ({ context, deps }) => context.queryClient.fetchQuery(boardDirectoryQuery(deps)),
  head: ({ match }) => pageHead({ title: m.board_directory_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <BoardDirectory request={boardDirectoryRequest(Route.useSearch())} result={{ state: 'loading' }} onRetry={() => {}} />,
  component: BoardDirectoryPage,
});

function BoardDirectoryPage() {
  const request = boardDirectoryRequest(Route.useSearch());
  const initial = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const query = useQuery(boardDirectoryQuery(request));
  const [previous, setPrevious] = useState<BoardDirectoryPrevious>();
  const result = query.isError ? { state: 'unavailable' as const } : query.data ?? initial;
  const onNavigate = (destination: BoardDirectoryRequest) => {
    setPrevious(boardDirectoryPrevious(request, result, destination));
    void navigate({ to: '/boards', search: { purpose: destination.purpose, ...(destination.cursor ? { cursor: destination.cursor } : {}) } });
  };
  return (
    <BoardDirectory
      request={request}
      result={query.isFetching ? { state: 'loading' } : result}
      {...(previous ? { previous } : {})}
      onNavigate={onNavigate}
      onRetry={() => { void query.refetch(); }}
    />
  );
}
