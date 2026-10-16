-- A new field type for numbered requirement statements (ERs). Added in its own
-- migration because a new enum value cannot be used in the transaction that adds it.
alter type public.field_type add value if not exists 'statements';
