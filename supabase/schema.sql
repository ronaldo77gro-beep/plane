-- =====================================================================
--  БЛАЙНД · спортивный покер — схема базы данных для Supabase
--  Как применить: Supabase → SQL Editor → New query → вставить ВЕСЬ файл → Run.
--  Скрипт можно запускать повторно: он ничего не удаляет из данных.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
--  ТАБЛИЦЫ
-- ---------------------------------------------------------------------

-- Публичный профиль игрока (виден всем: ник, имя, роль)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 2 and 24),
  full_name   text,
  city        text,
  about       text,
  role        text not null default 'player' check (role in ('player','dealer','admin')),
  is_banned   boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists profiles_nickname_uq on public.profiles (lower(nickname));

-- Контакты (видят только сам игрок, крупье и администраторы)
create table if not exists public.profile_contacts (
  user_id   uuid primary key references public.profiles(id) on delete cascade,
  email     text,
  phone     text,
  telegram  text
);

-- Турниры
create table if not exists public.tournaments (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null check (char_length(title) between 2 and 120),
  description        text,
  starts_at          timestamptz not null,
  location           text,
  buy_in             integer not null default 0 check (buy_in >= 0),
  rebuy_price        integer not null default 0 check (rebuy_price >= 0),
  addon_price        integer not null default 0 check (addon_price >= 0),
  starting_stack     integer not null default 10000 check (starting_stack >= 0),
  max_players        integer not null default 27 check (max_players between 2 and 1000),
  seats_per_table    integer not null default 9 check (seats_per_table between 2 and 12),
  status             text not null default 'scheduled'
                       check (status in ('scheduled','running','finished','cancelled')),
  registration_open  boolean not null default true,
  is_rating          boolean not null default true,      -- идёт в рейтинг
  points_multiplier  numeric(4,2) not null default 1 check (points_multiplier >= 0),
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists tournaments_starts_idx on public.tournaments (starts_at);

-- Записи игроков на турнир (бронь места, рассадка, результаты)
create table if not exists public.registrations (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  user_id        uuid references public.profiles(id) on delete cascade,
  guest_name     text,                                   -- игрок без аккаунта (добавляет крупье)
  status         text not null default 'registered'
                   check (status in ('registered','waitlist','checked_in')),
  table_no       integer,
  seat_no        integer,
  rebuys         integer not null default 0 check (rebuys >= 0),
  addons         integer not null default 0 check (addons >= 0),
  knockouts      integer not null default 0 check (knockouts >= 0),
  place          integer check (place is null or place > 0),
  points         numeric(8,1) not null default 0,
  prize          integer not null default 0 check (prize >= 0),
  created_at     timestamptz not null default now(),
  check (user_id is not null or nullif(trim(guest_name),'') is not null)
);
create unique index if not exists registrations_user_uq
  on public.registrations (tournament_id, user_id) where user_id is not null;
create index if not exists registrations_tournament_idx on public.registrations (tournament_id);
create index if not exists registrations_user_idx on public.registrations (user_id);

-- Состояние таймера блайндов (таймер timer.html). id = 'blind-timer' или 't:<id турнира>'
create table if not exists public.timer_state (
  id          text primary key,
  data        jsonb,
  updated_at  timestamptz default now()
);

-- ---------------------------------------------------------------------
--  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ РОЛЕЙ
-- ---------------------------------------------------------------------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid() and not is_banned), 'guest');
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() in ('dealer','admin');
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() = 'admin';
$$;

-- ---------------------------------------------------------------------
--  ТРИГГЕРЫ
-- ---------------------------------------------------------------------

-- Создание профиля при регистрации. Первый зарегистрированный — администратор.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text;
  nick text;
  i    int := 0;
begin
  base := coalesce(nullif(trim(new.raw_user_meta_data->>'nickname'), ''),
                   nullif(split_part(coalesce(new.email,''), '@', 1), ''),
                   'player');
  base := left(base, 20);
  if char_length(base) < 2 then base := base || '_p'; end if;
  nick := base;
  while exists (select 1 from public.profiles where lower(nickname) = lower(nick)) loop
    i := i + 1;
    nick := left(base, 20) || i::text;
  end loop;

  insert into public.profiles (id, nickname, full_name, role)
  values (new.id, nick,
          nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
          case when exists (select 1 from public.profiles) then 'player' else 'admin' end)
  on conflict (id) do nothing;

  insert into public.profile_contacts (user_id, email, phone)
  values (new.id, new.email, nullif(trim(new.raw_user_meta_data->>'phone'), ''))
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Профили для пользователей, которые уже были в auth.users до запуска скрипта
insert into public.profiles (id, nickname)
select au.id, 'player_' || left(replace(au.id::text, '-', ''), 8)
  from auth.users au
 where not exists (select 1 from public.profiles p where p.id = au.id);
