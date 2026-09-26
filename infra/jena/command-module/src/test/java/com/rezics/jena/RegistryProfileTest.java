package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.junit.Test;

/** The registry-probe profile reaches the module only through its generated
 * manifest (model/tests/fixtures/registry-probe.ts); no module code names it. */
public class RegistryProfileTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String PROFILE = "registry-probe-v1";
    private static final String SHAPE = "https://rezics.com/definition/registry-probe-v1/";
    private static final Path DIRECTORY = Path.of("src/test/resources/registry-probe");

    private static Node uri(String value) { return NodeFactory.createURI(value); }

    private static void add(DatasetGraph data, String graph, String subject, String predicate, Node object) {
        data.add(uri(graph), uri(subject), uri(predicate), object);
    }

    private static void typed(DatasetGraph data, String graph, String subject, String type) {
        add(data, graph, subject, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", uri(RV + type));
    }

    private static DatasetGraph dataset() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(org.apache.jena.query.ReadWrite.WRITE);
        Node label = NodeFactory.createLiteralString("probe");
        typed(data, CommandPolicy.CURRENT, "urn:probe:plain", "RegistryProbe");
        add(data, CommandPolicy.CURRENT, "urn:probe:plain", RV + "probeLabel", label);
        typed(data, CommandPolicy.CURRENT, "urn:probe:unlabelled", "RegistryProbe");
        typed(data, CommandPolicy.CURRENT, "urn:probe:sealed", "RegistryProbe");
        add(data, CommandPolicy.CURRENT, "urn:probe:sealed", RV + "probeLabel", label);
        add(data, CommandPolicy.CURRENT, "urn:probe:sealed", RV + "probeState", uri(RV + "Sealed"));
        typed(data, CommandPolicy.CURRENT, "urn:probe:signed", "RegistryProbe");
        add(data, CommandPolicy.CURRENT, "urn:probe:signed", RV + "probeLabel", label);
        add(data, CommandPolicy.CURRENT, "urn:probe:signed", RV + "probeState", uri(RV + "Sealed"));
        add(data, CommandPolicy.CURRENT, "urn:probe:signed", RV + "sealedBy", uri("urn:probe:actor"));
        typed(data, CommandPolicy.REVISIONS, "urn:probe:record", "RegistryProbeRecord");
        add(data, CommandPolicy.REVISIONS, "urn:probe:record", RV + "item", uri("urn:probe:plain"));
        typed(data, CommandPolicy.CURRENT, "urn:probe:unknown", "Unregistered");
        typed(data, CommandPolicy.REVISIONS, "urn:probe:unknown", "Unregistered");
        return data;
    }

    private static String report(Map<String, Object> result) {
        assertEquals("invalid", result.get("status"));
        return String.valueOf(result.get("report"));
    }

    @Test public void moduleReportsThePomVersion() throws Exception {
        assertTrue(Files.readString(Path.of("pom.xml"))
            .contains("<artifactId>fuseki-command</artifactId><version>" + CommandModule.VERSION + "</version>"));
    }

    @Test public void registryOnlyProfileSelectsValidatesAndRejectsCanonicalShapes() {
        ProfileRegistry registry = ProfileRegistry.load(DIRECTORY);
        DatasetGraph data = dataset();
        try {
            assertNull(CanonicalPolicy.validate(registry, data, "urn:probe:plain", false));
            assertTrue(report(CanonicalPolicy.validate(registry, data, "urn:probe:unlabelled", false))
                .contains(RV + "probeLabel"));
            // The discriminator selects the sealed shape, which alone requires rv:sealedBy.
            assertTrue(report(CanonicalPolicy.validate(registry, data, "urn:probe:sealed", false))
                .contains(RV + "sealedBy"));
            assertNull(CanonicalPolicy.validate(registry, data, "urn:probe:signed", false));
            assertNull(CanonicalPolicy.validate(registry, data, "urn:probe:record", true));
            assertEquals("unrecognized current graph type: urn:probe:unknown",
                report(CanonicalPolicy.validate(registry, data, "urn:probe:unknown", false)));
            assertNull(CanonicalPolicy.validate(registry, data, "urn:probe:unknown", true));
            assertEquals(PROFILE, CanonicalPolicy.requiredBindingProfile(registry, data, "urn:probe:record", true));
            assertNull(CanonicalPolicy.requiredBindingProfile(registry, data, "urn:probe:plain", false));
        } finally { data.abort(); data.end(); }
    }

    private static List<CommandService.Validation> bound(ProfileRegistry registry, Map<String, String> binding,
                                                         String item) {
        ProfileRegistry.Profile profile = registry.get(PROFILE);
        return List.of(
            new CommandService.Validation(PROFILE, profile, SHAPE + "item-shape", List.of(item),
                List.of(CommandPolicy.CURRENT), binding),
            new CommandService.Validation(PROFILE, profile, SHAPE + "record-shape", List.of("urn:probe:record"),
                List.of(CommandPolicy.REVISIONS), binding));
    }

    @Test public void registryOnlyBindingEnforcesKeysAndRoles() {
        ProfileRegistry registry = ProfileRegistry.load(DIRECTORY);
        ProfileRegistry.Binding binding = registry.get(PROFILE).binding();
        DatasetGraph data = dataset();
        try {
            Map<String, String> args = Map.of("item", "urn:probe:plain", "record", "urn:probe:record",
                "label", "probe");
            assertNull(BindingPolicy.check(data, PROFILE, binding, bound(registry, args, "urn:probe:plain")));
            assertEquals("missing binding key: label", assertThrows(IllegalArgumentException.class, () ->
                BindingPolicy.check(data, PROFILE, binding, bound(registry,
                    Map.of("item", "urn:probe:plain", "record", "urn:probe:record"), "urn:probe:plain")))
                .getMessage());
            assertEquals("unknown binding key", assertThrows(IllegalArgumentException.class, () ->
                BindingPolicy.check(data, PROFILE, binding, bound(registry,
                    Map.of("item", "urn:probe:plain", "record", "urn:probe:record", "label", "probe",
                        "extra", "x"), "urn:probe:plain"))).getMessage());
            assertEquals("binding focus differs: item", assertThrows(IllegalArgumentException.class, () ->
                BindingPolicy.check(data, PROFILE, binding, bound(registry, args, "urn:probe:signed")))
                .getMessage());
            assertEquals("profile binding required: " + PROFILE, assertThrows(IllegalArgumentException.class,
                () -> BindingPolicy.check(data, PROFILE, binding, bound(registry, Map.of(), "urn:probe:plain")))
                .getMessage());
            assertEquals("bindings are not admitted for this profile", assertThrows(IllegalArgumentException.class,
                () -> BindingPolicy.check(data, PROFILE, null, bound(registry, args, "urn:probe:plain")))
                .getMessage());
        } finally { data.abort(); data.end(); }
    }

    @Test public void registryRejectsManifestsWithoutRoutingOrWithUnknownShapes() throws Exception {
        Path directory = Files.createTempDirectory("registry-probe");
        Files.createDirectories(directory.resolve("shapes"));
        Files.copy(DIRECTORY.resolve("shapes/registry-probe-v1.ttl"), directory.resolve("shapes/registry-probe-v1.ttl"));
        String manifest = Files.readString(DIRECTORY.resolve("manifest.json"));
        Files.writeString(directory.resolve("manifest.json"), manifest.replace("\"canonical\"", "\"retired\""));
        assertEquals("manifest lacks the canonical registry", assertThrows(IllegalArgumentException.class,
            () -> ProfileRegistry.load(directory)).getMessage());
        Files.writeString(directory.resolve("manifest.json"), manifest.replace("record-shape", "absent-shape"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> ProfileRegistry.load(directory))
            .getMessage().startsWith("canonical route names an unknown shape"));
    }
}
