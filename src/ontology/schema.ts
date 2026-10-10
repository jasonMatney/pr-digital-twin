// SQL schema of the twin database. The same DDL runs in the browser worker, in Node tests and in the seed
// builder, so a seed file and a freshly created database are interchangeable. Analysts query these tables from
// the in-app SQL console: SCHEMA_DOC (also stored as the `schema_doc` table) is the one-line description of each.

/** Bumped when a table changes shape; a seed or persisted file with another value is discarded, not migrated. */
export const SCHEMA_VERSION = 1;

export const SCHEMA_DOC: Record<string, string> = {
  meta: 'Key/value facts about this database file: schema_version, ontology_version, seed_version, built_at.',
  schema_doc: 'This list: one row per table or view with a description.',
  source: 'Where data comes from (ontology.json sources): id, name, org, url, license, kind (baked|live|relay|derived|user), cadence_s.',
  object_type: 'Object types of the ontology: id, kind, labels, key_scheme, icon, color, grp (layer group), ephemeral.',
  prop_def: 'Property definitions per object type: (type, key), labels, vtype, unit, format, is_primary.',
  metric_def: 'Time-series metric definitions per object type: (type, metric), labels, unit.',
  link_type: 'Link types: id, label (src -> dst), inverse (dst -> src), from_types / to_types as JSON arrays.',
  ingest_run: 'Lineage: one row per fetch or ingest (source_id, started_at, finished_at, status ok|error, counts, bytes, note, data_at = newest observation time in the batch).',
  object: 'Everything the twin knows about. id = "<type>:<key>". lon/lat WGS84; times are epoch ms UTC; geometry is GeoJSON text; expired = 1 when its source stopped reporting it.',
  prop: 'Property values, one row per (object_id, key, source_id): sources may disagree. value keeps its SQL type; vtype is number|string|boolean|null.',
  prop_best: 'View: the single best value per (object_id, key). A value entered by a user wins; otherwise the most recently observed.',
  object_props: 'View for easy SELECTs: the best value of every property with its object, as (object_id, type, name, key, value, unit, source_id, observed_at).',
  link_named: 'View: links with both ends named, as (src, src_name, src_type, type, dst, dst_name, dst_type, source_id, confidence).',
  prop_history: 'Previous values of prop rows, appended whenever a source changes a value (replaced_at = when).',
  link: 'Directed typed edges between objects: (src, type, dst) with source_id, observed_at, confidence, note.',
  identity: 'Other ids an object is known by: (scheme, key, type) -> object_id. Used to merge sources naming the same thing. The canonical id is object.key and is not repeated here.',
  obs: 'Time series: (object_id, metric, t epoch ms, value).',
  action_log: 'Audit trail of user writeback: t, action, object_id, payload (JSON).',
  object_fts: 'Full-text index over accent-folded name, type labels and free text; rowid = object.rid.',
  object_rtree: 'Spatial index: bounding box (min_lon, max_lon, min_lat, max_lat) per object; id = object.rid.',
};

