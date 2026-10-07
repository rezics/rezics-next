package com.rezics.jena;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;

/** Canonical shape selection for touched native subjects, from the generated
 * registry alone; request-supplied focus cannot choose or skip it. */
final class CanonicalPolicy {
    private static final String RV = "https://rezics.com/vocab/";

    private CanonicalPolicy() {}

    static Node realmOwner(Node realm, Node main) {
        if (realm == null || !realm.isURI() || main == null || !main.isURI()) return null;
        try {
            String key = realm.getURI() + "\0" + main.getURI();
            return NodeFactory.createURI("urn:rezics:realm-selection:" + java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(key.getBytes(java.nio.charset.StandardCharsets.UTF_8))));
        } catch (java.security.NoSuchAlgorithmException unavailable) { throw new IllegalStateException(unavailable); }
    }
    private static Node oneIri(DatasetGraph data, Node graph, Node subject, String predicate) {
        var rows = data.find(graph, subject, NodeFactory.createURI(RV + predicate), Node.ANY);
        try {
            if (!rows.hasNext()) return null;
            Node value = rows.next().getObject();
            return value.isURI() && !rows.hasNext() ? value : null;
        } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    /** Identity is the owner key; alternate slots cannot be another current
     * adoption for the same Realm/Main, even without a searchable body. */
    static String realmSlotOwnerFailure(DatasetGraph data, Node slot) {
        Node current = graph(false), realm = oneIri(data, current, slot, "realm"), main = oneIri(data, current, slot, "mainVersion");
        if (realm == null || main == null || oneIri(data, current, slot, "work") == null || oneIri(data, current, slot, "selectionHead") == null)
            return "incomplete Realm publication slot owner";
        return slot.equals(realmOwner(realm, main)) ? null : "noncanonical Realm publication slot owner";
    }
    static String realmSelectionOwnerFailure(DatasetGraph data, Node selection) {
        Node revisions = graph(true), context = oneIri(data, revisions, selection, "context"), main = oneIri(data, revisions, selection, "mainVersion");
        boolean slotDeclared = data.contains(revisions, selection, NodeFactory.createURI(RV + "slot"), Node.ANY);
        if (!slotDeclared && (context == null || main == null || context.equals(main))) return null;
        Node slot = oneIri(data, revisions, selection, "slot"), expected = realmOwner(context, main);
        if (expected == null || !expected.equals(slot)) return "noncanonical Realm publication selection owner";
        // Historical selections keep their canonical owner after a newer head
        // is selected. Do not compare their immutable identity to currentHead.
        if (data.contains(revisions, selection, NodeFactory.createURI(RV + "component"), Node.ANY)
            && !expected.equals(oneIri(data, revisions, selection, "component")))
            return "Realm publication selection component differs from its owner";
        return null;
    }
    static boolean realmUnitOwnerValid(DatasetGraph data, Node unit) {
        Node context = oneIri(data, NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH), unit, "context");
        Node main = oneIri(data, NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH), unit, "mainVersion");
        if (context == null || main == null || context.equals(main)) return true;
        Node selection = oneIri(data, NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH), unit, "selection");
        if (selection == null || realmSelectionOwnerFailure(data, selection) != null) return false;
        Node revisions = graph(true);
        return context.equals(oneIri(data, revisions, selection, "context")) && main.equals(oneIri(data, revisions, selection, "mainVersion"));
    }
    /** Existing whole-generation qualification streams legacy/raw owners once
     * before read traffic; ranked and delta reads use only exact owner keys. */
    static boolean auditRealmOwners(DatasetGraph data) {
        var rows = data.find(graph(false), Node.ANY, org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + "RealmPublicationSlot"));
        try { while (rows.hasNext()) {
            Node slot = rows.next().getSubject(); CommandWork.count("realm_owner_qualification_visits", 1);
            if (realmSlotOwnerFailure(data, slot) != null) return false;
        } return true; } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }


    record Selection(String type, ProfileRegistry.Route route, Set<String> selectors) {}

    static Selection select(ProfileRegistry profiles, DatasetGraph dataset, String subject, boolean revision) {
        Node graph = graph(revision);
        Node node = NodeFactory.createURI(subject);
        ProfileRegistry.Canonical canonical = profiles.canonical(types(dataset, graph, node));
        if (canonical == null) return null;
        Set<String> selectors = new HashSet<>();
        for (ProfileRegistry.Route route : canonical.routes())
            for (ProfileRegistry.Condition condition : route.when()) selectors.add(condition.path());
        for (ProfileRegistry.Route route : canonical.routes()) {
            if (route.when().stream().allMatch(condition ->
                condition.value().equals(singleObject(dataset, graph, node, condition.path()))))
                return new Selection(canonical.type(), route, Set.copyOf(selectors));
        }
        return null;
    }

    static Map<String, Object> validateSelected(ProfileRegistry profiles, DatasetGraph dataset,
                                                String subject, Selection selection) {
        ProfileRegistry.Route route = selection.route();
        return CommandService.validateOne(dataset, new CommandService.Validation(route.profile(),
            profiles.get(route.profile()), route.shape(), List.of(subject),
            List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()));
    }

    static Map<String, Object> validate(ProfileRegistry profiles, DatasetGraph dataset, String subject,
                                        boolean revision) {
        Node graph = graph(revision);
        Node node = NodeFactory.createURI(subject);
        Set<String> types = types(dataset, graph, node);
        if (!revision && types.isEmpty()) return CommandService.invalid("current graph subject has no type: " + subject);
        if (!revision && types.contains(RV + "RealmPublicationSlot")) {
            String failure = realmSlotOwnerFailure(dataset, node);
            if (failure != null) return CommandService.invalid(failure + ": " + subject);
        }
        if (revision && types.contains(RV + "PublicationSelection")) {
            String failure = realmSelectionOwnerFailure(dataset, node);
            if (failure != null) return CommandService.invalid(failure + ": " + subject);
        }
        ProfileRegistry.Canonical canonical = profiles.canonical(types);
        if (canonical == null) {
            // A publication slot is a guarded pointer with no profile shape; every
            // registry type takes precedence over it.
            if (types.contains(RV + "RealmPublicationSlot")) {
                for (String predicate : List.of("realm", "mainVersion", "work", "selectionHead")) {
                    if (singleObject(dataset, graph, node, RV + predicate) == null)
                        return CommandService.invalid("incomplete Realm publication slot: " + subject);
                }
                return null;
            }
            return revision ? null : CommandService.invalid("unrecognized current graph type: " + subject);
        }
        Selection selected = select(profiles, dataset, subject, revision);
        if (selected != null) return validateSelected(profiles, dataset, subject, selected);
        return CommandService.invalid("no canonical shape matches: " + subject);
    }

    /** The profile whose bound validation must name this subject as a focus, or null. */
    static String requiredBindingProfile(ProfileRegistry profiles, DatasetGraph dataset, String subject,
                                         boolean revision) {
        Set<String> subjectTypes = types(dataset, graph(revision), NodeFactory.createURI(subject));
        // The fixed Global has no Realm/context relationship to bind. Its canonical
        // global shape still validates every write; Realm Contexts keep their binding.
        if (!revision && subject.equals("urn:rezics:classification-context:global")
            && subjectTypes.equals(Set.of(RV + "ClassificationContext"))
            && (RV + "GlobalClassification").equals(singleObject(dataset, graph(false),
                NodeFactory.createURI(subject), RV + "contextRole"))) return null;
        return profiles.bindingDemand(subjectTypes);
    }

    private static Node graph(boolean revision) {
        return NodeFactory.createURI(revision ? CommandPolicy.REVISIONS : CommandPolicy.CURRENT);
    }

    private static Set<String> types(DatasetGraph dataset, Node graph, Node node) {
        Set<String> types = new HashSet<>();
        dataset.find(graph, node, org.apache.jena.vocabulary.RDF.type.asNode(), Node.ANY)
            .forEachRemaining(quad -> { if (quad.getObject().isURI()) types.add(quad.getObject().getURI()); });
        return types;
    }

    private static String singleObject(DatasetGraph dataset, Node graph, Node subject, String predicate) {
        var values = dataset.find(graph, subject, NodeFactory.createURI(predicate), Node.ANY);
        if (!values.hasNext()) return null;
        Node first = values.next().getObject();
        if (values.hasNext()) return null;
        return first.isURI() ? first.getURI() : first.isLiteral() ? first.getLiteralLexicalForm() : null;
    }
}
