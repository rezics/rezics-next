package com.rezics.jena;

import java.nio.file.Path;
import java.util.Set;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.main.sys.FusekiAutoModule;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.rdf.model.Model;

public final class CommandModule implements FusekiAutoModule {
    private static final Operation COMMAND = Operation.alloc("https://rezics.com/fuseki/command", "command", "REZICS transactional command");
    private final ProfileRegistry profiles = ProfileRegistry.load(Path.of(System.getProperty("rezics.profiles", "/fuseki/profiles")));

    @Override public String name() { return "rezics-command"; }

    @Override public void prepare(FusekiServer.Builder builder, Set<String> datasetNames, Model configModel) {
        org.apache.jena.query.text.TextQuery.init();
        builder.registerOperation(COMMAND, new CommandService(profiles));
    }
}
