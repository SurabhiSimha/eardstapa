-- Eardstapa shared pins. Paste this whole file into the Supabase SQL editor and run it once.
--
-- A "circle" is a group of people who share one code. The app never sends the code itself,
-- only a SHA-256 fingerprint of it, and that fingerprint is what rows are filed under.
-- The table cannot be read or written directly: everything goes through the three functions
-- below, each of which needs the circle fingerprint. Know the code, see and edit the pins.

create table if not exists public.pins (
  id         uuid primary key default gen_random_uuid(),
  circle     text not null check (circle ~ '^[0-9a-f]{64}$'),
  lat        double precision not null check (lat between -90 and 90),
  lon        double precision not null check (lon between -180 and 180),
  emoji      text not null default '✨' check (char_length(emoji) <= 8),
  note       text not null check (char_length(note) between 1 and 140),
  created_at timestamptz not null default now()
);
create index if not exists pins_circle_idx on public.pins (circle);

alter table public.pins enable row level security;      -- no policies on purpose: no direct access
revoke all on public.pins from anon, authenticated;

create or replace function public.get_pins(p_circle text)
returns table (id uuid, lat double precision, lon double precision, emoji text, note text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select p.id, p.lat, p.lon, p.emoji, p.note, p.created_at
  from pins p where p.circle = p_circle order by p.created_at;
$$;

create or replace function public.add_pin(p_circle text, p_lat double precision, p_lon double precision, p_emoji text, p_note text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if (select count(*) from pins where circle = p_circle) >= 2000 then
    raise exception 'this circle is full';
  end if;
  insert into pins (circle, lat, lon, emoji, note)
  values (p_circle, p_lat, p_lon, coalesce(nullif(p_emoji, ''), '✨'), p_note)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.delete_pin(p_circle text, p_id uuid)
returns void
language sql security definer set search_path = public as $$
  delete from pins where id = p_id and circle = p_circle;
$$;

revoke all on function public.get_pins(text), public.add_pin(text, double precision, double precision, text, text), public.delete_pin(text, uuid) from public;
grant execute on function public.get_pins(text), public.add_pin(text, double precision, double precision, text, text), public.delete_pin(text, uuid) to anon, authenticated;
