import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { pageReady, pagePaths, PageStory } from './page';

const meta = { title: 'Pages/Subject Sources', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function sourcePath(fixture: 'all' | 'empty') {
  return `${pagePaths.subject}?sourceRecords=${fixture}`;
}

export const AllSourceRecordFields: Story = {
  name: 'All source record fields',
  render: () => <PageStory visitor="Signed Out" path={sourcePath('all')} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const section = await canvas.findByRole('region', { name: 'Sources' });
    const sources = within(section);
    const records: [string, string][] = [
      ['Open Library Catalogue', 'https://openlibrary.org/works/OL45883W'],
      ['Library of Congress Catalogue', 'https://id.loc.gov/authorities/names/n79095566'],
      ['Exhibition notes', 'https://museum.example.test/exhibitions/prince'],
      ['Publisher bibliography', 'https://publisher.example.test/books/prince'],
      ['Matching statement reference', 'https://archive.example.test/little-prince'],
      [
        'A Long Catalogue Name That Wraps Across Several Lines on a Narrow Phone Screen',
        'https://catalogue.example.test/records/little-prince',
      ],
    ];
    expect(section.querySelectorAll('li').length).toBe(7);
    for (const [name, address] of records) {
      const link = sources.getByRole('link', { name });
      expect(link.getAttribute('href')).toBe(address);
    }
    expect(sources.getByRole('link', { name: 'CC-BY-4.0' }).getAttribute('href')).toBe(
      'https://creativecommons.org/licenses/by/4.0/',
    );
    expect(sources.getByText('ODbL-1.0', { exact: true })).toBeTruthy();
    expect(sources.getByText('Open Library contributors')).toBeTruthy();
    expect(sources.getByText('The Museum Research Team')).toBeTruthy();
    await expect(
      sources.getByText(
        'Catalogue editors, volunteer proofreaders, translators, and local librarians who checked this record against the original publication in several editions.',
      ),
    ).toBeTruthy();
    expect(sources.queryByRole('link', { name: 'https://archive.example.test/little-prince' })).toBeNull();
  },
};

export const NoSourceRecords: Story = {
  name: 'No source records',
  render: () => <PageStory visitor="Signed Out" path={sourcePath('empty')} />,
  play: async (context) => {
    await pageReady(context);
    const region = await within(context.canvasElement).findByRole('region', { name: 'Sources' });
    const section = within(region);
    expect(section.getAllByRole('listitem').length).toBe(1);
    expect(section.getByText('© REZICS fixtures')).toBeTruthy();
    expect(section.queryByRole('link', { name: 'Open Library Catalogue' })).toBeNull();
  },
};
