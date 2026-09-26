package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class ModelMutationPolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String ITEM = "urn:probe:item";
    private static final ProfileRegistry PROFILES = ProfileRegistry.load(
        Path.of("src/test/resources/registry-probe"));

    private static Node uri(String value) { return NodeFactory.createURI(value); }

    private static CommandPolicy.Plan plan() {
        return new CommandPolicy.Plan(null, Set.of(CommandPolicy.CURRENT), Set.of(ITEM),
            Set.of(), Set.of(), false, false, true);
    }

    private static DatasetGraph data() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        data.add(uri(CommandPolicy.CURRENT), uri(ITEM), RDF.type.asNode(), uri(RV + "RegistryProbe"));
        data.add(uri(CommandPolicy.CURRENT), uri(ITEM), uri(RV + "probeLabel"),
            NodeFactory.createLiteralString("probe"));
        return data;
    }

    private static String report(Map<String, Object> result) {
        assertEquals("invalid", result.get("status"));
        return String.valueOf(result.get("report"));
    }

    @Test public void model15PrestateRouteCannotFallThroughAfterSelectorDeletion() {
        DatasetGraph data = data();
        try {
            Node state = uri(RV + "probeState");
            data.add(uri(CommandPolicy.CURRENT), uri(ITEM), state, uri(RV + "Sealed"));
            data.add(uri(CommandPolicy.CURRENT), uri(ITEM), uri(RV + "sealedBy"), uri("urn:probe:actor"));
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(PROFILES, data, plan());
            data.delete(uri(CommandPolicy.CURRENT), uri(ITEM), state, uri(RV + "Sealed"));
            assertEquals("prestate canonical selector changed: " + ITEM,
                report(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    @Test public void model16ReverseDependentsHaveAnExplicitBound() {
        DatasetGraph data = data();
        try {
            for (int i = 0; i < 4; i++) addDependent(data, i);
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(PROFILES, data, plan());
            assertNull(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before));
            for (int i = 4; i < 257; i++) addDependent(data, i);
            assertEquals("reverse dependency footprint exceeds 256",
                report(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    @Test public void model16UnknownHistoricalParentRejectsAChildTypeChange() {
        DatasetGraph data = data();
        try {
            Node secondary = uri(RV + "RegistryProbeRecord");
            Node parent = uri("urn:probe:historical-parent");
            data.add(uri(CommandPolicy.CURRENT), uri(ITEM), RDF.type.asNode(), secondary);
            data.add(uri(CommandPolicy.REVISIONS), parent, RDF.type.asNode(), uri(RV + "RevisionAnchor"));
            data.add(uri(CommandPolicy.REVISIONS), parent, uri(RV + "item"), uri(ITEM));
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(PROFILES, data, plan());
            data.delete(uri(CommandPolicy.CURRENT), uri(ITEM), RDF.type.asNode(), secondary);
            assertEquals("uncanonical reverse revision dependency requires staged lifecycle: " + parent.getURI(),
                report(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    private static void addDependent(DatasetGraph data, int index) {
        Node record = uri("urn:probe:record:" + index);
        data.add(uri(CommandPolicy.REVISIONS), record, RDF.type.asNode(), uri(RV + "RegistryProbeRecord"));
        data.add(uri(CommandPolicy.REVISIONS), record, uri(RV + "item"), uri(ITEM));
    }
}
