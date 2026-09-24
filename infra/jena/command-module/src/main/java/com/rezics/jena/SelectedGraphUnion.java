package com.rezics.jena;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import org.apache.jena.graph.Graph;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.graph.compose.MultiUnion;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.graph.GraphReadOnly;

/** A transaction-scoped, set-valued view of selected named graphs. The caller
 * must finish using it before the dataset transaction closes. */
final class SelectedGraphUnion {
    private SelectedGraphUnion() {}

    static Graph readOnly(DatasetGraph dataset, Collection<String> graphNames) {
        List<Graph> sources = new ArrayList<>();
        for (String name : new LinkedHashSet<>(graphNames)) {
            Graph source = dataset.getGraph(NodeFactory.createURI(name));
            if (source != null) sources.add(source);
        }
        Graph union = sources.size() == 1 ? sources.get(0) : new MultiUnion(sources.toArray(Graph[]::new));
        return new GraphReadOnly(union);
    }
}
