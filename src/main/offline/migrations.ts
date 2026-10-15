import type { DatabaseSync } from "node:sqlite";

export interface LocalMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const LOCAL_SCHEMA_VERSION = 7;

export const localMigrations: ReadonlyArray<LocalMigration> = [
  {
    version: 1,
    name: "application_metadata",
    sql: `
      CREATE TABLE app_metadata (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        installation_id TEXT NOT NULL UNIQUE,
        receipt_prefix TEXT NOT NULL CHECK (length(receipt_prefix) BETWEEN 2 AND 8),
        next_receipt_number INTEGER NOT NULL DEFAULT 1 CHECK (next_receipt_number > 0),
        last_startup_at TEXT,
        last_clean_shutdown_at TEXT,
        trusted_server_time TEXT,
        trusted_local_time TEXT
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: "offline_durability_model",
    sql: `
      CREATE TABLE device_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        tenant_id TEXT,
        device_id TEXT UNIQUE,
        credential_id TEXT UNIQUE,
        register_id TEXT,
        branch_id TEXT,
        inventory_location_id TEXT,
        public_key_spki_base64 TEXT NOT NULL,
        public_key_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
        enrollment_idempotency_key TEXT NOT NULL,
        bootstrap_idempotency_key TEXT,
        activated_at TEXT,
        revoked_at TEXT,
        last_validated_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE offline_grant (
        grant_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        minimum_client_version TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        inventory_location_id TEXT NOT NULL,
        operator_membership_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        operator_expires_at TEXT NOT NULL,
        catalog_valid_until TEXT NOT NULL,
        accepted_until TEXT NOT NULL,
        max_sale_amount_minor INTEGER NOT NULL CHECK (max_sale_amount_minor >= 0),
        max_cumulative_exposure_minor INTEGER NOT NULL CHECK (max_cumulative_exposure_minor >= 0),
        max_quantity_per_line INTEGER NOT NULL CHECK (max_quantity_per_line > 0),
        max_pending_offline_sales INTEGER NOT NULL CHECK (max_pending_offline_sales > 0),
        payload_json TEXT NOT NULL,
        installed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE context_snapshot (
        snapshot_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        inventory_location_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        installed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE catalog_snapshot (
        snapshot_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES offline_grant(grant_id) ON DELETE RESTRICT,
        generated_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('installing', 'complete', 'active', 'retired')),
        installed_at TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX one_active_catalog_snapshot
        ON catalog_snapshot(state) WHERE state = 'active';

      CREATE TABLE catalog_product (
        snapshot_id TEXT NOT NULL REFERENCES catalog_snapshot(snapshot_id) ON DELETE RESTRICT,
        product_id TEXT NOT NULL,
        brand_id TEXT NOT NULL,
        name TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        PRIMARY KEY (snapshot_id, product_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE catalog_variant_price (
        snapshot_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        option_summary TEXT,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        currency TEXT NOT NULL,
        authorized_unit_price_minor INTEGER NOT NULL CHECK (authorized_unit_price_minor >= 0),
        price_id TEXT NOT NULL,
        price_version TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, variant_id),
        FOREIGN KEY (snapshot_id, product_id)
          REFERENCES catalog_product(snapshot_id, product_id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX catalog_variant_by_sku ON catalog_variant_price(snapshot_id, sku);

      CREATE TABLE inventory_snapshot (
        snapshot_id TEXT NOT NULL,
        inventory_location_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
        version INTEGER NOT NULL CHECK (version >= 0),
        as_of TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, inventory_location_id, variant_id),
        FOREIGN KEY (snapshot_id, variant_id)
          REFERENCES catalog_variant_price(snapshot_id, variant_id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE local_sale (
        local_sale_id TEXT PRIMARY KEY,
        local_receipt_id TEXT NOT NULL UNIQUE,
        grant_id TEXT NOT NULL REFERENCES offline_grant(grant_id) ON DELETE RESTRICT,
        snapshot_id TEXT NOT NULL REFERENCES catalog_snapshot(snapshot_id) ON DELETE RESTRICT,
        device_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        inventory_location_id TEXT NOT NULL,
        operator_membership_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        currency TEXT NOT NULL,
        total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
        offline_sale_ordinal INTEGER NOT NULL CHECK (offline_sale_ordinal > 0),
        cumulative_exposure_minor INTEGER NOT NULL CHECK (cumulative_exposure_minor >= 0),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('accepted_pending_sync', 'synced', 'needs_reconciliation')),
        server_order_id TEXT,
        server_order_number TEXT,
        server_ingestion_id TEXT,
        synchronized_at TEXT,
        projection_released_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (grant_id, offline_sale_ordinal)
      ) STRICT;

      CREATE INDEX local_sale_projection
        ON local_sale(inventory_location_id, lifecycle, snapshot_id);

      CREATE TABLE local_sale_line (
        local_sale_id TEXT NOT NULL REFERENCES local_sale(local_sale_id) ON DELETE RESTRICT,
        line_number INTEGER NOT NULL CHECK (line_number > 0),
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        variant_name TEXT,
        sku TEXT NOT NULL,
        option_summary TEXT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
        line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
        price_id TEXT NOT NULL,
        price_version TEXT NOT NULL,
        PRIMARY KEY (local_sale_id, line_number),
        UNIQUE (local_sale_id, variant_id)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX local_sale_line_projection ON local_sale_line(variant_id, local_sale_id);

      CREATE TABLE local_cash_tender (
        local_sale_id TEXT PRIMARY KEY REFERENCES local_sale(local_sale_id) ON DELETE RESTRICT,
        amount_due_minor INTEGER NOT NULL CHECK (amount_due_minor >= 0),
        cash_received_minor INTEGER NOT NULL CHECK (cash_received_minor >= amount_due_minor),
        change_minor INTEGER NOT NULL CHECK (change_minor = cash_received_minor - amount_due_minor),
        accepted_at TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE outbox (
        sync_command_id TEXT PRIMARY KEY,
        local_sale_id TEXT NOT NULL UNIQUE REFERENCES local_sale(local_sale_id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL UNIQUE,
        canonical_command TEXT NOT NULL,
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        signature_base64 TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'retry_wait', 'delivered', 'blocked')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        lease_id TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        server_ingestion_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((state = 'leased') = (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL))
      ) STRICT;

      CREATE INDEX outbox_due_work ON outbox(state, next_attempt_at, created_at);
      CREATE INDEX outbox_expired_lease ON outbox(state, lease_expires_at);

      CREATE TRIGGER immutable_grant_update BEFORE UPDATE ON offline_grant
      BEGIN SELECT RAISE(ABORT, 'offline grant is immutable'); END;
      CREATE TRIGGER immutable_grant_delete BEFORE DELETE ON offline_grant
      BEGIN SELECT RAISE(ABORT, 'offline grant is immutable'); END;
      CREATE TRIGGER immutable_context_update BEFORE UPDATE ON context_snapshot
      BEGIN SELECT RAISE(ABORT, 'context snapshot is immutable'); END;
      CREATE TRIGGER immutable_catalog_product_update BEFORE UPDATE ON catalog_product
      BEGIN SELECT RAISE(ABORT, 'catalog product is immutable'); END;
      CREATE TRIGGER immutable_catalog_variant_update BEFORE UPDATE ON catalog_variant_price
      BEGIN SELECT RAISE(ABORT, 'catalog variant is immutable'); END;
      CREATE TRIGGER immutable_inventory_snapshot_update BEFORE UPDATE ON inventory_snapshot
      BEGIN SELECT RAISE(ABORT, 'inventory snapshot is immutable'); END;
      CREATE TRIGGER immutable_sale_facts BEFORE UPDATE OF
        local_sale_id, local_receipt_id, grant_id, snapshot_id, device_id, register_id,
        inventory_location_id, operator_membership_id, accepted_at, currency, total_minor,
        offline_sale_ordinal, cumulative_exposure_minor, created_at ON local_sale
      BEGIN SELECT RAISE(ABORT, 'accepted sale facts are immutable'); END;
      CREATE TRIGGER immutable_sale_delete BEFORE DELETE ON local_sale
      BEGIN SELECT RAISE(ABORT, 'accepted sale is immutable'); END;
      CREATE TRIGGER immutable_sale_line_update BEFORE UPDATE ON local_sale_line
      BEGIN SELECT RAISE(ABORT, 'accepted sale line is immutable'); END;
      CREATE TRIGGER immutable_sale_line_delete BEFORE DELETE ON local_sale_line
      BEGIN SELECT RAISE(ABORT, 'accepted sale line is immutable'); END;
      CREATE TRIGGER immutable_tender_update BEFORE UPDATE ON local_cash_tender
      BEGIN SELECT RAISE(ABORT, 'accepted tender is immutable'); END;
      CREATE TRIGGER immutable_tender_delete BEFORE DELETE ON local_cash_tender
      BEGIN SELECT RAISE(ABORT, 'accepted tender is immutable'); END;
      CREATE TRIGGER immutable_outbox_command BEFORE UPDATE OF
        sync_command_id, local_sale_id, idempotency_key, canonical_command, payload_hash,
        signature_base64, credential_id, request_json, created_at ON outbox
      BEGIN SELECT RAISE(ABORT, 'outbox command is immutable'); END;
      CREATE TRIGGER immutable_outbox_delete BEFORE DELETE ON outbox
      BEGIN SELECT RAISE(ABORT, 'outbox command is immutable'); END;
    `,
  },
  {
    version: 3,
    name: "offline_sync_results",
    sql: `
      ALTER TABLE local_sale ADD COLUMN server_payment_id TEXT;
      ALTER TABLE local_sale ADD COLUMN server_fulfillment_id TEXT;
      ALTER TABLE local_sale ADD COLUMN server_reconciliation_id TEXT;
      ALTER TABLE local_sale ADD COLUMN reconciliation_reason TEXT;
      ALTER TABLE local_sale ADD COLUMN server_received_at TEXT;
    `,
  },
  {
    version: 4,
    name: "connected_return_recovery",
    sql: `
      CREATE TABLE connected_return_workflow (
        id TEXT PRIMARY KEY,
        api_base_url TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        membership_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        order_reference TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('prepared','return_acknowledged','settlement_prepared','completed')),
        create_command TEXT,
        create_hash TEXT,
        create_key TEXT UNIQUE,
        return_ack TEXT,
        settlement_command TEXT,
        settlement_hash TEXT,
        settlement_key TEXT UNIQUE,
        refund_ack TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        outcome TEXT CHECK (outcome IN ('acknowledged','rejected')),
        rejection_code TEXT,
        CHECK ((create_command IS NULL) = (create_key IS NULL)),
        CHECK ((settlement_command IS NULL) = (settlement_key IS NULL)),
        CHECK (stage != 'prepared' OR create_command IS NOT NULL),
        CHECK (stage NOT IN ('return_acknowledged','settlement_prepared') OR return_ack IS NOT NULL),
        CHECK (stage != 'settlement_prepared' OR settlement_command IS NOT NULL),
        CHECK ((stage = 'completed') = (completed_at IS NOT NULL)),
        CHECK (stage != 'completed' OR outcome IS NOT NULL)
      ) STRICT;
      CREATE UNIQUE INDEX one_unresolved_connected_return ON connected_return_workflow((1))
        WHERE stage != 'completed';
      CREATE TRIGGER immutable_return_creation BEFORE UPDATE OF
        id, api_base_url, tenant_id, membership_id, order_id, order_reference,
        create_command, create_hash, create_key, created_at ON connected_return_workflow
      BEGIN SELECT RAISE(ABORT, 'connected return intent is immutable'); END;
      CREATE TRIGGER immutable_return_settlement BEFORE UPDATE OF
        settlement_command, settlement_hash, settlement_key ON connected_return_workflow
        WHEN OLD.settlement_command IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'connected settlement intent is immutable'); END;
      CREATE TRIGGER immutable_completed_return BEFORE UPDATE ON connected_return_workflow
        WHEN OLD.stage = 'completed'
      BEGIN SELECT RAISE(ABORT, 'completed return workflow is archived'); END;
      CREATE TRIGGER retain_return_workflow BEFORE DELETE ON connected_return_workflow
      BEGIN SELECT RAISE(ABORT, 'return workflows must be retained'); END;
    `,
  },
  {
    version: 5,
    name: "offline_sale_acknowledgement",
    sql: `
      -- Durable operator acknowledgement, distinct from synchronization state. A locally accepted
      -- sale is "committed" the instant its row exists; "acknowledged" only once the cashier has
      -- seen its receipt and moved on. Nullable so existing accepted sales remain unacknowledged
      -- until the operator resolves them, and write-once so acknowledgement cannot be revoked.
      ALTER TABLE local_sale ADD COLUMN acknowledged_at TEXT;
      CREATE INDEX local_sale_unacknowledged
        ON local_sale(created_at, local_sale_id) WHERE acknowledged_at IS NULL;
      CREATE TRIGGER immutable_sale_acknowledgement BEFORE UPDATE OF acknowledged_at ON local_sale
        WHEN OLD.acknowledged_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'sale acknowledgement is immutable once recorded'); END;
    `,
  },
  {
    version: 6,
    name: "connected_sale_recovery",
    sql: `
      -- Durable journal for CONNECTED (online) POS sales, so the idempotency key and normalized
      -- command survive renderer/process death. Without this a crash between server commit and the
      -- renderer seeing the receipt would let the cashier re-ring with a fresh key -> a second Order.
      CREATE TABLE connected_sale_workflow (
        id TEXT PRIMARY KEY,
        api_base_url TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        command_json TEXT NOT NULL,
        command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
        expected_total_minor INTEGER NOT NULL CHECK (expected_total_minor >= 0),
        stage TEXT NOT NULL CHECK (stage IN ('prepared','accepted','acknowledged','rejected')),
        receipt_json TEXT,
        rejection_code TEXT,
        prepared_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK (stage != 'accepted' OR receipt_json IS NOT NULL),
        CHECK (stage != 'acknowledged' OR receipt_json IS NOT NULL),
        CHECK (stage != 'rejected' OR rejection_code IS NOT NULL),
        CHECK ((stage IN ('acknowledged','rejected')) = (resolved_at IS NOT NULL))
      ) STRICT;
      -- At most one unresolved connected sale at a time: a new sale cannot start until the previous
      -- one is acknowledged (or definitively rejected).
      CREATE UNIQUE INDEX one_unresolved_connected_sale ON connected_sale_workflow((1))
        WHERE stage NOT IN ('acknowledged','rejected');
      CREATE TRIGGER immutable_connected_sale_command BEFORE UPDATE OF
        id, api_base_url, tenant_id, register_id, idempotency_key, command_json, command_hash,
        expected_total_minor, prepared_at ON connected_sale_workflow
      BEGIN SELECT RAISE(ABORT, 'connected sale command is immutable'); END;
      CREATE TRIGGER immutable_resolved_connected_sale BEFORE UPDATE ON connected_sale_workflow
        WHEN OLD.stage IN ('acknowledged','rejected')
      BEGIN SELECT RAISE(ABORT, 'resolved connected sale is archived'); END;
      CREATE TRIGGER retain_connected_sale_workflow BEFORE DELETE ON connected_sale_workflow
      BEGIN SELECT RAISE(ABORT, 'connected sale workflows must be retained'); END;
    `,
  },
  {
    version: 7,
    name: "activity_log",
    sql: `
      -- Client-only activity ledger: who did what, when, with a comprehensive description. This is a
      -- local telemetry/audit stream (every click, navigation and domain event) and is intentionally
      -- append-driven and mutable only via retention trimming — it carries no money and no durable
      -- selling state, so it is deliberately NOT governed by the immutability triggers above.
      CREATE TABLE activity_log (
        event_id TEXT NOT NULL PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        actor_id TEXT,
        actor_name TEXT,
        tenant_id TEXT,
        section TEXT,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        description TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'alert')),
        details_json TEXT
      ) STRICT;
      CREATE INDEX activity_log_by_time ON activity_log(occurred_at DESC);
      CREATE INDEX activity_log_by_severity ON activity_log(severity, occurred_at DESC);
    `,
  },
];

export interface MigrationOptions {
  readonly targetVersion?: number;
  readonly beforeMigration?: (version: number) => void;
}

export function applyLocalMigrations(database: DatabaseSync, options: MigrationOptions = {}): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS local_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const targetVersion = options.targetVersion ?? LOCAL_SCHEMA_VERSION;
  const appliedRows = database
    .prepare("SELECT version FROM local_schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map(({ version }) => version));

  for (const migration of localMigrations) {
    if (migration.version > targetVersion || applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      options.beforeMigration?.(migration.version);
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO local_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Local database migration ${migration.version} (${migration.name}) failed.`, {
        cause: error,
      });
    }
  }

  const current = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (current.user_version !== targetVersion) {
    throw new Error(
      `Local database schema is version ${current.user_version}; expected ${targetVersion}.`,
    );
  }
}