// Tables that exist in every build of SQLite. Virtual tables are created separately because a build may lack
// FTS5 or R*Tree, in which case plain tables of the same name and columns stand in.
export const CORE_DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS schema_doc (name TEXT PRIMARY KEY, description TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT, url TEXT, license TEXT,
  kind TEXT NOT NULL,            -- baked | live | relay | derived | user
  cadence_s INTEGER, note TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS object_type (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label_en TEXT, label_es TEXT, plural_en TEXT, plural_es TEXT,
  key_scheme TEXT NOT NULL, icon TEXT, color TEXT, grp TEXT, ephemeral INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS prop_def (
  type TEXT NOT NULL, key TEXT NOT NULL, label_en TEXT, label_es TEXT, vtype TEXT, unit TEXT, format TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0, ord INTEGER, PRIMARY KEY (type, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metric_def (
  type TEXT NOT NULL, metric TEXT NOT NULL, label_en TEXT, label_es TEXT, unit TEXT, PRIMARY KEY (type, metric)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS link_type (
  id TEXT PRIMARY KEY, label_en TEXT, label_es TEXT, inverse_en TEXT, inverse_es TEXT, from_types TEXT, to_types TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ingest_run (
  id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
  status TEXT NOT NULL,          -- ok | error
  objects INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0,
  links INTEGER NOT NULL DEFAULT 0, obs INTEGER NOT NULL DEFAULT 0, expired INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0, note TEXT,
  data_at INTEGER                -- newest observation time carried by the batch
);
CREATE INDEX IF NOT EXISTS ingest_run_source ON ingest_run (source_id, finished_at);

-- rid is the integer handle the FTS and R*Tree indexes point at; an explicit INTEGER PRIMARY KEY survives VACUUM.
CREATE TABLE IF NOT EXISTS object (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,       -- '<type>:<key>'
  type TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  lon REAL, lat REAL,
  status TEXT, severity INTEGER, -- severity 0 none .. 4 extreme
  valid_from INTEGER, valid_to INTEGER,
  first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  source_id TEXT NOT NULL,       -- the source that created it
  geometry TEXT,                 -- GeoJSON geometry when not a point
  expired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS object_type_name ON object (type, expired, name);
-- No index by source: the queries that filter on it (expiry of a feed's objects, lineage counts) are served by the one above.

CREATE TABLE IF NOT EXISTS prop (
  object_id TEXT NOT NULL, key TEXT NOT NULL, value, vtype TEXT NOT NULL, unit TEXT,
  source_id TEXT NOT NULL, observed_at INTEGER NOT NULL, confidence REAL,
  PRIMARY KEY (object_id, key, source_id)
) WITHOUT ROWID;
-- No index on (key, value): it doubled the cost of bulk loads, and a scan by key over the whole table is fast enough.
CREATE TABLE IF NOT EXISTS prop_history (
  object_id TEXT NOT NULL, key TEXT NOT NULL, source_id TEXT NOT NULL, value, vtype TEXT NOT NULL, unit TEXT,
  observed_at INTEGER NOT NULL, replaced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prop_history_object ON prop_history (object_id, key, replaced_at);

CREATE TABLE IF NOT EXISTS link (
  src TEXT NOT NULL, type TEXT NOT NULL, dst TEXT NOT NULL, source_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, confidence REAL, note TEXT,
  PRIMARY KEY (src, type, dst, source_id)
) WITHOUT ROWID;  -- the key is the row: a rowid table plus its unique index stored every link twice
CREATE INDEX IF NOT EXISTS link_dst ON link (dst, type);

-- type is part of the key because several object types share an id scheme (a USGS site can be both a reservoir
-- and a stream gauge; hospitals and schools are both OSM elements).
CREATE TABLE IF NOT EXISTS identity (
  scheme TEXT NOT NULL, key TEXT NOT NULL, type TEXT NOT NULL, object_id TEXT NOT NULL,
  PRIMARY KEY (scheme, key, type)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS identity_object ON identity (object_id);

CREATE TABLE IF NOT EXISTS obs (
  object_id TEXT NOT NULL, metric TEXT NOT NULL, t INTEGER NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (object_id, metric, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS obs_t ON obs (t);

CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY, t INTEGER NOT NULL, action TEXT NOT NULL, object_id TEXT, payload TEXT
);
`;

/** Views are created on every open (IF NOT EXISTS), so a database made by an older build gains the newer ones. */
export const VIEWS_DDL = `
-- Correlated on the primary key so it stays cheap when filtered by object_id or by key.
CREATE VIEW IF NOT EXISTS prop_best AS
SELECT p.object_id, p.key, p.value, p.vtype, p.unit, p.source_id, p.observed_at, p.confidence
FROM prop p
WHERE p.source_id = (
  SELECT q.source_id FROM prop q LEFT JOIN source s ON s.id = q.source_id
  WHERE q.object_id = p.object_id AND q.key = p.key
  ORDER BY (s.kind = 'user') DESC, q.observed_at DESC, q.source_id LIMIT 1
);

CREATE VIEW IF NOT EXISTS object_props AS
SELECT b.object_id, o.type, o.name, b.key, b.value, b.unit, b.source_id, b.observed_at
FROM prop_best b JOIN object o ON o.id = b.object_id;

CREATE VIEW IF NOT EXISTS link_named AS
SELECT l.src, a.name AS src_name, a.type AS src_type, l.type, l.dst, b.name AS dst_name, b.type AS dst_type, l.source_id, l.confidence
FROM link l LEFT JOIN object a ON a.id = l.src LEFT JOIN object b ON b.id = l.dst;
`;

// No prefix indexes: prefix queries fall back to a range scan of the term list, which is instant at this size,
// and the indexes made up a third of the full-text data every visitor downloads.
export const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS object_fts USING fts5(name, type, text, tokenize = "unicode61 remove_diacritics 2");`;
/** Stand-in when FTS5 is not compiled in: same columns, searched with LIKE. */
export const FTS_FALLBACK_DDL = `CREATE TABLE IF NOT EXISTS object_fts (rowid INTEGER PRIMARY KEY, name TEXT, type TEXT, text TEXT);`;

export const RTREE_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS object_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);`;
/** Stand-in when R*Tree is not compiled in: same columns, so the bbox SQL is identical and only the plan differs. */
export const RTREE_FALLBACK_DDL = `
CREATE TABLE IF NOT EXISTS object_rtree (id INTEGER PRIMARY KEY, min_lon REAL, max_lon REAL, min_lat REAL, max_lat REAL);
CREATE INDEX IF NOT EXISTS object_rtree_lon ON object_rtree (min_lon, max_lon);`;
