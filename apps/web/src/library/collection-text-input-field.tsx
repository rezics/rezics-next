import { m } from '../paraglide/messages.js';
import { collectionTextIssue, collectionTextLimits, type CollectionTextField } from './collection-text-input';

type TextInput = { id: string; field: CollectionTextField; value: string | null; submitted: boolean };

export function collectionTextInputAttributes(input: TextInput) {
  const invalid = input.submitted && collectionTextIssue(input.field, input.value) !== null;
  return {
    'aria-invalid': invalid,
    'aria-describedby': `${input.id}-help${invalid ? ` ${input.id}-error` : ''}`,
  };
}

export function CollectionTextInputHelp(input: TextInput) {
  const issue = input.submitted ? collectionTextIssue(input.field, input.value) : null;
  const help = {
    title: m.library_collection_text_input_title_help,
    description: m.library_collection_text_input_description_help,
    note: m.library_collection_text_input_note_help,
  }[input.field];
  return (
    <>
      <p id={`${input.id}-help`} className="text-sm text-muted-foreground">
        {help()}
      </p>
      {issue ? (
        <p id={`${input.id}-error`} role="alert" className="text-sm text-destructive">
          {issue === 'required'
            ? m.library_collection_text_input_required()
            : issue === 'nul'
              ? m.library_collection_text_input_nul()
              : m.library_collection_text_input_limit({ limit: collectionTextLimits[input.field] })}
        </p>
      ) : null}
    </>
  );
}
