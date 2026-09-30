package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class ReleaseCoveragePolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String RELEASE = "urn:probe:release", ENTRY = "urn:probe:entry";
    private static final String WORK = "urn:probe:work", HEAD = "urn:probe:head", PRIOR = "urn:probe:prior";
    private static final String RECEIPT = "urn:probe:receipt", V3 = "https://rezics.com/definition/release-v3";
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node literal(String value) { return NodeFactory.createLiteralString(value); }
    private static void iri(DatasetGraph data, String graph, String subject, String predicate, String object) {
        data.add(uri(graph), uri(subject), uri(RV + predicate), uri(object));
    }
    private static ModelMutationPolicy.Subject subject(String type, Map<String, Set<Node>> basis) {
        return new ModelMutationPolicy.Subject(uri(CommandPolicy.CURRENT),
            new CanonicalPolicy.Selection(RV + type, new ProfileRegistry.Route("release-v3", "urn:probe:shape", List.of()), Set.of()),
            Map.of(), Set.of(uri(RV + type)), basis);
    }

    @Test public void onlyFullyRemovedOwnedEntriesOfAnExactSuccessfulCasMayRetire() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            String current = CommandPolicy.CURRENT, revisions = CommandPolicy.REVISIONS, receipts = CommandPolicy.RECEIPTS;
            var before = new ModelMutationPolicy.Snapshot(Map.of(
                RELEASE, subject("Release", Map.of("releaseHead", Set.of(uri(PRIOR)), "work", Set.of(uri(WORK)),
                    "releaseKind", Set.of(literal("virtual")))),
                ENTRY, subject("ReleaseCoverage", Map.of())), Map.of());
            iri(data, current, RELEASE, "coverage", ENTRY);
            var coverage = ReleaseCoveragePolicy.capture(data, before);
            data.delete(uri(current), uri(RELEASE), uri(RV + "coverage"), uri(ENTRY));
            data.add(uri(current), uri(RELEASE), RDF.type.asNode(), uri(RV + "Release"));
            iri(data, current, RELEASE, "definitionProfile", V3);
            iri(data, current, RELEASE, "releaseHead", HEAD);
            iri(data, current, RELEASE, "work", WORK);
            data.add(uri(current), uri(RELEASE), uri(RV + "releaseKind"), literal("virtual"));
            iri(data, receipts, RECEIPT, "expectedHead", PRIOR);
            iri(data, receipts, RECEIPT, "release", RELEASE);
            iri(data, receipts, RECEIPT, "releaseRevision", HEAD);
            iri(data, receipts, RECEIPT, "work", WORK);
            data.add(uri(receipts), uri(RECEIPT), uri(RV + "admittedScope"), literal("work:edit:" + WORK));
            data.add(uri(receipts), uri(RECEIPT), uri(RV + "action"), literal("work.edit"));
            iri(data, receipts, RECEIPT, "outcome", RV + "Succeeded");
            iri(data, revisions, HEAD, "component", RELEASE);
            iri(data, revisions, HEAD, "predecessor", PRIOR);
            iri(data, revisions, HEAD, "modelRevision", V3);
            iri(data, revisions, HEAD, "shapeRevision", V3);
            iri(data, revisions, PRIOR, "component", RELEASE);
            Set<String> retired = ReleaseCoveragePolicy.retired(data, RECEIPT, before, coverage);
            assertEquals(Set.of(ENTRY), retired);
            assertEquals(Set.of(RELEASE), ReleaseCoveragePolicy.remaining(before, retired).current().keySet());
            // A receipt cannot authorize deletion of an entry absent from its release's prestate.
            assertTrue(ReleaseCoveragePolicy.retired(data, RECEIPT, before, Map.of(RELEASE, Set.of(uri("urn:probe:other")))).isEmpty());
            // Facts left behind, or any surviving dependency, require ordinary canonical validation.
            data.add(uri(current), uri(ENTRY), uri(RV + "portion"), literal("stale"));
            assertTrue(ReleaseCoveragePolicy.retired(data, RECEIPT, before, coverage).isEmpty());
            data.delete(uri(current), uri(ENTRY), uri(RV + "portion"), literal("stale"));
            for (String graph : List.of(current, revisions)) {
                iri(data, graph, "urn:probe:dependent", "coverage", ENTRY);
                assertTrue(ReleaseCoveragePolicy.retired(data, RECEIPT, before, coverage).isEmpty());
                data.delete(uri(graph), uri("urn:probe:dependent"), uri(RV + "coverage"), uri(ENTRY));
            }
            data.delete(uri(receipts), uri(RECEIPT), uri(RV + "outcome"), uri(RV + "Succeeded"));
            assertTrue(ReleaseCoveragePolicy.retired(data, RECEIPT, before, coverage).isEmpty());
            iri(data, receipts, RECEIPT, "outcome", RV + "Succeeded");
            data.delete(uri(receipts), uri(RECEIPT), uri(RV + "expectedHead"), uri(PRIOR));
            iri(data, receipts, RECEIPT, "expectedHead", "urn:probe:stale");
            assertTrue(ReleaseCoveragePolicy.retired(data, RECEIPT, before, coverage).isEmpty());
            data.delete(uri(receipts), uri(RECEIPT), uri(RV + "expectedHead"), uri("urn:probe:stale"));
            iri(data, receipts, RECEIPT, "expectedHead", PRIOR);
            iri(data, current, RELEASE, "work", "urn:probe:other-work");
            assertTrue(ReleaseCoveragePolicy.retired(data, RECEIPT, before, coverage).isEmpty());
        } finally { data.abort(); data.end(); }
    }
}
