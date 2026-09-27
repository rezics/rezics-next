package com.rezics.jena;

import org.apache.jena.assembler.Assembler;
import org.apache.jena.query.text.TextQuery;
import org.apache.jena.rdf.model.ResourceFactory;

/** Offline Lucene rebuild with the same graph-filtered text assembler as Fuseki. */
public final class ErasureTextIndexer {
    public static void main(String[] args) {
        TextQuery.init();
        Assembler.general().implementWith(
            ResourceFactory.createResource("https://rezics.com/fuseki/FilteredGraphTextIndex"),
            new FilteredGraphTextAssembler());
        org.apache.jena.query.text.cmd.textindexer.main(args);
    }

    private ErasureTextIndexer() {}
}
