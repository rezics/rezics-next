import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CandidateStory } from './candidate-story';
import { m } from '../paraglide/messages.js';
import { candidateProperty } from '../kernel/fake/subject-candidates';

const meta = { title: 'Patterns/Subject Candidate Review', component: CandidateStory,
  parameters: { layout: 'fullscreen' } } satisfies Meta<typeof CandidateStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function candidates(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.candidate_entry() }));
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.candidate_field() }), candidateProperty);
  await canvas.findByRole('button', { name: m.candidate_review() });
  return canvas;
}
async function review(canvasElement: HTMLElement) {
  const canvas = await candidates(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_review() }));
  expect(canvas.getByRole('heading', { name: m.candidate_current() })).toBeTruthy();
  expect(canvas.getByRole('heading', { name: m.candidate_proposed() })).toBeTruthy();
  expect(canvas.getByText('CC0-1.0', { exact: false })).toBeTruthy();
  return canvas;
}
async function confirmation(canvasElement: HTMLElement) {
  const canvas = await review(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
  await canvas.findByRole('heading', { name: m.candidate_confirm_title({ action: m.candidate_accept() }) });
  return canvas;
}
async function adopt(canvasElement: HTMLElement) {
  const canvas = await confirmation(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
  await canvas.findByText(m.candidate_accepted());
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
  await userEvent.click(await canvas.findByRole('button', { name: m.candidate_review() }));
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_adopt() }));
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_adopt() }));
  return canvas;
}

export const Entry: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  expect(canvas.getByRole('button', { name: m.candidate_entry() })).toBeTruthy();
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
  await canvas.findByRole('combobox', { name: m.candidate_field() });
} };
export const Candidates: Story = { play: async ({ canvasElement }) => { await candidates(canvasElement); } };
export const Review: Story = { play: async ({ canvasElement }) => { await review(canvasElement); } };
export const Confirmation: Story = { play: async ({ canvasElement }) => { await confirmation(canvasElement); } };
export const Pending: Story = { args: { scenario: 'pending' }, play: async ({ canvasElement }) => {
  const canvas = await adopt(canvasElement);
  await canvas.findByText(m.candidate_pending());
  expect(canvas.queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
} };
export const Selected: Story = { play: async ({ canvasElement }) => {
  const canvas = await adopt(canvasElement);
  const link = await canvas.findByRole('link', { name: m.candidate_view_public() });
  expect(link.getAttribute('href')).toContain('/subjects/');
} };
export const StaleConflict: Story = { args: { scenario: 'stale' }, play: async ({ canvasElement }) => {
  const canvas = await confirmation(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
  await canvas.findByText(m.candidate_stale());
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
  await canvas.findByRole('button', { name: m.candidate_review() });
} };
export const Denied: Story = { args: { scenario: 'denied' }, play: async ({ canvasElement }) => {
  const canvas = await confirmation(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
  await canvas.findByText(m.candidate_denied());
  expect(canvas.queryByRole('heading', { name: m.candidate_proposed() })).toBeNull();
} };
export const Unavailable: Story = { args: { scenario: 'unavailable' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.candidate_field() }), candidateProperty);
  await canvas.findByText(m.candidate_unavailable());
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
  await canvas.findByText(m.candidate_unavailable());
} };
