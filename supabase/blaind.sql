-- =====================================================================
--  БЛАИНД · турнирный менеджер — база данных для Supabase
--  Как применить: Supabase → SQL Editor → New query → вставить ВЕСЬ файл → Run.
--  Скрипт можно запускать повторно: данные не удаляются.
--  В конце скрипт покажет КОД ПЕРВИЧНОЙ НАСТРОЙКИ — он нужен один раз,
--  чтобы задать пароль администратора на странице сайта /#staff.
--
--  Устройство: все таблицы закрыты (RLS без политик), сайт работает только
--  через одну функцию bl_api — это аналог server.js из комплекта.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
--  ТАБЛИЦЫ
-- ---------------------------------------------------------------------
create table if not exists public.bl_config (
  id           int primary key default 1 check (id = 1),
  admin_hash   text,                 -- bcrypt-хеш пароля администратора
  setup_code   text,                 -- одноразовый код первичной настройки
  tv_code      text not null,
  dealer_code  text not null,
  dummy_hash   text not null         -- для одинакового времени ответа при входе
);

create table if not exists public.bl_sessions (
  token_hash  text primary key,      -- sha256 токена; сам токен хранится только у клиента
  kind        text not null check (kind in ('admin','tv','dealer','player')),
  user_id     text,
  expires_at  timestamptz not null
);
create index if not exists bl_sessions_exp on public.bl_sessions (expires_at);

create table if not exists public.bl_state (
  id          int primary key default 1 check (id = 1),
  state       jsonb,
  updated_at  numeric not null default 0
);

create table if not exists public.bl_reqs (
  id       text primary key,
  at       bigint not null,
  type     text not null,
  tb       int not null,
  pid      text not null default '',
  by       text not null default '',
  dice     int not null default 0,
  dealer   text not null default '',
  label    text not null default '',
  chips    bigint not null default 0,
  fee      int not null default 0,
  done     boolean not null default false,
  ok       boolean,
  done_at  bigint
);

create table if not exists public.bl_users (
  id          text primary key,
  nick        text not null,
  nick_key    text not null unique,
  hash        text not null,
  created_at  bigint not null
);

alter table public.bl_users add column if not exists consent_at bigint;   -- когда дано согласие на обработку ПД

create table if not exists public.bl_events (
  id     text primary key,
  title  text not null,
  at     text not null,              -- местное время Барнаула, 'YYYY-MM-DDTHH:MM'
  cap    int not null default 0
);

create table if not exists public.bl_signups (
  event_id  text not null references public.bl_events(id) on delete cascade,
  user_id   text not null references public.bl_users(id) on delete cascade,
  at        bigint not null,
  primary key (event_id, user_id)
);

create table if not exists public.bl_archive (
  id    text primary key,
  name  text not null,
  date  bigint not null,
  rows  jsonb not null
);

create table if not exists public.bl_adjust (
  id    text primary key,
  name  text not null,
  pts   int not null,
  note  text not null default '',
  date  bigint not null
);

create table if not exists public.bl_seasons (       -- архив прошлых сезонов
  id    bigserial primary key,
  at    bigint not null,
  data  jsonb not null
);

create table if not exists public.bl_limits (        -- счётчики: неверные входы, регистрации, заявки
  key    text primary key,
  n      int not null default 0,
  since  bigint not null default 0,
  until  bigint not null default 0
);

-- Все таблицы закрыты: прямого доступа нет ни у кого, кроме функций ниже.
do $$
declare t text;
begin
  foreach t in array array['bl_config','bl_sessions','bl_state','bl_reqs','bl_users','bl_events',
                           'bl_signups','bl_archive','bl_adjust','bl_seasons','bl_limits'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
--  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (недоступны снаружи)
-- ---------------------------------------------------------------------
create or replace function public.bl_now() returns bigint
language sql volatile as $$ select floor(extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create or replace function public.bl_rand_hex(n int) returns text
language sql volatile set search_path = public, extensions as $$ select encode(gen_random_bytes(n), 'hex') $$;

create or replace function public.bl_code6() returns text
language sql volatile set search_path = public, extensions as $$
  select lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0')
$$;

-- нормализация ника: без учёта регистра (латиница и кириллица) и лишних пробелов
create or replace function public.bl_key(v text) returns text
language sql immutable as $$
  select translate(lower(regexp_replace(trim(coalesce(v, '')), '\s+', ' ', 'g')),
                   'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя')
$$;

-- IP клиента (Supabase передаёт его в заголовках запроса)
create or replace function public.bl_ip() returns text
language plpgsql stable as $$
declare h json;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then h := null; end;
  if h is null then return 'local'; end if;
  return coalesce(nullif(h->>'cf-connecting-ip', ''),
                  nullif(trim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)), ''),
                  nullif(h->>'x-real-ip', ''), 'unknown');
end $$;

