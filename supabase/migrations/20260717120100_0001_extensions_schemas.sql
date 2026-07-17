-- Phase 0 · unit 2 — extensions + internal schema.
-- Applies on real Supabase (citext/btree_gist are pre-installed → these are no-ops)
-- and on plain Postgres 17 (after supabase/tests/_bootstrap.sql).

create extension if not exists citext;
create extension if not exists btree_gist;

-- Internal schema: RLS helpers now, materialized views / jobs queue later.
-- NOT PostgREST-exposed — only public is.
create schema if not exists app;
comment on schema app is 'Kelo-internal helpers (RLS definer functions; later matviews/jobs). Never PostgREST-exposed.';
