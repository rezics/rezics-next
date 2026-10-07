package org.apache.jena.query.text;

import org.apache.lucene.document.Document;

/** Package access to Jena's protected factory preserves its configured field
 * storage, language auxiliaries, analyzers and deletion checksums. */
public final class RezicsLuceneDocument {
    public static Document build(TextIndexLucene index, Entity entity) { return index.doc(entity); }
    private RezicsLuceneDocument() {}
}