create or replace function public.bl_blocked(k text) returns boolean
language sql stable as $$ select exists (select 1 from public.bl_limits where key = k and until > public.bl_now()) $$;

-- 5 неверных попыток → блокировка на 10 минут
create or replace function public.bl_fail(k text) returns void
language plpgsql as $$
declare cnt int;
begin
  insert into public.bl_limits(key, n, since) values (k, 1, public.bl_now())
  on conflict (key) do update set n = public.bl_limits.n + 1, since = public.bl_now()
  returning n into cnt;
  if cnt >= 5 then update public.bl_limits set n = 0, until = public.bl_now() + 600000 where key = k; end if;
end $$;

-- счётчик в окне: true, если лимит превышен
create or replace function public.bl_rate(k text, max_n int, window_ms bigint) returns boolean
language plpgsql as $$
declare t bigint := public.bl_now(); r public.bl_limits;
begin
  select * into r from public.bl_limits where key = k for update;
  if not found or r.since < t - window_ms then
    insert into public.bl_limits(key, n, since) values (k, 1, t)
    on conflict (key) do update set n = 1, since = t;
    return false;
  end if;
  if r.n >= max_n then return true; end if;
  update public.bl_limits set n = n + 1 where key = k;
  return false;
end $$;

create or replace function public.bl_new_session(p_kind text, p_user text, p_days int) returns text
language plpgsql set search_path = public, extensions as $$
declare tok text := encode(gen_random_bytes(32), 'hex');
begin
  insert into public.bl_sessions(token_hash, kind, user_id, expires_at)
  values (encode(digest(tok, 'sha256'), 'hex'), p_kind, p_user, now() + make_interval(days => p_days));
  return tok;
end $$;

create or replace function public.bl_session(p_tok text, p_kind text) returns public.bl_sessions
language sql stable set search_path = public, extensions as $$
  select s.* from public.bl_sessions s
   where p_tok is not null and length(p_tok) = 64
     and s.token_hash = encode(digest(p_tok, 'sha256'), 'hex')
     and s.kind = p_kind and s.expires_at > now()
$$;

create or replace function public.bl_check_pw(pw text, h text) returns boolean
language sql stable set search_path = public, extensions as $$ select h is not null and crypt(coalesce(pw, ''), h) = h $$;

create or replace function public.bl_hash_pw(pw text) returns text
language sql volatile set search_path = public, extensions as $$ select crypt(pw, gen_salt('bf', 10)) $$;

-- время турнира из расписания (местное время Барнаула, UTC+7) → миллисекунды UTC
create or replace function public.bl_ev_ms(at text) returns bigint
language sql immutable as $$
  select floor(extract(epoch from ((at || ':00')::timestamp - interval '7 hours')) * 1000)::bigint
$$;

-- рейтинг сезона: итоги турниров + ручные очки
create or replace function public.bl_rating() returns jsonb
language sql stable as $$
  with rows as (
    select r->>'name' as name, coalesce((r->>'pts')::int, 0) as pts, coalesce((r->>'place')::int, 0) as place,
           coalesce((r->>'ko')::int, 0) as ko, 1 as game, a.date, ord
      from public.bl_archive a, jsonb_array_elements(a.rows) with ordinality as x(r, ord)
    union all
    select name, pts, 0, 0, 0, date, 0 from public.bl_adjust
  ), agg as (
    select public.bl_key(name) as k,
           (array_agg(name order by date, ord))[1] as name,
           sum(pts)::int as pts, sum(game)::int as games,
           count(*) filter (where place = 1 and game = 1)::int as wins, sum(ko)::int as ko
      from rows group by public.bl_key(name)
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'pts', pts, 'games', games, 'wins', wins, 'ko', ko)
                            order by pts desc, wins desc, name), '[]'::jsonb)
    from agg
$$;

-- Удалить ник из результатов (по запросу игрока или при удалении аккаунта):
-- в итогах турниров и архиве сезонов ник заменяется на «Игрок удалён», ручные очки удаляются.
create or replace function public.bl_anon_rows(r jsonb, k text) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(case when public.bl_key(x->>'name') = k then jsonb_set(x, '{name}', '"Игрок удалён"') else x end order by o), '[]'::jsonb)
    from jsonb_array_elements(coalesce(r, '[]'::jsonb)) with ordinality t(x, o)
$$;
create or replace function public.bl_anonymize(k text) returns int
language plpgsql as $$
declare n int := 0;
begin
  if coalesce(k, '') = '' then return 0; end if;
  update public.bl_archive set rows = public.bl_anon_rows(rows, k)
   where exists (select 1 from jsonb_array_elements(rows) x where public.bl_key(x->>'name') = k);
  get diagnostics n = row_count;
  delete from public.bl_adjust where public.bl_key(name) = k;
  update public.bl_seasons set data = jsonb_build_object(
      'archive', (select coalesce(jsonb_agg(jsonb_set(a, '{rows}', public.bl_anon_rows(a->'rows', k)) order by o), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(data->'archive', '[]'::jsonb)) with ordinality t(a, o)),
      'adjust',  (select coalesce(jsonb_agg(j order by o), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(data->'adjust', '[]'::jsonb)) with ordinality t(j, o)
                   where public.bl_key(j->>'name') <> k));   -- архив сезонов небольшой, обновляем целиком
  return n;
