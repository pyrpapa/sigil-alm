-- Local and CI database only (never applied to the cloud project).
-- Creates the Playwright test user so E2E tests can sign in against the
-- throwaway local Supabase that `npx supabase start` runs.
--   email:    e2e@sigil.test
--   password: sigil-local-e2e   (local only; not a secret)

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  'e2e00000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated',
  'e2e@sigil.test',
  extensions.crypt('sigil-local-e2e', extensions.gen_salt('bf')),
  now(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "E2E Test User"}',
  now(), now(), '', '', '', ''
);

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values (
  gen_random_uuid(),
  'e2e00000-0000-4000-8000-000000000001',
  'e2e00000-0000-4000-8000-000000000001',
  '{"sub": "e2e00000-0000-4000-8000-000000000001", "email": "e2e@sigil.test", "email_verified": true}',
  'email', now(), now(), now()
);

-- Second local test user, used as the QA reviewer in E2E tests.
--   email:    e2e-qa@sigil.test
--   password: sigil-local-e2e   (local only; not a secret)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  'e2e00000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated',
  'e2e-qa@sigil.test',
  extensions.crypt('sigil-local-e2e', extensions.gen_salt('bf')),
  now(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "E2E QA Reviewer"}',
  now(), now(), '', '', '', ''
);

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values (
  gen_random_uuid(),
  'e2e00000-0000-4000-8000-000000000002',
  'e2e00000-0000-4000-8000-000000000002',
  '{"sub": "e2e00000-0000-4000-8000-000000000002", "email": "e2e-qa@sigil.test", "email_verified": true}',
  'email', now(), now(), now()
);

-- Third local test user, used as the Val (Specialist) reviewer in E2E tests.
--   email:    e2e-val@sigil.test
--   password: sigil-local-e2e   (local only; not a secret)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  'e2e00000-0000-4000-8000-000000000003',
  'authenticated', 'authenticated',
  'e2e-val@sigil.test',
  extensions.crypt('sigil-local-e2e', extensions.gen_salt('bf')),
  now(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "E2E Val Reviewer"}',
  now(), now(), '', '', '', ''
);

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values (
  gen_random_uuid(),
  'e2e00000-0000-4000-8000-000000000003',
  'e2e00000-0000-4000-8000-000000000003',
  '{"sub": "e2e00000-0000-4000-8000-000000000003", "email": "e2e-val@sigil.test", "email_verified": true}',
  'email', now(), now(), now()
);
