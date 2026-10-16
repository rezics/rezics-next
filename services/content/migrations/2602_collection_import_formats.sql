-- Collection adapters share the existing private upload, row and job custody.
ALTER TABLE reader.library_import_file DROP CONSTRAINT library_import_file_format_check;
ALTER TABLE reader.library_import_file ADD CONSTRAINT library_import_file_format_check
  CHECK (format IN ('goodreads','storygraph','generic-csv','mal','vndb','rezics',
    'paprikarecipes','melarecipes','melarecipe'));
