-- PROPOSED, NOT APPLIED. Review before running. Nothing in the Worker depends on this migration.
--
-- Finding (read-only schema check, 2026-11-13): public.outreach_suppressions has PRIMARY KEY (email), which is
-- case-sensitive. There is no unique index on lower(email). All existing rows are already lowercase and trimmed
-- (195 rows, 195 distinct lower(email)), and the Worker always writes trim+lowercase, so duplicates cannot arise
-- from the Worker. Hand-added rows such as 'Foo@x.com' next to 'foo@x.com' would not be rejected today.
--
-- Step 1: this must return zero rows, otherwise fix the duplicates first.
select lower(btrim(email)) as e, count(*) from public.outreach_suppressions group by 1 having count(*) > 1;

-- Step 2: enforce case-insensitive uniqueness (keeps the existing primary key).
create unique index concurrently if not exists outreach_suppressions_lower_email_key
  on public.outreach_suppressions (lower(btrim(email)));

-- Note: the Worker sends "Prefer: resolution=ignore-duplicates" without an on_conflict column, i.e. a plain
-- "ON CONFLICT DO NOTHING", so a duplicate on this new index is ignored just like a primary key duplicate.