insert into public.profile_contacts (user_id, email)
select au.id, au.email from auth.users au
 where not exists (select 1 from public.profile_contacts c where c.user_id = au.id);

-- Роль и блокировку может менять только администратор
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role or new.is_banned is distinct from old.is_banned then
      raise exception 'Менять роль и блокировку может только администратор';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

-- ---------------------------------------------------------------------
--  RPC: бронирование мест
-- ---------------------------------------------------------------------

-- Переносит игроков из листа ожидания, если освободились места
create or replace function public.promote_waitlist(p_tournament uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  t      public.tournaments;
  taken  int;
  moved  int := 0;
  r      record;
begin
  select * into t from public.tournaments where id = p_tournament for update;
  if not found then return 0; end if;
  select count(*) into taken from public.registrations
   where tournament_id = p_tournament and status in ('registered','checked_in');
  for r in select id from public.registrations
            where tournament_id = p_tournament and status = 'waitlist'
            order by created_at loop
    exit when taken >= t.max_players;
    update public.registrations set status = 'registered' where id = r.id;
    taken := taken + 1;
    moved := moved + 1;
  end loop;
  return moved;
end $$;

-- Игрок бронирует место. Возвращает 'registered' или 'waitlist'.
create or replace function public.book_seat(p_tournament uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  uid    uuid := auth.uid();
  t      public.tournaments;
  taken  int;
  st     text;
  cur    text;
begin
  if uid is null then raise exception 'Нужно войти в аккаунт'; end if;
  if exists (select 1 from public.profiles where id = uid and is_banned) then
    raise exception 'Ваш аккаунт заблокирован';
  end if;

  select * into t from public.tournaments where id = p_tournament for update;
  if not found then raise exception 'Турнир не найден'; end if;
  if t.status <> 'scheduled' or not t.registration_open then
    raise exception 'Регистрация на этот турнир закрыта';
  end if;

  select status into cur from public.registrations where tournament_id = p_tournament and user_id = uid;
  if cur is not null then return cur; end if;

  select count(*) into taken from public.registrations
   where tournament_id = p_tournament and status in ('registered','checked_in');
  st := case when taken < t.max_players then 'registered' else 'waitlist' end;

  insert into public.registrations (tournament_id, user_id, status) values (p_tournament, uid, st);
  return st;
end $$;

-- Игрок отменяет бронь
create or replace function public.cancel_booking(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  t   public.tournaments;
begin
  if uid is null then raise exception 'Нужно войти в аккаунт'; end if;
  select * into t from public.tournaments where id = p_tournament for update;
  if not found then raise exception 'Турнир не найден'; end if;
  if t.status <> 'scheduled' then
    raise exception 'Турнир уже начался — отменить бронь может только крупье';
  end if;
  delete from public.registrations where tournament_id = p_tournament and user_id = uid;
  perform public.promote_waitlist(p_tournament);
end $$;

-- ---------------------------------------------------------------------
--  RPC: завершение турнира и начисление очков рейтинга
--  Очки = round(10 * sqrt(N) / sqrt(место) * множитель), N — число участников
-- ---------------------------------------------------------------------
create or replace function public.calc_points(p_players int, p_place int, p_mult numeric)
returns numeric language sql immutable as $$
  select case when p_place is null or p_players < 1 then 0
              else round(10 * sqrt(p_players::numeric) / sqrt(p_place::numeric) * p_mult, 1) end;
$$;

create or replace function public.finish_tournament(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t        public.tournaments;
  n        int;
  left_cnt int;
begin
  if not public.is_staff() then raise exception 'Недостаточно прав'; end if;
  select * into t from public.tournaments where id = p_tournament for update;
  if not found then raise exception 'Турнир не найден'; end if;

  -- лист ожидания в турнире не участвовал
  delete from public.registrations where tournament_id = p_tournament and status = 'waitlist';

  select count(*) into n from public.registrations where tournament_id = p_tournament;
  select count(*) into left_cnt from public.registrations where tournament_id = p_tournament and place is null;
  if left_cnt = 1 then
    update public.registrations set place = 1 where tournament_id = p_tournament and place is null;
  end if;

  update public.registrations
     set points = case when t.is_rating then public.calc_points(n, place, t.points_multiplier) else 0 end
   where tournament_id = p_tournament;

  update public.tournaments set status = 'finished', registration_open = false where id = p_tournament;
end $$;

-- Пересчитать очки (если крупье поправил места после завершения)
create or replace function public.recalc_points(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.tournaments;
  n int;
begin
  if not public.is_staff() then raise exception 'Недостаточно прав'; end if;
  select * into t from public.tournaments where id = p_tournament;
  select count(*) into n from public.registrations where tournament_id = p_tournament and status <> 'waitlist';
  update public.registrations
     set points = case when t.is_rating then public.calc_points(n, place, t.points_multiplier) else 0 end
   where tournament_id = p_tournament and status <> 'waitlist';
end $$;

-- ---------------------------------------------------------------------
--  РЕЙТИНГ
-- ---------------------------------------------------------------------
create or replace function public.get_leaderboard(p_from timestamptz default null, p_to timestamptz default null)
returns table (
  user_id uuid, nickname text, points numeric, games bigint,
  wins bigint, top3 bigint, best_place integer, knockouts bigint, prizes bigint
)
language sql stable security definer set search_path = public as $$
  select p.id, p.nickname,
         coalesce(sum(r.points), 0)                         as points,
         count(*)                                           as games,
         count(*) filter (where r.place = 1)                as wins,
         count(*) filter (where r.place <= 3)               as top3,
         min(r.place)                                       as best_place,
         coalesce(sum(r.knockouts), 0)                      as knockouts,
         coalesce(sum(r.prize), 0)                          as prizes
    from public.registrations r
    join public.tournaments t on t.id = r.tournament_id
    join public.profiles p    on p.id = r.user_id
   where t.status = 'finished' and t.is_rating and r.status <> 'waitlist'
     and t.starts_at >= coalesce(p_from, '-infinity'::timestamptz)
     and t.starts_at <  coalesce(p_to,   'infinity'::timestamptz)
   group by p.id, p.nickname
   order by points desc, wins desc, top3 desc, games asc, p.nickname;
$$;

-- ---------------------------------------------------------------------
--  ПРЕДСТАВЛЕНИЕ: турниры с количеством занятых мест
-- ---------------------------------------------------------------------
drop view if exists public.tournaments_view;
create view public.tournaments_view with (security_invoker = true) as
select t.*,
       (select count(*) from public.registrations r
         where r.tournament_id = t.id and r.status in ('registered','checked_in'))::int as seats_taken,
       (select count(*) from public.registrations r
         where r.tournament_id = t.id and r.status = 'waitlist')::int as waitlist_count
  from public.tournaments t;

-- ---------------------------------------------------------------------
--  ПРАВА ДОСТУПА (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.profile_contacts enable row level security;
alter table public.tournaments      enable row level security;
alter table public.registrations    enable row level security;
alter table public.timer_state      enable row level security;

-- Удаляем все старые политики на этих таблицах (в т.ч. «всем можно всё» для таймера)
do $$
declare pol record;
begin
  for pol in select policyname, tablename from pg_policies
              where schemaname = 'public'
                and tablename in ('profiles','profile_contacts','tournaments','registrations','timer_state') loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- profiles
create policy profiles_read   on public.profiles for select using (true);
create policy profiles_update on public.profiles for update
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
create policy profiles_delete on public.profiles for delete using (public.is_admin());

-- profile_contacts
create policy contacts_read   on public.profile_contacts for select using (user_id = auth.uid() or public.is_staff());
create policy contacts_insert on public.profile_contacts for insert with check (user_id = auth.uid() or public.is_admin());
create policy contacts_update on public.profile_contacts for update
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

-- tournaments: смотрят все, создают/меняют крупье и админы, удаляют админы
create policy tournaments_read   on public.tournaments for select using (true);
create policy tournaments_insert on public.tournaments for insert with check (public.is_staff());
create policy tournaments_update on public.tournaments for update using (public.is_staff()) with check (public.is_staff());
create policy tournaments_delete on public.tournaments for delete using (public.is_admin());

-- registrations: смотрят все, игроки записываются через book_seat/cancel_booking, крупье управляют
create policy registrations_read   on public.registrations for select using (true);
create policy registrations_insert on public.registrations for insert with check (public.is_staff());
create policy registrations_update on public.registrations for update using (public.is_staff()) with check (public.is_staff());
create policy registrations_delete on public.registrations for delete using (public.is_staff());

-- timer_state: экран TV читает без входа, управляет только персонал
create policy timer_read   on public.timer_state for select using (true);
create policy timer_insert on public.timer_state for insert with check (public.is_staff());
create policy timer_update on public.timer_state for update using (public.is_staff()) with check (public.is_staff());
create policy timer_delete on public.timer_state for delete using (public.is_staff());

-- Гранты (RLS выше всё равно ограничивает строки)
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.tournaments, public.registrations, public.timer_state,
                public.tournaments_view to anon, authenticated;
grant select, insert, update, delete on public.profiles, public.profile_contacts, public.tournaments,
                public.registrations, public.timer_state to authenticated;
grant execute on function public.get_leaderboard(timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.my_role(), public.is_staff(), public.is_admin() to anon, authenticated;
grant execute on function public.book_seat(uuid), public.cancel_booking(uuid), public.promote_waitlist(uuid),
                public.finish_tournament(uuid), public.recalc_points(uuid) to authenticated;

-- =====================================================================
--  ГОТОВО.
--  Первый зарегистрированный на сайте пользователь автоматически станет администратором.
--  Назначить администратора вручную:
--    update public.profiles set role = 'admin' where nickname = 'ВашНик';
-- =====================================================================
