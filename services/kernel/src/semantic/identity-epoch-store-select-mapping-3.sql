SELECT m.terminal,m.epoch,m.origin,m.recorded_transaction_id,g.recorded_transaction_id AS gate_transaction_id,
          g.pending_job,g.pending_epoch
        FROM semantic.identity_epoch_mapping m
        LEFT JOIN semantic.identity_epoch_home_gate g
          ON (g.route,g.destination,g.original)=(m.route,m.original,m.original)
        WHERE (m.route,m.original)=($1,$2);
