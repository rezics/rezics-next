package com.rezics.jena;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.junit.Test;

public class ReleaseCoverageUpgradeTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String RELEASE = "urn:probe:release";
    private static final String WORK = "urn:probe:work";
    private static final String HEAD = "urn:probe:head";
    private static final String PRIOR = "urn:probe:prior";
    private static final String RECEIPT = "urn:probe:receipt";
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static void iri(DatasetGraph data, String graph, String subject, String predicate, String object) {
        data.add(uri(graph), uri(subject), uri(RV + predicate), uri(object));
    }
    private static void literal(DatasetGraph data, String graph, String subject, String predicate, String value) {
        data.add(uri(graph), uri(subject), uri(RV + predicate), NodeFactory.createLiteralString(value));
    }

    @Test public void onlyAnExactSuccessfulReleaseCasMayUpgradeV1OrV2ToV3() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            String current = CommandPolicy.CURRENT, revisions = CommandPolicy.REVISIONS, receipts = CommandPolicy.RECEIPTS;
            String v3 = "https://rezics.com/definition/release-v3";
            iri(data, current, RELEASE, "definitionProfile", v3);
            iri(data, current, RELEASE, "releaseHead", HEAD);
            iri(data, current, RELEASE, "work", WORK);
            literal(data, current, RELEASE, "releaseKind", "formal");
            iri(data, receipts, RECEIPT, "expectedHead", PRIOR);
            iri(data, receipts, RECEIPT, "release", RELEASE);
            iri(data, receipts, RECEIPT, "releaseRevision", HEAD);
            iri(data, receipts, RECEIPT, "work", WORK);
            literal(data, receipts, RECEIPT, "admittedScope", "work:edit:" + WORK);
            literal(data, receipts, RECEIPT, "action", "work.edit");
            iri(data, receipts, RECEIPT, "outcome", RV + "Succeeded");
            iri(data, revisions, HEAD, "component", RELEASE);
            iri(data, revisions, HEAD, "predecessor", PRIOR);
            iri(data, revisions, HEAD, "modelRevision", v3);
            iri(data, revisions, HEAD, "shapeRevision", v3);
            iri(data, revisions, PRIOR, "component", RELEASE);
            for (String profile : List.of("release-v1", "release-v2")) {
                var route = new ProfileRegistry.Route(profile, "urn:probe:shape", List.of());
                var before = new ModelMutationPolicy.Subject(uri(current),
                    new CanonicalPolicy.Selection(RV + "Release", route, Set.of()), Map.of(), Set.of(uri(RV + "Release")),
                    Map.of("releaseHead", Set.of(uri(PRIOR)), "work", Set.of(uri(WORK)),
                        "releaseKind", Set.of(NodeFactory.createLiteralString("formal"))));
                assertTrue(ModelMutationPolicy.releaseCoverageUpgrade(data, RECEIPT, RELEASE, before));
                data.delete(uri(receipts), uri(RECEIPT), uri(RV + "outcome"), uri(RV + "Succeeded"));
                assertFalse(ModelMutationPolicy.releaseCoverageUpgrade(data, RECEIPT, RELEASE, before));
                iri(data, receipts, RECEIPT, "outcome", RV + "Succeeded");
                data.delete(uri(receipts), uri(RECEIPT), uri(RV + "expectedHead"), uri(PRIOR));
                iri(data, receipts, RECEIPT, "expectedHead", "urn:probe:wrong-basis");
                assertFalse(ModelMutationPolicy.releaseCoverageUpgrade(data, RECEIPT, RELEASE, before));
                data.delete(uri(receipts), uri(RECEIPT), uri(RV + "expectedHead"), uri("urn:probe:wrong-basis"));
                iri(data, receipts, RECEIPT, "expectedHead", PRIOR);
                iri(data, current, RELEASE, "work", "urn:probe:other-work");
                assertFalse(ModelMutationPolicy.releaseCoverageUpgrade(data, RECEIPT, RELEASE, before));
                data.delete(uri(current), uri(RELEASE), uri(RV + "work"), uri("urn:probe:other-work"));
                data.delete(uri(current), uri(RELEASE), uri(RV + "definitionProfile"), uri(v3));
                iri(data, current, RELEASE, "definitionProfile", "https://rezics.com/definition/release-v2");
                assertFalse(ModelMutationPolicy.releaseCoverageUpgrade(data, RECEIPT, RELEASE, before));
                data.delete(uri(current), uri(RELEASE), uri(RV + "definitionProfile"), uri("https://rezics.com/definition/release-v2"));
                iri(data, current, RELEASE, "definitionProfile", v3);
            }
        } finally { data.abort(); data.end(); }
    }
}