end $$;

create or replace function public.bl_valid_state(s jsonb) returns boolean
language sql immutable as $$
  select s is not null and jsonb_typeof(s) = 'object'
     and s->'v' = '1'::jsonb
     and jsonb_typeof(s->'t') = 'object'
     and jsonb_typeof(s->'levels') = 'array' and jsonb_array_length(s->'levels') between 1 and 300
     and jsonb_typeof(s->'players') = 'array' and jsonb_array_length(s->'players') <= 3000
     and s ? 'clock' and jsonb_typeof(s->'updatedAt') = 'number'
     and octet_length(s::text) < 2000000
$$;

create or replace function public.bl_pub_reqs() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(q) - 'done_at' order by q.at), '[]'::jsonb)
    from (select * from public.bl_reqs
           where not done or done_at > public.bl_now() - 120000
           order by at desc limit 200) q
$$;

-- ---------------------------------------------------------------------
--  ГЛАВНАЯ ФУНКЦИЯ API (аналог server.js)
--  p_tokens: {"sid": админ, "tv": экран, "dl": крупье, "pu": игрок}
--  Возвращает {"status": код, "body": {...}}
-- ---------------------------------------------------------------------
create or replace function public.bl_api(p_method text, p_path text, p_body jsonb default '{}'::jsonb, p_tokens jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  b      jsonb := coalesce(p_body, '{}'::jsonb);
  tk     jsonb := coalesce(p_tokens, '{}'::jsonb);
  t      bigint := public.bl_now();
  ip     text := public.bl_ip();
  cfg    public.bl_config;
  admin  boolean; tv boolean; dealer boolean;
  me     public.bl_users;
  ps     public.bl_sessions;
  st     public.bl_state;
  u      public.bl_users;
  e      public.bl_events;
  v_nick text; v_pw text; v_tok text; v_id text; v_n int; v_res jsonb; v_k text; v_rows jsonb;
begin
  select * into cfg from public.bl_config where id = 1;
  admin  := (public.bl_session(tk->>'sid', 'admin')).token_hash is not null;
  tv     := (public.bl_session(tk->>'tv', 'tv')).token_hash is not null;
  dealer := (public.bl_session(tk->>'dl', 'dealer')).token_hash is not null;
  ps     := public.bl_session(tk->>'pu', 'player');
  if ps.token_hash is not null then select * into me from public.bl_users where id = ps.user_id; end if;

  -- уборка просроченного
  delete from public.bl_limits where until < t - 3600000 and since < t - 3600000;   -- IP-адреса не храним дольше нужного
  if random() < 0.02 then
    delete from public.bl_sessions where expires_at < now();
    delete from public.bl_reqs where at < t - 86400000;
  end if;

  if p_method = 'GET' then
    if p_path = 'api/me' then
      return jsonb_build_object('status', 200, 'body', jsonb_build_object(
        'app', 'blaind', 'auth', admin, 'tv', tv, 'dealer', dealer, 'now', t,
        'setup', cfg.admin_hash is null,
        'tvCode', case when admin then cfg.tv_code end,
        'dealerCode', case when admin then cfg.dealer_code end));
    end if;

    if p_path = 'api/pub' then
      select * into st from public.bl_state where id = 1;
      v_k := case when me.id is not null then public.bl_key(me.nick) end;
      v_res := jsonb_build_object(
        'me', case when me.id is not null then jsonb_build_object('nick', me.nick) end,
        'events', (select coalesce(jsonb_agg(jsonb_build_object('id', ev.id, 'title', ev.title, 'at', ev.at, 'cap', ev.cap,
                          'count', (select count(*) from public.bl_signups s where s.event_id = ev.id),
                          'mine', me.id is not null and exists (select 1 from public.bl_signups s where s.event_id = ev.id and s.user_id = me.id))
                          order by public.bl_ev_ms(ev.at)), '[]'::jsonb)
                     from public.bl_events ev where public.bl_ev_ms(ev.at) > t - 6 * 3600000),
        'rating', (select coalesce(jsonb_agg(jsonb_build_object('name', r->>'name', 'pts', (r->>'pts')::int, 'games', (r->>'games')::int, 'wins', (r->>'wins')::int) order by ord), '[]'::jsonb)
                     from jsonb_array_elements(public.bl_rating()) with ordinality x(r, ord) where ord <= 300),
        'history', case when v_k is null then '[]'::jsonb else
                     (select coalesce(jsonb_agg(jsonb_build_object('name', a.name, 'date', a.date, 'place', (r->>'place')::int, 'pts', (r->>'pts')::int) order by a.date desc), '[]'::jsonb)
                        from public.bl_archive a, lateral (select r from jsonb_array_elements(a.rows) r where public.bl_key(r->>'name') = v_k limit 1) x) end,
        'live', null, 'now', t);
      if st.state is not null and jsonb_array_length(st.state->'players') > 0 then
        v_res := jsonb_set(v_res, '{live}', jsonb_build_object(
          'name', coalesce(st.state->'t'->>'name', ''),
          'clock', st.state->'clock', 'levels', st.state->'levels',
          'left', (select count(*) from jsonb_array_elements(st.state->'players') p where p->>'st' = 'in'),
          'entries', jsonb_array_length(st.state->'players'),
          'seat', (select jsonb_build_object('tb', (p->>'tb')::int, 'seat', (p->>'seat')::int)
                     from jsonb_array_elements(st.state->'players') p
                    where v_k is not null and p->>'st' = 'in' and coalesce((p->>'tb')::int, 0) > 0
                      and public.bl_key(p->>'name') = v_k limit 1)));
      end if;
      return jsonb_build_object('status', 200, 'body', v_res);
    end if;

    if p_path = 'api/admin/portal' then
      if not admin then return '{"status":401,"body":{"error":"auth"}}'; end if;
      return jsonb_build_object('status', 200, 'body', jsonb_build_object(
        'events', (select coalesce(jsonb_agg(jsonb_build_object('id', ev.id, 'title', ev.title, 'at', ev.at, 'cap', ev.cap,
                     'names', (select coalesce(jsonb_agg(us.nick order by s.at), '[]'::jsonb) from public.bl_signups s join public.bl_users us on us.id = s.user_id where s.event_id = ev.id))
                     order by public.bl_ev_ms(ev.at)), '[]'::jsonb) from public.bl_events ev),
        'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nick', nick, 'createdAt', created_at, 'consentAt', consent_at) order by nick_key), '[]'::jsonb) from public.bl_users),
        'archive', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'date', date, 'count', jsonb_array_length(rows)) order by date desc), '[]'::jsonb) from public.bl_archive),
        'adjust', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'pts', pts, 'note', note, 'date', date) order by date desc), '[]'::jsonb) from public.bl_adjust),
        'rating', public.bl_rating()));
    end if;

    if p_path = 'api/state' or p_path = 'api/poll' then
      if not (admin or tv or dealer) then return '{"status":401,"body":{"error":"auth"}}'; end if;
      select * into st from public.bl_state where id = 1;
      return jsonb_build_object('status', 200, 'body', jsonb_build_object(
        'state', case when p_path = 'api/state' or coalesce(st.updated_at, 0) > coalesce((b->>'since')::numeric, -1) then st.state end,
        'now', t,
        'reqs', case when admin or dealer then public.bl_pub_reqs() end));
    end if;
    return '{"status":404,"body":{"error":"not found"}}';
  end if;

  if p_method <> 'POST' then return '{"status":405,"body":{}}'; end if;

  -- ----- первичная настройка: пароль администратора по одноразовому коду -----
  if p_path = 'api/setup' then
    if cfg.admin_hash is not null then return '{"status":409,"body":{"msg":"Пароль администратора уже задан."}}'; end if;
    if public.bl_blocked('s' || ip) then return '{"status":429,"body":{"msg":"Слишком много попыток. Подождите 10 минут."}}'; end if;
    if coalesce(b->>'code', '') <> cfg.setup_code then
      perform public.bl_fail('s' || ip);
      return '{"status":401,"body":{"msg":"Неверный код настройки."}}';
    end if;
    v_pw := b->>'password';
    if v_pw is null or length(v_pw) < 10 or length(v_pw) > 200 then return '{"status":400,"body":{"msg":"Пароль: от 10 знаков."}}'; end if;
    update public.bl_config set admin_hash = public.bl_hash_pw(v_pw), setup_code = null where id = 1;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true, 'token', public.bl_new_session('admin', null, 30)));
  end if;

  if p_path = 'api/login' then
    if public.bl_blocked('l' || ip) then return '{"status":429,"body":{"error":"wait"}}'; end if;
    if jsonb_typeof(b->'password') = 'string' and length(b->>'password') <= 200
       and public.bl_check_pw(b->>'password', cfg.admin_hash) then
      return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true, 'token', public.bl_new_session('admin', null, 30)));
    end if;
    perform public.bl_fail('l' || ip);
    return '{"status":401,"body":{"error":"bad"}}';
  end if;

  if p_path = 'api/tv' or p_path = 'api/dealer' then
    v_k := case when p_path = 'api/tv' then 't' else 'd' end;
    if public.bl_blocked(v_k || ip) then return '{"status":429,"body":{"error":"wait"}}'; end if;
    if jsonb_typeof(b->'code') = 'string' and b->>'code' = (case when v_k = 't' then cfg.tv_code else cfg.dealer_code end) then
      return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true,
        'token', public.bl_new_session(case when v_k = 't' then 'tv' else 'dealer' end, null, case when v_k = 't' then 365 else 30 end)));
    end if;
    perform public.bl_fail(v_k || ip);
    return '{"status":401,"body":{"error":"bad"}}';
  end if;

  -- ----- игроки -----
  if p_path = 'api/p/register' then
    if public.bl_rate('r' || ip, 5, 3600000) then return '{"status":429,"body":{"msg":"Слишком много регистраций с этого адреса. Попробуйте через час."}}'; end if;
    v_nick := regexp_replace(trim(coalesce(b->>'nick', '')), '\s+', ' ', 'g');
    if v_nick !~ '^[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 _.-]{1,23}$' then
      return '{"status":400,"body":{"msg":"Ник: от 2 до 24 знаков, буквы, цифры, пробел, точка, дефис."}}'; end if;
    v_pw := b->>'password';
    if jsonb_typeof(b->'password') <> 'string' or length(v_pw) < 8 or length(v_pw) > 100 then return '{"status":400,"body":{"msg":"Пароль: от 8 знаков."}}'; end if;
    if b->'adult' is distinct from 'true'::jsonb then return '{"status":400,"body":{"msg":"Регистрация только для тех, кому есть 18 лет."}}'; end if;
    if b->'consent' is distinct from 'true'::jsonb then return '{"status":400,"body":{"msg":"Нужно согласие на обработку персональных данных."}}'; end if;
    if exists (select 1 from public.bl_users where nick_key = public.bl_key(v_nick)) then return '{"status":409,"body":{"msg":"Этот ник уже занят."}}'; end if;
    if (select count(*) from public.bl_users) >= 5000 then return '{"status":503,"body":{"msg":"Регистрация временно закрыта."}}'; end if;
    v_id := public.bl_rand_hex(8);
    insert into public.bl_users(id, nick, nick_key, hash, created_at, consent_at) values (v_id, v_nick, public.bl_key(v_nick), public.bl_hash_pw(v_pw), t, t);
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true, 'token', public.bl_new_session('player', v_id, 90)));
  end if;

  if p_path = 'api/p/login' then
    if public.bl_blocked('p' || ip) then return '{"status":429,"body":{"msg":"Слишком много попыток. Подождите 10 минут."}}'; end if;
    select * into u from public.bl_users where nick_key = public.bl_key(b->>'nick');
    -- хеш считаем всегда, чтобы по времени ответа нельзя было узнать, есть ли такой ник
    if public.bl_check_pw(left(coalesce(b->>'password', ''), 100), coalesce(u.hash, cfg.dummy_hash)) and u.id is not null then
      return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true, 'token', public.bl_new_session('player', u.id, 90)));
    end if;
    perform public.bl_fail('p' || ip);
    return '{"status":401,"body":{"msg":"Неверный ник или пароль."}}';
  end if;

  if p_path = 'api/p/logout' then
    if ps.token_hash is not null then delete from public.bl_sessions where token_hash = ps.token_hash; end if;
    return '{"status":200,"body":{"ok":true}}';
  end if;

  if p_path = 'api/p/signup' or p_path = 'api/p/delete' then
    if me.id is null then return '{"status":401,"body":{"msg":"Войдите в аккаунт."}}'; end if;
    if p_path = 'api/p/delete' then
      perform public.bl_anonymize(me.nick_key);           -- отзыв согласия: ник убирается и из результатов
      delete from public.bl_users where id = me.id;
      delete from public.bl_sessions where kind = 'player' and user_id = me.id;
      return '{"status":200,"body":{"ok":true}}';
    end if;
    select * into e from public.bl_events where id = b->>'event' for update;
    if e.id is null or public.bl_ev_ms(e.at) < t - 6 * 3600000 then return '{"status":404,"body":{"msg":"Турнир не найден."}}'; end if;
    if b->'on' = 'true'::jsonb and not exists (select 1 from public.bl_signups where event_id = e.id and user_id = me.id) then
      if e.cap > 0 and (select count(*) from public.bl_signups where event_id = e.id) >= e.cap then
        return '{"status":409,"body":{"msg":"Мест уже нет."}}'; end if;
      insert into public.bl_signups(event_id, user_id, at) values (e.id, me.id, t);
    elsif b->'on' = 'false'::jsonb then
      delete from public.bl_signups where event_id = e.id and user_id = me.id;
    end if;
    return '{"status":200,"body":{"ok":true}}';
  end if;

  -- ----- заявки крупье: вылет, ребай, аддон, фишки, вызов флора -----
  if p_path = 'api/req' then
    if not (admin or dealer) then return '{"status":401,"body":{"error":"auth"}}'; end if;
    if public.bl_rate('q' || ip, 120, 60000) then return '{"status":429,"body":{"error":"slow"}}'; end if;
    if coalesce(b->>'type', '') not in ('bust','rb','ad','floor','chips') or jsonb_typeof(b->'tb') <> 'number'
       or (b->>'tb')::numeric <> floor((b->>'tb')::numeric) or (b->>'tb')::numeric not between 0 and 99 then
      return '{"status":400,"body":{"error":"invalid"}}'; end if;
    insert into public.bl_reqs(id, at, type, tb, pid, by, dice, dealer, label, chips, fee)
    values (public.bl_rand_hex(8), t, b->>'type', (b->>'tb')::int,
            left(case when jsonb_typeof(b->'pid') = 'string' then b->>'pid' else '' end, 40),
            left(case when jsonb_typeof(b->'by') = 'string' then b->>'by' else '' end, 40),
            case when jsonb_typeof(b->'dice') = 'number' and (b->>'dice')::numeric between 0 and 99 then floor((b->>'dice')::numeric)::int else 0 end,
            left(case when jsonb_typeof(b->'dealer') = 'string' then b->>'dealer' else '' end, 60),
            left(case when jsonb_typeof(b->'label') = 'string' then b->>'label' else '' end, 40),
            case when jsonb_typeof(b->'chips') = 'number' and abs((b->>'chips')::numeric) <= 50000000 then floor((b->>'chips')::numeric)::bigint else 0 end,
            case when jsonb_typeof(b->'fee') = 'number' and (b->>'fee')::numeric between 0 and 100000 then floor((b->>'fee')::numeric)::int else 0 end);
    return '{"status":200,"body":{"ok":true}}';
  end if;

  if p_path = 'api/logout' then
    delete from public.bl_sessions where kind = 'admin' and token_hash = (public.bl_session(tk->>'sid', 'admin')).token_hash;
    return '{"status":200,"body":{"ok":true}}';
  end if;

  -- ----- дальше только администратор -----
  if not admin then return '{"status":401,"body":{"error":"auth"}}'; end if;

  if p_path = 'api/state' then
    if not public.bl_valid_state(b->'state') then return '{"status":400,"body":{"error":"invalid"}}'; end if;
    insert into public.bl_state(id, state, updated_at) values (1, null, 0) on conflict (id) do nothing;
    select * into st from public.bl_state where id = 1 for update;
    if st.state is not null and (b->'state'->>'updatedAt')::numeric < st.updated_at then
      return jsonb_build_object('status', 409, 'body', jsonb_build_object('state', st.state, 'now', t));   -- на сервере уже есть более свежая версия
    end if;
    update public.bl_state set state = b->'state', updated_at = (b->'state'->>'updatedAt')::numeric where id = 1;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true, 'now', t));
  end if;

  if p_path = 'api/req/done' then
    update public.bl_reqs set done = true, ok = coalesce((b->>'ok')::boolean, false), done_at = t where id = b->>'id' and not done;
    return '{"status":200,"body":{"ok":true}}';
  end if;

  if p_path = 'api/admin/event' then
    if trim(coalesce(b->>'title', '')) = '' then return '{"status":400,"body":{"msg":"Укажите название турнира."}}'; end if;
    if coalesce(b->>'at', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then return '{"status":400,"body":{"msg":"Укажите дату и время."}}'; end if;
    begin perform (b->>'at' || ':00')::timestamp; exception when others then return '{"status":400,"body":{"msg":"Укажите дату и время."}}'; end;
    if (select count(*) from public.bl_events) >= 300 then return '{"status":400,"body":{"msg":"Слишком много турниров в расписании, удалите прошедшие."}}'; end if;
    insert into public.bl_events(id, title, at, cap) values (public.bl_rand_hex(6), left(trim(b->>'title'), 80), b->>'at',
      case when jsonb_typeof(b->'cap') = 'number' and (b->>'cap')::numeric between 1 and 500 then floor((b->>'cap')::numeric)::int else 0 end);
    return '{"status":200,"body":{"ok":true}}';
  end if;
  if p_path = 'api/admin/event/del' then delete from public.bl_events where id = b->>'id'; return '{"status":200,"body":{"ok":true}}'; end if;

  if p_path = 'api/admin/archive' then
    if jsonb_typeof(b->'rows') <> 'array' or jsonb_array_length(b->'rows') = 0 or jsonb_array_length(b->'rows') > 1000 then
      return '{"status":400,"body":{"msg":"Нет результатов для записи."}}'; end if;
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', left(trim(r->>'name'), 60),
             'place', least(5000, greatest(0, round(coalesce(nullif(r->>'place', '')::numeric, 0))))::int,
             'pts', least(100000, greatest(0, round(coalesce(nullif(r->>'pts', '')::numeric, 0))))::int,
             'ko', least(1000, greatest(0, round(coalesce(nullif(r->>'ko', '')::numeric, 0))))::int) order by ord), '[]'::jsonb)
      into v_rows
      from jsonb_array_elements(b->'rows') with ordinality x(r, ord)
     where jsonb_typeof(r) = 'object' and jsonb_typeof(r->'name') = 'string' and trim(r->>'name') <> '';
    insert into public.bl_archive(id, name, date, rows) values (public.bl_rand_hex(6), left(coalesce(b->>'name', 'Турнир'), 80), t, v_rows);
    return '{"status":200,"body":{"ok":true}}';
  end if;
  if p_path = 'api/admin/archive/del' then delete from public.bl_archive where id = b->>'id'; return '{"status":200,"body":{"ok":true}}'; end if;

  if p_path = 'api/admin/adjust' then
    v_nick := left(regexp_replace(trim(coalesce(b->>'name', '')), '\s+', ' ', 'g'), 60);
    if v_nick = '' then return '{"status":400,"body":{"msg":"Укажите игрока."}}'; end if;
    if jsonb_typeof(b->'pts') <> 'number' or (b->>'pts')::numeric <> floor((b->>'pts')::numeric)
       or (b->>'pts')::numeric = 0 or abs((b->>'pts')::numeric) > 100000 then
      return '{"status":400,"body":{"msg":"Укажите очки числом, например 50 или -20."}}'; end if;
    if (select count(*) from public.bl_adjust) >= 5000 then return '{"status":400,"body":{"msg":"Слишком много ручных правок."}}'; end if;
    insert into public.bl_adjust(id, name, pts, note, date) values (public.bl_rand_hex(6), v_nick, (b->>'pts')::int, left(trim(coalesce(b->>'note', '')), 80), t);
    return '{"status":200,"body":{"ok":true}}';
  end if;
  if p_path = 'api/admin/adjust/del' then delete from public.bl_adjust where id = b->>'id'; return '{"status":200,"body":{"ok":true}}'; end if;

  if p_path = 'api/admin/season' then
    if exists (select 1 from public.bl_archive) or exists (select 1 from public.bl_adjust) then
      insert into public.bl_seasons(at, data) values (t, jsonb_build_object(
        'archive', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from public.bl_archive a),
        'adjust',  (select coalesce(jsonb_agg(to_jsonb(j)), '[]'::jsonb) from public.bl_adjust j)));
    end if;
    delete from public.bl_archive; delete from public.bl_adjust;
    return '{"status":200,"body":{"ok":true}}';
  end if;

  if p_path = 'api/admin/anonymize' then
    v_k := public.bl_key(b->>'name');
    if v_k = '' then return '{"status":400,"body":{"msg":"Укажите ник."}}'; end if;
    v_n := public.bl_anonymize(v_k);
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true, 'count', v_n));
  end if;

  if p_path = 'api/admin/user/reset' then
    select * into u from public.bl_users where id = b->>'id';
    if u.id is null then return '{"status":404,"body":{"msg":"Аккаунт не найден."}}'; end if;
    v_pw := translate(encode(gen_random_bytes(6), 'base64'), '+/=', 'xyz');
    update public.bl_users set hash = public.bl_hash_pw(v_pw) where id = u.id;
    delete from public.bl_sessions where kind = 'player' and user_id = u.id;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true, 'password', v_pw));
  end if;
  if p_path = 'api/admin/user/del' then
    delete from public.bl_users where id = b->>'id';
    delete from public.bl_sessions where kind = 'player' and user_id = b->>'id';
    return '{"status":200,"body":{"ok":true}}';
  end if;

  if p_path = 'api/admin/codes' then          -- новые коды ТВ и крупье: старые экраны придётся войти заново
    update public.bl_config set tv_code = public.bl_code6(), dealer_code = public.bl_code6() where id = 1;
    delete from public.bl_sessions where kind in ('tv','dealer');
    return '{"status":200,"body":{"ok":true}}';
  end if;

  if p_path = 'api/password' then
    if public.bl_blocked('l' || ip) then return '{"status":429,"body":{"error":"wait"}}'; end if;
    v_pw := b->>'password';
    if jsonb_typeof(b->'password') <> 'string' or length(v_pw) < 10 or length(v_pw) > 200 then return '{"status":400,"body":{"error":"short"}}'; end if;
    if not public.bl_check_pw(b->>'old', cfg.admin_hash) then perform public.bl_fail('l' || ip); return '{"status":401,"body":{"error":"bad"}}'; end if;
    update public.bl_config set admin_hash = public.bl_hash_pw(v_pw) where id = 1;
    delete from public.bl_sessions where kind = 'admin';                 -- остальные сессии сбрасываются
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true, 'token', public.bl_new_session('admin', null, 30)));
  end if;

  return '{"status":404,"body":{"error":"not found"}}';
