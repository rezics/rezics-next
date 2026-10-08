package com.rezics.jena;

import java.util.function.Consumer;
import org.apache.jena.sparql.core.Transactional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** A commit that throws may already have written TDB2's journal commit point
 *  and still hold the writer lock. Stopping the process lets the next open
 *  replay the journal instead of serving that store. */
final class CommitHalt {
    /** EX_SOFTWARE. Not 75 (owner-lock refusal) or 73 (text-before-graph crash fixture). */
    static final int STATUS = 70;

    @FunctionalInterface
    interface Halt { void halt(int status); }

    private static final Logger LOG = LoggerFactory.getLogger(CommitHalt.class);

    /** Production log: one line, then the stream is flushed before the process stops. */
    static final Consumer<String> PROCESS_LOG = line -> {
        LOG.error(line);
        System.err.println(line);
        System.err.flush();
    };

    static volatile Halt halt = CommitHalt::haltProcess;
    static volatile Consumer<String> logged = PROCESS_LOG;

    private CommitHalt() {}

    /** Commit {@code data}. A thrown failure aborts and ends on a best-effort basis, logs once, and halts. */
    static void commit(Transactional data) {
        try {
            data.commit();
        } catch (Throwable failure) {
            try { data.abort(); } catch (Throwable ignored) { /* the commit already failed */ }
            try { data.end(); } catch (Throwable ignored) { /* the transaction may already be past use */ }
            try { logged.accept(line(failure)); } catch (Throwable ignored) { /* still stop */ }
            halt.halt(STATUS);
            // A test hook can return. Callers must not treat that as a successful commit.
            rethrow(failure);
        }
    }

    private static String line(Throwable failure) {
        String detail = failure.getClass().getName();
        String message = failure.getMessage();
        if (message != null && !message.isBlank())
            detail += ": " + message.replace('\r', ' ').replace('\n', ' ');
        return "TDB2 commit failed: " + detail;
    }

    private static void rethrow(Throwable failure) {
        if (failure instanceof RuntimeException runtime) throw runtime;
        if (failure instanceof Error error) throw error;
        throw new IllegalStateException(failure);
    }

    /** {@link Runtime#halt} skips shutdown hooks, so logs are flushed first. */
    private static void haltProcess(int status) {
        try {
            System.err.flush();
            System.out.flush();
            flushLog4j();
        } catch (Throwable ignored) { /* the exit still has to happen */ }
        Runtime.getRuntime().halt(status);
    }

    private static void flushLog4j() throws Exception {
        Class<?> manager = Class.forName("org.apache.logging.log4j.LogManager");
        Object context = manager.getMethod("getContext", boolean.class).invoke(null, Boolean.FALSE);
        context.getClass().getMethod("stop").invoke(context);
    }
}
