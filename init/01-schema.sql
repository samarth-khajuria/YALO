-- Local docker-compose convenience: bootstrap the messages table.
-- The control-plane also creates this idempotently at startup, so this file
-- is optional — it just seeds the schema when the Postgres volume is fresh.

CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    persona TEXT NOT NULL,
    role TEXT NOT NULL,          -- 'user' or 'assistant'
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
