-- Disposable physical candidates. RDF remains admission and field authority.
CREATE TABLE access.template_seek_checkpoint (
    epoch text PRIMARY KEY, instance text NOT NULL, cursor jsonb, complete boolean NOT NULL DEFAULT false
);
CREATE TABLE access.template_seek_entity (
    epoch text NOT NULL, graph text NOT NULL, id text COLLATE "C" NOT NULL,
    sequence numeric(20,0) NOT NULL, payload jsonb NOT NULL,
    PRIMARY KEY(epoch,graph,id)
);
CREATE TABLE access.template_seek_entry (
    epoch text NOT NULL, graph text NOT NULL, predicate text NOT NULL, anchor text NOT NULL,
    type text NOT NULL, key text COLLATE "C" NOT NULL, id text COLLATE "C" NOT NULL,
    external_key text,
    PRIMARY KEY(epoch,graph,predicate,anchor,type,key,id),
    FOREIGN KEY(epoch,graph,id) REFERENCES access.template_seek_entity(epoch,graph,id) ON DELETE CASCADE
);
CREATE INDEX template_seek_subject ON access.template_seek_entry(epoch,graph,id);
CREATE INDEX template_seek_credit_key ON access.template_seek_entry(epoch,anchor,external_key)
    WHERE type='https://rezics.com/vocab/AuthorCredit';
CREATE TABLE access.template_seek_basis (
    epoch text NOT NULL, graph text NOT NULL, predicate text NOT NULL, anchor text NOT NULL,
    type text NOT NULL, sequence numeric(20,0) NOT NULL,
    PRIMARY KEY(epoch,graph,predicate,anchor,type)
);
