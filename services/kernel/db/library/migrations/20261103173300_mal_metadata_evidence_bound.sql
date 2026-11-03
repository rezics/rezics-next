-- migrate:up
ALTER TABLE library.list_import_mal DROP CONSTRAINT list_import_mal_document_check;
ALTER TABLE library.list_import_mal
  ADD CONSTRAINT list_import_mal_document_check CHECK (octet_length(document::text) <= 50331648);
-- migrate:down
ALTER TABLE library.list_import_mal DROP CONSTRAINT list_import_mal_document_check;
ALTER TABLE library.list_import_mal
  ADD CONSTRAINT list_import_mal_document_check CHECK (octet_length(document::text) <= 12582912);
