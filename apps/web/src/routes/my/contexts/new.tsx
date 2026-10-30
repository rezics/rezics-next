import { createFileRoute } from '@tanstack/react-router';
import { ContextSession } from '../../../features/contexts/session';

export const Route = createFileRoute('/my/contexts/new')({ component: () => <ContextSession mode="create" /> });
