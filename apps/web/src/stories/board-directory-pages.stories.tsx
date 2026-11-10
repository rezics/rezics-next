import type { Meta } from '@storybook/react-vite';
import pattern, * as directory from './board-directory.stories';

const meta = {
  title: 'Community/Board Directory Page',
  id: 'pages-community-board-directory',
  component: directory.DirectoryExample,
  parameters: pattern.parameters,
} satisfies Meta<typeof directory.DirectoryExample>;
export default meta;
export const Current = { ...directory.Current, args: { ...directory.Current.args, page: true } };
export const SelectPurpose = { ...directory.SelectPurpose, args: { ...directory.SelectPurpose.args, page: true } };
export const Continue = { ...directory.Continue, args: { ...directory.Continue.args, page: true } };
export const Open = { ...directory.Open, args: { page: true } };
export const Retry = { ...directory.Retry, args: { ...directory.Retry.args, page: true } };
export const Loading = { ...directory.Loading, args: { ...directory.Loading.args, page: true } };
export const Empty = { ...directory.Empty, args: { ...directory.Empty.args, page: true } };
export const Sparse = { ...directory.Sparse, args: { ...directory.Sparse.args, page: true } };
export const Unavailable = { ...directory.Unavailable, args: { ...directory.Unavailable.args, page: true } };
export const Denied = { ...directory.Denied, args: { ...directory.Denied.args, page: true } };
export const Closed = { ...directory.Closed, args: { ...directory.Closed.args, page: true } };
