create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  password_hash text not null,
  is_admin boolean not null default false,
  is_superadmin boolean not null default false,
  email_verified_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index users_email_lower_idx on users (lower(email));

create table sessions (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_id_idx on sessions (user_id);

create table email_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null check (type in ('verify', 'reset')),
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
create index email_tokens_hash_idx on email_tokens (token_hash);

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  diagram jsonb not null,
  version bigint not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  primary key (project_id, user_id)
);

create table project_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  email text not null,
  role text not null check (role in ('editor', 'viewer')),
  token_hash text not null,
  invited_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz
);
create index project_invitations_email_idx on project_invitations (lower(email));

create table project_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  diagram jsonb not null,
  version bigint not null,
  created_at timestamptz not null default now()
);
create index project_snapshots_project_idx on project_snapshots (project_id, created_at desc);
