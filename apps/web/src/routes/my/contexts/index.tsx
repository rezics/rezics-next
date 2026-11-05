import { createFileRoute } from '@tanstack/react-router';
import { ContextSession } from '../../../features/contexts/session';
import { directoryInput } from '../../../features/contexts/model';

export const Route = createFileRoute('/my/contexts/')({
  validateSearch: directoryInput,
  component: ContextDirectoryRoute,
});
function ContextDirectoryRoute() {
  return <ContextSession mode="directory" input={directoryInput(Route.useSearch())} />;
}
