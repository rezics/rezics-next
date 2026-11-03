import type { Meta } from '@storybook/react-vite';
import discussionBoard from '../kernel/recorded/board-realm.json';
import reviewBoards from '../kernel/recorded/realm-boards.json';
import reviewSubject from '../kernel/recorded/subject.json';
import { PageStory } from './page';

const reviewBoard = reviewBoards.items.find((board) => board.purpose === 'reviews')!;
const meta = { title: 'Pages/Threads/Composition destination', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;

export const Discussion = {
  render: () => <PageStory visitor="Signed In" path={`/boards/${discussionBoard.board.id}/new`} />,
};

export const Review = {
  render: () => (
    <PageStory
      visitor="Signed In"
      path={`/boards/${reviewBoard.id}/new?${new URLSearchParams({ subject: reviewSubject.subject.id, subjectTitle: 'Review subject' })}`}
    />
  ),
};
