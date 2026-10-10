-- OnPoint v1 — new enum values.
-- Kept in its own migration: Postgres won't let a new enum value be used in the
-- same transaction that adds it.

alter type exception_type add value if not exists 'special_mismatch';
alter type exception_type add value if not exists 'went_into_minus';
alter type exception_type add value if not exists 'low_stock';

alter type subscription_plan add value if not exists 'free';
