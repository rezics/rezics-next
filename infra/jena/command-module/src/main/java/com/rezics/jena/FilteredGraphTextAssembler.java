package com.rezics.jena;

import org.apache.jena.assembler.Assembler;
import org.apache.jena.assembler.Mode;
import org.apache.jena.query.text.TextIndex;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.query.text.assembler.TextIndexLuceneAssembler;
import org.apache.jena.rdf.model.Resource;

/** Uses the reviewed Jena Lucene assembler for the physical index, then swaps
 * only the graph-scoped read behavior. */
public final class FilteredGraphTextAssembler extends TextIndexLuceneAssembler {
    @Override public TextIndex open(Assembler assembler, Resource root, Mode mode) {
        TextIndex index = super.open(assembler, root, mode);
        if (!(index instanceof TextIndexLucene lucene))
            throw new IllegalStateException("Lucene text index is unavailable");
        return new FilteredGraphTextIndex(lucene);
    }
}