end $$;

-- ---------------------------------------------------------------------
--  ПРАВА: снаружи доступна только bl_api
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'bl\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
grant execute on function public.bl_api(text, text, jsonb, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------
--  НАЧАЛЬНЫЕ НАСТРОЙКИ (только при первом запуске)
-- ---------------------------------------------------------------------
insert into public.bl_config(id, admin_hash, setup_code, tv_code, dealer_code, dummy_hash)
select 1, null, upper(public.bl_rand_hex(5)), public.bl_code6(), public.bl_code6(), public.bl_hash_pw(public.bl_rand_hex(8))
 where not exists (select 1 from public.bl_config);
insert into public.bl_state(id, state, updated_at) values (1, null, 0) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
--  ПЕРЕНОС ДАННЫХ ПРОШЛОЙ ВЕРСИИ САЙТА (таблицы profiles / tournaments / registrations)
--  Аккаунты переносятся вместе с паролями: Supabase хранит их в bcrypt, как и этот сайт,
--  поэтому игроки входят по нику со своим прежним паролем. Старые таблицы не изменяются.
--  Повторный запуск ничего не дублирует.
-- ---------------------------------------------------------------------
do $$
declare n_users int := 0; n_events int := 0; n_signups int := 0; n_archive int := 0;
begin
  if to_regclass('public.profiles') is null or to_regclass('auth.users') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'nickname') then
    return;
  end if;

  -- аккаунты: ник из профиля, пароль — прежний bcrypt-хеш
  execute $q$
    insert into public.bl_users(id, nick, nick_key, hash, created_at)
    select p.id::text, left(regexp_replace(trim(p.nickname), '\s+', ' ', 'g'), 24), public.bl_key(left(regexp_replace(trim(p.nickname), '\s+', ' ', 'g'), 24)),
           u.encrypted_password, floor(extract(epoch from coalesce(p.created_at, now())) * 1000)::bigint
      from public.profiles p join auth.users u on u.id = p.id
     where coalesce(u.encrypted_password, '') like '$2%' and coalesce(trim(p.nickname), '') <> ''
     order by p.created_at
    on conflict do nothing $q$;
  get diagnostics n_users = row_count;

  if to_regclass('public.tournaments') is not null and to_regclass('public.registrations') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tournaments' and column_name = 'max_players') then
    -- предстоящие турниры → расписание (время Барнаула)
    execute $q$
      insert into public.bl_events(id, title, at, cap)
      select t.id::text, left(t.title, 80), to_char(t.starts_at at time zone 'UTC' + interval '7 hours', 'YYYY-MM-DD"T"HH24:MI'), least(greatest(t.max_players, 0), 500)
        from public.tournaments t
       where t.status in ('scheduled', 'running') and t.starts_at > now() - interval '6 hours'
      on conflict do nothing $q$;
    get diagnostics n_events = row_count;

    -- записи на эти турниры
    execute $q$
      insert into public.bl_signups(event_id, user_id, at)
      select r.tournament_id::text, r.user_id::text, floor(extract(epoch from r.created_at) * 1000)::bigint
        from public.registrations r
       where r.user_id is not null and r.status <> 'waitlist'
         and exists (select 1 from public.bl_events e where e.id = r.tournament_id::text)
         and exists (select 1 from public.bl_users u where u.id = r.user_id::text)
      on conflict do nothing $q$;
    get diagnostics n_signups = row_count;

    -- сыгранные рейтинговые турниры с местами → рейтинг сезона
    execute $q$
      insert into public.bl_archive(id, name, date, rows)
      select t.id::text, left(t.title, 80), floor(extract(epoch from t.starts_at) * 1000)::bigint,
             jsonb_agg(jsonb_build_object('name', coalesce(p.nickname, r.guest_name), 'place', r.place,
                                          'pts', round(r.points)::int, 'ko', r.knockouts) order by r.place)
        from public.tournaments t
        join public.registrations r on r.tournament_id = t.id and r.place is not null
        left join public.profiles p on p.id = r.user_id
       where t.status = 'finished' and t.is_rating
         and not exists (select 1 from public.bl_archive a where a.id = t.id::text)
       group by t.id, t.title, t.starts_at $q$;
    get diagnostics n_archive = row_count;
  end if;

  if n_users + n_events + n_signups + n_archive > 0 then
    raise notice 'Перенесено из прошлой версии: аккаунтов %, турниров в расписании %, записей %, турниров в рейтинг %', n_users, n_events, n_signups, n_archive;
  end if;
end $$;

-- Результат: код первичной настройки (или сообщение, что пароль уже задан)
select case when admin_hash is null
            then 'КОД ПЕРВИЧНОЙ НАСТРОЙКИ: ' || setup_code || '  — откройте сайт/#staff и задайте пароль администратора'
            else 'Пароль администратора уже задан. Всё готово.' end as "БЛАИНД"
  from public.bl_config where id = 1;
