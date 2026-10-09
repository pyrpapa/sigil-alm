-- Sigil: first migration. A minimal projects table to prove the pipeline.
-- Membership and roles replace the created_by policies in Phase 2.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  system_under_validation text,
  description text,
  status text not null default 'planning'
    check (status in ('planning', 'active', 'complete', 'archived')),
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.projects is 'Validation projects. Every other Sigil record hangs off a project.';

-- Keep updated_at current on every change.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- Row Level Security: on for every table, no exceptions.
alter table public.projects enable row level security;

create policy "Users can view their own projects"
  on public.projects for select
  to authenticated
  using (created_by = (select auth.uid()));

create policy "Users can create projects they own"
  on public.projects for insert
  to authenticated
  with check (created_by = (select auth.uid()));

create policy "Users can update their own projects"
  on public.projects for update
  to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

-- Deliberately no delete policy: projects are archived (status = 'archived'),
-- never deleted, so the record history is preserved.
