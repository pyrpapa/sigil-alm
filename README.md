# Sigil

**An automation-first validation ALM, built by a tester for testers.**

[Live demo](https://sigil-alm.vercel.app/login?demo)** — signs you in as a read-only Viewer on sample data.

Sigil manages the validation lifecycle (requirements, risk, test cases, test runs, deviations, traceability and e-signatures) and treats automated test results as first-class, signed, traceable evidence. It follows GxP and 21 CFR Part 11 practices; it is not certified or claimed to be compliant.

> Status: early setup (Phase 0.5). Demo data only.

## Stack

React + Vite · Supabase (Postgres, Auth, Storage) · Vercel · Playwright · GitHub Actions

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and add your Supabase URL and anon/publishable key.
3. Apply database migrations: `npx supabase db push`
4. `npm run dev` and open http://localhost:5173

Users are created by an admin (no self-registration). For now, add users in the Supabase dashboard under Authentication → Users.

## Change control

Every database change is a versioned SQL migration in `supabase/migrations`. The schema is never edited by hand in the dashboard.
