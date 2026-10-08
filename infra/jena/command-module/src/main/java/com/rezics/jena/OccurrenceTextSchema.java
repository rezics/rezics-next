package com.rezics.jena;

import java.io.IOException;
import java.util.UUID;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexException;
import org.apache.jena.query.text.changes.TextQuadAction;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.lucene.document.FieldType;
import org.apache.lucene.document.TextField;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.FieldInfos;

/** One physical definition for live projection, update and offline indexing. */
final class OccurrenceTextSchema {
    static final String FIELD = "occurrenceLabel", PAYLOAD = "occurrencePayload", ORDER = "occurrenceOrder";
    static final FieldType TYPE = TextField.TYPE_NOT_STORED;
    static final long REBUILD_DEADLINE_MS = 600_000;

    static boolean incompatible(FilteredGraphTextIndex index) {
        try (var reader = DirectoryReader.open(index.lucene().getIndexWriter())) {
            var fields = FieldInfos.getMergedFieldInfos(reader);
            var labels = fields.fieldInfo(FIELD);
            var order = fields.fieldInfo(ORDER);
            return index.rankMetadataMissing() || labels != null && (labels.getIndexOptions() != TYPE.indexOptions()
                || labels.omitsNorms() != TYPE.omitNorms() || fields.fieldInfo(PAYLOAD) == null
                || order == null || order.getDocValuesType() != org.apache.lucene.index.DocValuesType.SORTED);
        } catch (IOException error) { throw new TextIndexException("occurrence schema inspection failed", error); }
    }

    /** Before HTTP traffic, replace a legacy/conflicting generation from its
     * authoritative RDF. Lucene 10 requires a fresh field registry (deleteAll),
     * so replay every mapped field, not just occurrence documents. Streaming
     * O(indexed quads), constant retained memory, one writer transaction. Jena's
     * abort restores both owners on failure; the entrypoint's unclean-stop
     * marker still fences crash uncertainty and is never cleared here.
     * https://github.com/apache/lucene/blob/releases/lucene/10.3.1/lucene/core/src/java/org/apache/lucene/index/IndexWriter.java
     */
    static boolean rebuildIfIncompatible(DatasetGraph source) {
        return rebuildIfIncompatible(source, System.nanoTime() + REBUILD_DEADLINE_MS * 1_000_000L);
    }
    static boolean rebuildIfIncompatible(DatasetGraph source, long deadline) {
        if (!(source instanceof org.apache.jena.query.text.DatasetGraphText data)
            || !(data.getTextIndex() instanceof FilteredGraphTextIndex index)) return false;
        index.bindRankData(data);
        if (!incompatible(index)) return false;
        data.begin(ReadWrite.WRITE);
        var producer = new TextDocProducerTriples(index);
        producer.start();
        try {
            index.lucene().getIndexWriter().deleteAll();
            for (String field : java.util.Set.copyOf(index.getDocDef().fields())) for (var predicate : index.getDocDef().getPredicates(field)) {
                var rows = data.find(org.apache.jena.graph.Node.ANY, org.apache.jena.graph.Node.ANY,
                    predicate, org.apache.jena.graph.Node.ANY);
                try { while (rows.hasNext()) {
                    if (System.nanoTime() >= deadline) throw new IllegalStateException(
                        "occurrence schema rebuild exceeded 600 seconds; run task search:rebuild with writers stopped");
                    var quad = rows.next();
                    producer.change(TextQuadAction.ADD, quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject());
                } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            }
            var generation = OccurrenceLabelIndex.textGeneration(data);
            if (generation != null) {
                var control = OccurrenceLabelIndex.uri(CommandPolicy.CONTROL);
                var product = OccurrenceLabelIndex.uri("urn:rezics:dataset:product");
                var predicate = OccurrenceLabelIndex.p("textIndexGeneration");
                data.deleteAny(control, product, predicate, org.apache.jena.graph.Node.ANY);
                data.add(control, product, predicate, NodeFactory.createURI("urn:rezics:text-index-generation:" + UUID.randomUUID()));
            }
            CommitHalt.commit(data);
            return true;
        } catch (IOException error) { throw new TextIndexException("occurrence schema rebuild failed", error); }
        finally { producer.finish(); data.end(); }
    }

    private OccurrenceTextSchema() {}
}
