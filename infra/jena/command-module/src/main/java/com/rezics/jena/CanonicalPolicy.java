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
        return profiles.bindingDemand(types(dataset, graph(revision), NodeFactory.createURI(subject)));
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
