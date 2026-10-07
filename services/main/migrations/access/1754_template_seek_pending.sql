-- HTTP replies may arrive out of native commit order. Close each local gap
-- before advertising the newer anchor, without serializing unrelated reads.
CREATE TABLE access.template_seek_pending (
    epoch text NOT NULL, sequence numeric(20,0) NOT NULL, id text NOT NULL, delta jsonb NOT NULL,
    PRIMARY KEY(epoch,sequence,id)
);
