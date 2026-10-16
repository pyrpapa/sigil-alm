-- Sigil: user administration (SRS-002).
-- No self-registration: a System Admin creates each account with an email, a printed
-- name and a starting password, and tells the person their password. Nothing is
-- emailed. The person can change their password after signing in.
-- System Admins can also reset a password and grant or remove System Admin.
-- Every one of these changes is recorded in the audit trail.
-- Accounts are written the same way seed.sql creates the local test users.

create function public.require_system_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_system_admin() then
    raise exception 'Only a System Admin can manage user accounts' using errcode = '42501';
  end if;
  return (select auth.uid());
end;
$$;

create function public.check_new_password(p_password text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_password is null or char_length(p_password) < 10 then
    raise exception 'Passwords need at least 10 characters' using errcode = '22023';
  end if;
end;
$$;

-- Audit entries for account changes made outside the audited tables (auth.users).
-- Passwords themselves are never recorded.
create function public.audit_account_change(p_user uuid, p_what text, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (table_name, record_id, project_id, action, changed_by, changed_fields, new_values, reason)
  values ('profiles', p_user::text, null, 'UPDATE', (select auth.uid()), array[p_what],
          jsonb_build_object(p_what, 'changed'), nullif(trim(p_reason), ''));
$$;

-- Every account, for the System Admin page.
create function public.admin_list_users()
returns table (
  id uuid,
  email text,
  full_name text,
  is_system_admin boolean,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  projects int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_system_admin();
  return query
    select u.id, u.email::text, p.full_name, p.is_system_admin, u.created_at, u.last_sign_in_at,
           (select count(*)::int from public.project_members m where m.user_id = u.id)
    from auth.users u join public.profiles p on p.id = u.id
    order by p.full_name, u.email;
end;
$$;

create function public.admin_create_user(p_email text, p_full_name text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_name text := trim(p_full_name);
  v_id uuid := gen_random_uuid();
begin
  perform public.require_system_admin();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if coalesce(v_name, '') = '' then
    raise exception 'Enter the person''s printed name (it appears on their signatures)' using errcode = '23502';
  end if;
  perform public.check_new_password(p_password);
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'An account with that email already exists' using errcode = '23505';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}', jsonb_build_object('full_name', v_name),
    now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          'email', null, now(), now());

  -- The profile is created by the on_auth_user_created trigger (and audited there).
  return v_id;
end;
$$;

create function public.admin_set_password(p_user uuid, p_password text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_system_admin();
  perform public.check_new_password(p_password);
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = p_user;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  perform public.audit_account_change(p_user, 'password', coalesce(p_reason, 'Password reset by a System Admin'));
end;
$$;

create function public.admin_set_system_admin(p_user uuid, p_on boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_system_admin();
  if not p_on and not exists (select 1 from public.profiles where is_system_admin and id <> p_user) then
    raise exception 'There must always be at least one System Admin' using errcode = '42501';
  end if;
  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  update public.profiles set is_system_admin = p_on where id = p_user and is_system_admin <> p_on;
  perform set_config('sigil.change_reason', '', true);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'admin_list_users()', 'admin_create_user(text, text, text)', 'admin_set_password(uuid, text, text)',
    'admin_set_system_admin(uuid, boolean, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['require_system_admin()', 'audit_account_change(uuid, text, text)', 'check_new_password(text)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end;
$$;

-- The first System Admin: if nobody is one yet, the earliest account becomes one.
-- (Normally the person who set Sigil up.)
update public.profiles set is_system_admin = true
where id = (select u.id from auth.users u join public.profiles p on p.id = u.id order by u.created_at limit 1)
  and not exists (select 1 from public.profiles where is_system_admin);

-- Anyone can change their own password, re-entering the current one first.
create function public.change_my_password(p_current text, p_new text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_hash text;
begin
  select encrypted_password into v_hash from auth.users where id = v_uid;
  if v_hash is null or p_current is null or extensions.crypt(p_current, v_hash) <> v_hash then
    raise exception 'Your current password is incorrect' using errcode = '28P01';
  end if;
  perform public.check_new_password(p_new);
  if p_new = p_current then
    raise exception 'Choose a password different from the current one' using errcode = '22023';
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf')), updated_at = now()
   where id = v_uid;
  perform public.audit_account_change(v_uid, 'password', 'Changed by the user');
end;
$$;

revoke execute on function public.change_my_password(text, text) from public, anon;
grant execute on function public.change_my_password(text, text) to authenticated;
