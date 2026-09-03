-- Bind reusable delegated authority to one browser session and immutable tool
-- definition, and preserve the exact result schema used when an execution is
-- created. Existing preview rows were verified empty before this migration.

ALTER TABLE grants ADD COLUMN session_id TEXT REFERENCES browser_sessions(session_id);
ALTER TABLE grants ADD COLUMN source_url TEXT;
ALTER TABLE grants ADD COLUMN tool_digest TEXT;

ALTER TABLE executions ADD COLUMN catalog_revision TEXT;
ALTER TABLE executions ADD COLUMN tool_digest TEXT;
ALTER TABLE executions ADD COLUMN output_schema_json TEXT;
