-- guarded-agent schema. Plain SQL, no ORM, no migration framework.

create table if not exists conversations (
  id                       text primary key,
  status                   text   not null,
  last_customer_message_at bigint,
  turns_without_progress   int    not null default 0,
  updated_at               timestamptz not null default now()
);

create table if not exists messages (
  id              bigserial primary key,
  conversation_id text   not null references conversations(id) on delete cascade,
  role            text   not null,
  text            text   not null,
  at              bigint not null
);
create index if not exists messages_conversation_idx on messages (conversation_id, id);

-- One row per conversation, never more. The primary key IS the coalescing
-- rule: a second message cannot create a second job, it can only extend this
-- one and push its scheduled time forward. That single constraint gives the
-- debounce and makes two concurrent turns of one conversation impossible.
create table if not exists jobs (
  conversation_id text primary key,
  pending         jsonb  not null default '[]'::jsonb,
  run_after       bigint not null,
  attempts        int    not null default 0,
  locked_at       bigint,
  last_error      text
);
create index if not exists jobs_run_after_idx on jobs (run_after);

create table if not exists turns (
  id              text primary key,
  conversation_id text   not null,
  at              bigint not null,
  inbound         text   not null,
  actions         jsonb  not null,
  trace           jsonb  not null
);
create index if not exists turns_conversation_idx on turns (conversation_id, at);
