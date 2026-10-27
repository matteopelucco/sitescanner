// Versioned schema of the Postgres database (RF-STO-03). Migrations are only appended, never edited:
// each one runs once, in order, recorded in schema_migrations. They never drop data.

export const MIGRATIONS = [
  {
    version: 1,
    name: 'utenti, sessioni, siti, scan, inventari, job',
    sql: `
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        username text NOT NULL UNIQUE,
        name text NOT NULL DEFAULT '',
        role text NOT NULL CHECK (role IN ('admin', 'user')),
        active boolean NOT NULL DEFAULT true,
        must_change_password boolean NOT NULL DEFAULT true,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz
      );
      CREATE TABLE sessions (
        hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL,
        ip text,
        user_agent text
      );
      CREATE INDEX sessions_user ON sessions (user_id);
      CREATE TABLE login_failures (key text NOT NULL, at timestamptz NOT NULL);
      CREATE INDEX login_failures_key ON login_failures (key, at);
      CREATE TABLE audit (
        id bigserial PRIMARY KEY,
        at timestamptz NOT NULL,
        actor text,
        action text NOT NULL,
        target text,
        ip text,
        detail text
      );
      CREATE INDEX audit_at ON audit (at);

      -- Areas are user ids: every query of an area filters on it (RF-STO-04).
      CREATE TABLE sites (
        area text NOT NULL,
        id text NOT NULL,
        yaml text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (area, id)
      );
      -- A row is the commit point of a scan (RF-STO-02); files are in Blob under u/<area>/<site>/scans/<id>/.
      CREATE TABLE scans (
        area text NOT NULL,
        site text NOT NULL,
        id text NOT NULL,
        started_at text,
        meta jsonb NOT NULL,
        overlay jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (area, site, id)
      );
      CREATE TABLE inventories (
        area text NOT NULL,
        id text NOT NULL,
        meta jsonb NOT NULL,
        PRIMARY KEY (area, id)
      );
      CREATE TABLE jobs (
        area text NOT NULL,
        id text NOT NULL,
        view jsonb NOT NULL,
        status text NOT NULL,
        cancel_requested boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (area, id)
      );
      CREATE INDEX jobs_area_updated ON jobs (area, updated_at DESC);
    `,
  },
  {
    version: 2,
    name: 'job a passi: numero del passo e lease',
    sql: `
      ALTER TABLE jobs ADD COLUMN step integer NOT NULL DEFAULT 0;
      ALTER TABLE jobs ADD COLUMN lease_until timestamptz;
    `,
  },
  {
    version: 3,
    name: 'monitoraggio: monitor, controlli, incidenti, manutenzione, aggregati, giri, eventi',
    // Instants are milliseconds since the epoch (double precision): the same numbers as in the code.
    sql: `
      CREATE TABLE mon_monitors (
        area text NOT NULL,
        id text NOT NULL,
        data jsonb NOT NULL,
        next_check_at double precision NOT NULL DEFAULT 0,
        paused boolean NOT NULL DEFAULT false,
        locked_until double precision NOT NULL DEFAULT 0,
        PRIMARY KEY (area, id)
      );
      CREATE INDEX mon_monitors_due ON mon_monitors (next_check_at) WHERE NOT paused;
      CREATE TABLE mon_checks (area text NOT NULL, monitor_id text NOT NULL, at double precision NOT NULL, data jsonb NOT NULL);
      CREATE INDEX mon_checks_monitor ON mon_checks (area, monitor_id, at);
      CREATE INDEX mon_checks_at ON mon_checks (at);
      CREATE TABLE mon_incidents (
        area text NOT NULL,
        id text NOT NULL,
        monitor_id text NOT NULL,
        start_at double precision NOT NULL,
        end_at double precision,
        data jsonb NOT NULL,
        PRIMARY KEY (area, id)
      );
      CREATE INDEX mon_incidents_monitor ON mon_incidents (area, monitor_id, start_at);
      CREATE TABLE mon_windows (area text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (area, id));
      CREATE TABLE mon_aggregates (
        area text NOT NULL,
        kind text NOT NULL,
        monitor_id text NOT NULL,
        t double precision NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (area, kind, monitor_id, t)
      );
      CREATE TABLE mon_beats (at double precision NOT NULL, data jsonb NOT NULL);
      CREATE INDEX mon_beats_at ON mon_beats (at);
      CREATE TABLE mon_events (
        area text NOT NULL,
        id text NOT NULL,
        at double precision NOT NULL,
        status text NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (area, id)
      );
      CREATE INDEX mon_events_pending ON mon_events (status, at);
      CREATE TABLE mon_meta (key text PRIMARY KEY, value jsonb);
    `,
  },
  {
    version: 4,
    name: 'notifiche: canali per account e collegamenti Telegram',
    sql: `
      CREATE TABLE mon_channels (area text NOT NULL, id text NOT NULL, token_hash text, data jsonb NOT NULL, PRIMARY KEY (area, id));
      CREATE INDEX mon_channels_token ON mon_channels (token_hash) WHERE token_hash IS NOT NULL;
      CREATE TABLE mon_links (code_hash text PRIMARY KEY, area text NOT NULL, expires_at double precision NOT NULL);
    `,
  },
  {
    version: 5,
    name: 'heartbeat: ricerca del monitor dal token segreto',
    sql: `
      CREATE INDEX mon_monitors_hb ON mon_monitors ((data->>'hbToken')) WHERE data->>'hbToken' IS NOT NULL;
    `,
  },
  {
    version: 6,
    name: 'variabili e segreti dello spazio di lavoro, con il registro delle modifiche',
    sql: `
      CREATE TABLE mon_secrets (area text NOT NULL, name text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (area, name));
      CREATE TABLE mon_secret_log (area text NOT NULL, at double precision NOT NULL, data jsonb NOT NULL);
      CREATE INDEX mon_secret_log_area ON mon_secret_log (area, at);
    `,
  },
  {
    version: 7,
    name: 'spazi di lavoro condivisi, con i loro membri, e token API (ADR-0023)',
    // Additive: the personal workspace of a user is their area, with the id of the account, so no row moves.
    // Undoing it is dropping the two tables.
    sql: `
      CREATE TABLE workspaces (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE api_tokens (id text PRIMARY KEY, workspace_id text NOT NULL, hash text NOT NULL UNIQUE, data jsonb NOT NULL);
      CREATE INDEX api_tokens_workspace ON api_tokens (workspace_id);
    `,
  },
  {
    version: 8,
    name: 'status page pubbliche, comunicazioni di incidente e link pubblici (dashboard TV, badge)',
    // The slug and the custom domain are unique across the deployment: the public page is asked without a session.
    sql: `
      CREATE TABLE mon_status_pages (area text NOT NULL, id text NOT NULL, slug text NOT NULL UNIQUE, domain text, data jsonb NOT NULL, PRIMARY KEY (area, id));
      CREATE UNIQUE INDEX mon_status_pages_domain ON mon_status_pages (lower(domain)) WHERE domain IS NOT NULL;
      CREATE TABLE mon_status_updates (area text NOT NULL, id text NOT NULL, page_id text NOT NULL, at double precision NOT NULL, data jsonb NOT NULL, PRIMARY KEY (area, id));
      CREATE INDEX mon_status_updates_page ON mon_status_updates (area, page_id, at);
      CREATE TABLE mon_public_links (token text PRIMARY KEY, area text NOT NULL, kind text NOT NULL, data jsonb NOT NULL);
      CREATE INDEX mon_public_links_area ON mon_public_links (area);
    `,
  },
  {
    version: 9,
    name: 'agenti locali (località private) e la coda dei loro controlli (ADR-0025)',
    // Additive. The hash of the token is unique across the deployment: the agent asks without a session.
    sql: `
      CREATE TABLE mon_agents (area text NOT NULL, id text NOT NULL, hash text NOT NULL UNIQUE, data jsonb NOT NULL, PRIMARY KEY (area, id));
      CREATE TABLE mon_agent_jobs (id text PRIMARY KEY, area text NOT NULL, agent_id text NOT NULL, state text NOT NULL, created_at double precision NOT NULL, data jsonb NOT NULL);
      CREATE INDEX mon_agent_jobs_agent ON mon_agent_jobs (agent_id, state, created_at);
    `,
  },
];

// Any number would do, as long as it is fixed: it identifies the migration lock.
const LOCK_ID = 727274;

/** Applies the missing migrations, one process at a time (advisory lock). */
export async function migrate(db) {
  await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await t.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await t.query('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await t.exec(m.sql);
      await t.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
    }
  });
}
