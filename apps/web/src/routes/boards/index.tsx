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
  boardDirectorySearch,
  boardContribution,
  type BoardDirectoryPrevious,
  type BoardDirectoryRequest,
} from '../../threads/board-directory';

export const Route = createFileRoute('/boards/')({
  validateSearch: boardDirectorySearch,
  loaderDeps: ({ search }) => boardDirectoryRequest(search),
  loader: ({ context, deps }) => context.queryClient.fetchQuery(boardDirectoryQuery(deps)),
  head: ({ match }) =>
    pageHead({ title: m.board_directory_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: PendingBoardDirectory,
  component: BoardDirectoryPage,
});

function PendingBoardDirectory() {
  const search = Route.useSearch();
  const contribution = boardContribution(search);
  return (
    <BoardDirectory
      request={boardDirectoryRequest(search)}
      {...(contribution ? { contribution } : {})}
      result={{ state: 'loading' }}
      onRetry={() => {}}
    />
  );
}

function BoardDirectoryPage() {
  const search = Route.useSearch();
  const request = boardDirectoryRequest(search);
  const contribution = boardContribution(search);
  const initial = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const query = useQuery(boardDirectoryQuery(request));
  const [previous, setPrevious] = useState<BoardDirectoryPrevious>();
  const result = query.isError ? { state: 'unavailable' as const } : (query.data ?? initial);
  const onNavigate = (destination: BoardDirectoryRequest) => {
    setPrevious(boardDirectoryPrevious(request, result, destination, contribution));
    void navigate({
      to: '/boards',
      search: {
        purpose: destination.purpose,
        ...(destination.cursor ? { cursor: destination.cursor } : {}),
        ...contribution,
      },
    });
  };
  return (
    <BoardDirectory
      request={request}
      {...(contribution ? { contribution } : {})}
      result={query.isFetching ? { state: 'loading' } : result}
      {...(previous ? { previous } : {})}
      onNavigate={onNavigate}
      onRetry={() => {
        void query.refetch();
      }}
    />
  );
}
