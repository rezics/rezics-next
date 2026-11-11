import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { ChoiceSelect } from '@rezics/ui/choice-select';
import { useId, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { ANILIST_ROWS, ANILIST_SCORE_FORMATS, ANILIST_UPLOAD_BYTES, type AniListScoreFormat } from './contract';
import { AniListAction } from './controls';
import { aniListScoreFormatLabel } from './meaning';

export function AniListUploadForm({
  busy,
  disabled,
  onUpload,
  onReopen,
}: {
  busy: boolean;
  disabled?: boolean;
  onUpload: (upload: string, scoreFormat: AniListScoreFormat | null) => void;
  onReopen?: (importId: string) => void;
}) {
  const inputId = useId();
  const helpId = useId();
  const formatId = useId();
  const attestId = useId();
  const scoreId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [scoreFormat, setScoreFormat] = useState<AniListScoreFormat | ''>('');
  const [retainedId, setRetainedId] = useState('');
  const retainedIdInput = useId();
  async function submit() {
    const file = input.current?.files?.[0];
    if (!file) {
      onUpload('', null);
      return;
    }
    if (file.size > ANILIST_UPLOAD_BYTES) {
      onUpload('', null);
      return;
    }
    onUpload(await file.text(), scoreFormat || null);
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p>{m.library_anilist_intro()}</p>
      <p id={attestId}>{m.library_anilist_attestation()}</p>
      <p>{m.library_anilist_whose_upload()}</p>
      <p>{m.library_anilist_not_official()}</p>
      <p>{m.library_anilist_not_account()}</p>
      <p id={formatId} className="text-sm text-muted-foreground">
        {m.library_anilist_dialect()}
      </p>
      <p id={helpId} className="text-sm text-muted-foreground">
        {m.library_anilist_guidance({ size: Math.floor(ANILIST_UPLOAD_BYTES / 1024), rows: ANILIST_ROWS })}
      </p>
      <Field>
        <FieldLabel id={`${scoreId}-label`} htmlFor={scoreId} className="min-h-11 items-center">
          {m.library_anilist_score_format()}
        </FieldLabel>
        <ChoiceSelect
          id={scoreId}
          ariaLabelledBy={`${scoreId}-label`}
          triggerDataAttributes={{ 'data-anilist-score-format': true }}
          triggerClassName="min-h-11 w-full max-w-full rounded-md border bg-background px-3"
          value={scoreFormat || null}
          disabled={busy || disabled}
          onValueChange={(value) => setScoreFormat((value ?? '') as AniListScoreFormat | '')}
          options={[
            { value: null, label: aniListScoreFormatLabel(null) },
            ...ANILIST_SCORE_FORMATS.map((format) => ({ value: format, label: aniListScoreFormatLabel(format) })),
          ]}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={inputId} className="min-h-11 items-center">
          {m.library_anilist_file_label()}
        </FieldLabel>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept="application/json,.json"
          aria-describedby={`${attestId} ${formatId} ${helpId}`}
          disabled={busy || disabled}
          className="min-h-11 w-full max-w-full text-sm file:me-3 file:min-h-11 file:rounded-md file:border file:px-3"
        />
      </Field>
      <AniListAction type="submit" disabled={busy || disabled} aria-busy={busy}>
        {busy ? m.library_anilist_uploading() : m.library_anilist_upload()}
      </AniListAction>
      {onReopen ? (
        <Field>
          <FieldLabel htmlFor={retainedIdInput}>{m.library_anilist_retained_id()}</FieldLabel>
          <input
            id={retainedIdInput}
            className="min-h-11 w-full rounded border px-3"
            value={retainedId}
            disabled={busy || disabled}
            onChange={(event) => setRetainedId(event.target.value)}
          />
          <AniListAction type="button" disabled={busy || disabled || !retainedId} onClick={() => onReopen(retainedId)}>
            {m.library_anilist_reopen()}
          </AniListAction>
        </Field>
      ) : null}
    </form>
  );
}
