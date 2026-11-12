-- Stored session_id is (host, sessionId)-scoped in practice, so transcripts address both columns.
create table if not exists events (
  host text not null,
  event_id text not null,
  session_id text,
  project text not null,
  ts timestamptz not null,
  kind text not null,
  payload jsonb not null default '{}',
  content text not null default '',
  primary key (host, event_id)
);

create index if not exists events_session_idx on events (session_id, ts);
create index if not exists events_project_idx on events (project, ts);
