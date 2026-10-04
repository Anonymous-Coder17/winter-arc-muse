-- ============================================================================
-- winter-arc-muse · V3.2 — cross-entity ownership integrity
-- Small database-integrity hardening pass before V4. No UI changes, no
-- analytics changes, no new features.
--
-- Problem: challenge_reviews has (owner, challenge_id) and reading_logs has
-- (owner, book_id), but the foreign keys only checked that the referenced
-- challenge/book *exists* — not that it belongs to the same user. RLS
-- protects normal app traffic (owner = auth.uid()), but the relational
-- database itself would accept a review/log pointing at another user's
-- parent if the IDs were ever supplied directly.
--
-- Fix (declarative, same pattern as 0003): composite unique (id, owner) on
-- the parents, then composite foreign keys (child_id, owner) -> (id, owner)
-- on the children. The database itself now rejects any cross-owner
-- parent reference on INSERT and on UPDATE — for any user, RLS or not.
--
-- Preserved behavior:
--   * challenge_reviews keeps ON DELETE CASCADE (deleting your own
--     challenge still removes its reviews — unchanged from V3).
--   * reading_logs keeps ON DELETE RESTRICT (a book with logged pages
--     cannot be hard-deleted — unchanged from V3). book_id is nullable
--     and MATCH SIMPLE skips the check when it is NULL, so the backfilled
--     bookless rows are unaffected.
--   * The V2.2 historical-deletion guard and all RLS policies are
--     untouched.
--
-- Data safety: the new constraints validate existing rows when added. If
-- an old row ever referenced another user's parent, the migration fails
-- loudly instead of silently deleting anything.
-- ============================================================================

-- 1. Composite uniqueness on the parent (id, owner) pairs, so the composite
--    foreign keys below have a unique target.
create unique index if not exists challenges_id_owner_uidx
  on public.challenges (id, owner);
create unique index if not exists books_id_owner_uidx
  on public.books (id, owner);

-- 2. challenge_reviews: a review can only reference a challenge owned by the
--    same user. Replaces the old single-column FK (auto-named
--    challenge_reviews_challenge_id_fkey by the inline REFERENCES in 0005).
alter table public.challenge_reviews
  drop constraint if exists challenge_reviews_challenge_id_fkey;
alter table public.challenge_reviews
  add constraint challenge_reviews_challenge_owner_fkey
  foreign key (challenge_id, owner)
  references public.challenges (id, owner)
  on delete cascade;

-- 3. reading_logs: a log can only reference a book owned by the same user.
--    Replaces the old single-column FK (auto-named reading_logs_book_id_fkey).
alter table public.reading_logs
  drop constraint if exists reading_logs_book_id_fkey;
alter table public.reading_logs
  add constraint reading_logs_book_owner_fkey
  foreign key (book_id, owner)
  references public.books (id, owner)
  on delete restrict;
