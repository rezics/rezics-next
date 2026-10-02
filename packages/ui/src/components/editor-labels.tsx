export const richTextEditorLabels = {
  toolbar: 'Text formatting', blockType: 'Block type', paragraph: 'Paragraph', heading1: 'Heading 1', heading2: 'Heading 2', heading3: 'Heading 3',
  bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough', inlineCode: 'Inline code',
  link: 'Link', unlink: 'Remove link', bulletList: 'Bullet list', orderedList: 'Numbered list', taskList: 'Checklist',
  quote: 'Quote', codeBlock: 'Code block', horizontalRule: 'Divider', undo: 'Undo', redo: 'Redo',
  table: 'Insert table', image: 'Image', ruby: 'Ruby annotation', emphasis: 'Emphasis marks',
  apply: 'Apply', cancel: 'Cancel', remove: 'Remove', url: 'URL', imageAlt: 'Image description',
  annotation: 'Pronunciation', baseText: 'Base text', position: 'Position', over: 'Over', under: 'Under', interCharacter: 'Between characters',
  shape: 'Shape', dot: 'Dot', sesame: 'Sesame', circle: 'Circle', doubleCircle: 'Double circle', triangle: 'Triangle',
  fill: 'Fill', filled: 'Filled', open: 'Open', loading: 'Loading editor', unknownComponent: 'Embedded component',
  invalidUrl: 'Enter a web URL or a relative resource address.', addRow: 'Add row', addColumn: 'Add column', deleteRow: 'Delete row', deleteColumn: 'Delete column', deleteTable: 'Delete table',
  alignment: 'Alignment', left: 'Left', center: 'Center', right: 'Right', justify: 'Justify', insertBlock: 'Insert block',
  documentError: 'This change could not be saved. Undo it or reload the document.',
  spoiler: 'Spoiler', revealSpoiler: 'Reveal spoiler',
  formatting: 'Format text', moreFormatting: 'More formatting', advancedMode: 'Advanced tools', basicMode: 'Writing mode',
  turnInto: 'Turn into', clearFormatting: 'Clear formatting', cut: 'Cut', copy: 'Copy', pastePlain: 'Paste as plain text',
  slashHint: 'Type / to insert a block', slashEmpty: 'No matching blocks', openLink: 'Open link', editLink: 'Edit link', hideKeyboard: 'Hide keyboard',
} satisfies Record<string, string>;
export type RichTextEditorLabels = { [K in keyof typeof richTextEditorLabels]: string };
