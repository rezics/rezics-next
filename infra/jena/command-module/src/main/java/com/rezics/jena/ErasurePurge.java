package com.rezics.jena;

import java.nio.file.Files;
import java.nio.file.Path;
import java.math.BigInteger;
import java.util.HashSet;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.Dataset;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.vocabulary.RDF;

/** Offline, fail-closed copy of a TDB2 dataset excluding one exact revision and its body projections.
 * The source is opened read-only by procedure, never changed here. The caller must hold the owner lock,
 * prove a clean stop and keep the output unpublished until Lucene and retained-copy checks pass.
 */
public final class ErasurePurge {
    private static final Node RV_CONTENT_REVISION = uri("https://rezics.com/vocab/contentRevision");
    private static final Node RV_REVISION = uri("https://rezics.com/vocab/revision");
    private static final Node RV_PROJECTION = uri("https://rezics.com/vocab/projection");
    private static final Node RV_MATCH_UNIT = uri("https://rezics.com/vocab/matchUnit");
    private static final Node RV_PUBLICATION_DECISION = uri("https://rezics.com/vocab/publicationDecision");
    private static final Node MATCH_UNIT = uri("https://rezics.com/vocab/MatchUnit");
    private static final Node CONTENT_PROJECTION = uri("https://rezics.com/vocab/ContentProjection");
    private static final Node CONTENT_PRIVATE_PROJECTION = uri("https://rezics.com/vocab/ContentPrivateProjection");
    private static final Node PUBLIC_SEARCH = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node PRIVATE_SEARCH = uri(CommandPolicy.PRIVATE_SEARCH);
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node ERASED_REVISION = uri("https://rezics.com/vocab/ErasedRevision");
    private static final Node ERASURE_EPOCH = uri("https://rezics.com/vocab/erasureEpoch");

    private static Node uri(String value) { return NodeFactory.createURI(value); }

    private static void requireEmpty(Path destination) throws Exception {
        if (Files.exists(destination)) {
            try (var entries = Files.list(destination)) {
                if (entries.findAny().isPresent()) throw new IllegalArgumentException("destination is not empty");
            }
        }
    }

    private static void addDependents(DatasetGraph source, Set<Node> removed) {
        // Only typed Content projection nodes are evicted as whole subjects.
        // Other incoming references lose the exact edge, preserving unrelated facts.
        boolean changed;
        do {
            changed = false;
            var quads = source.find();
            while (quads.hasNext()) {
                Quad quad = quads.next();
                if (!removed.contains(quad.getObject()) || removed.contains(quad.getSubject())) continue;
                Node subject = quad.getSubject();
                Node graph = quad.getGraph();
                boolean projection = REVISIONS.equals(graph)
                    && (source.contains(graph, subject, RDF.type.asNode(), CONTENT_PROJECTION)
                        || source.contains(graph, subject, RDF.type.asNode(), CONTENT_PRIVATE_PROJECTION))
                    && Set.of(RV_CONTENT_REVISION, RV_MATCH_UNIT, RV_PUBLICATION_DECISION).contains(quad.getPredicate());
                boolean unit = (PUBLIC_SEARCH.equals(graph) || PRIVATE_SEARCH.equals(graph))
                    && source.contains(graph, subject, RDF.type.asNode(), MATCH_UNIT)
                    && Set.of(RV_REVISION, RV_PROJECTION, RV_PUBLICATION_DECISION).contains(quad.getPredicate());
                if (projection || unit) changed |= removed.add(subject);
            }
        } while (changed);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4 || !args[2].matches("urn:rezics:content:revision:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
            || !args[3].matches("[1-9][0-9]{0,18}"))
            throw new IllegalArgumentException("usage: ErasurePurge SOURCE_TDB2 EMPTY_DEST_TDB2 EXACT_IRI ERASURE_EPOCH");
        Path sourcePath = Path.of(args[0]).toRealPath();
        Path destinationPath = Path.of(args[1]).toAbsolutePath().normalize();
        if (sourcePath.equals(destinationPath) || destinationPath.startsWith(sourcePath)
            || sourcePath.startsWith(destinationPath)) throw new IllegalArgumentException("source and destination overlap");
        requireEmpty(destinationPath);
        Node target = uri(args[2]);
        Dataset source = TDB2Factory.connectDataset(sourcePath.toString());
        Dataset destination = TDB2Factory.connectDataset(destinationPath.toString());
        try {
            source.begin(ReadWrite.READ);
            destination.begin(ReadWrite.WRITE);
            try {
                DatasetGraph input = source.asDatasetGraph();
                DatasetGraph output = destination.asDatasetGraph();
                Set<Node> removed = new HashSet<>();
                removed.add(target);
                addDependents(input, removed);
                long retained = 0;
                long excluded = 0;
                var quads = input.find();
                while (quads.hasNext()) {
                    Quad quad = quads.next();
                    if (removed.contains(quad.getSubject()) || removed.contains(quad.getObject())) excluded++;
                    else { output.add(quad); retained++; }
                }
                if (excluded == 0) throw new IllegalArgumentException("target has no graph footprint");
                // Non-sensitive, exact identity and frontier survive compaction.
                // The product command gate rejects later inserts naming this IRI.
                output.add(REVISIONS, target, RDF.type.asNode(), ERASED_REVISION);
                output.add(REVISIONS, target, ERASURE_EPOCH, NodeFactory.createLiteralByValue(
                    new BigInteger(args[3]), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                destination.commit();
                System.out.println("retainedQuads=" + retained + " excludedQuads=" + excluded
                    + " excludedSubjects=" + removed.size());
            } finally {
                destination.end();
                source.end();
            }
        } finally {
            destination.close();
            source.close();
        }
    }

    private ErasurePurge() {}
}
