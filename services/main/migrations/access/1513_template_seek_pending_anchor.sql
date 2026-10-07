-- Ordinary reconciliation seeks only a delta's natural anchor neighborhoods.
CREATE TABLE access.template_seek_pending_anchor (
    epoch text NOT NULL, anchor_key text NOT NULL,
    sequence numeric(20,0) NOT NULL, id text NOT NULL,
    PRIMARY KEY(epoch,anchor_key,sequence,id),
    FOREIGN KEY(epoch,sequence,id) REFERENCES access.template_seek_pending(epoch,sequence,id) ON DELETE CASCADE
);
