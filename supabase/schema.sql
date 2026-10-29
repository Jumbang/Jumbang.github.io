-- Akari Suite Booking System: Supabase backend.
-- Data lives in the private schema "akari" (not exposed over the REST API). The browser calls a single
-- SECURITY DEFINER function public.api(method, path, body, token) that mirrors the HTTP API of server.py.
-- public.sync_version is readable by anyone (it only holds a counter) and is broadcast over Realtime so
-- every phone knows when to reload.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS akari;
REVOKE ALL ON SCHEMA akari FROM PUBLIC;

CREATE TABLE IF NOT EXISTS akari.meta (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS akari.users (
  id serial PRIMARY KEY, username text NOT NULL, name text NOT NULL, role text NOT NULL DEFAULT 'staff',
  pw_hash text NOT NULL, active integer NOT NULL DEFAULT 1, created_at text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON akari.users (lower(username));
CREATE TABLE IF NOT EXISTS akari.sessions (
  token text PRIMARY KEY, user_id integer NOT NULL REFERENCES akari.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS akari.rooms (
  id serial PRIMARY KEY, name text NOT NULL, kind text DEFAULT '', capacity integer DEFAULT 2,
  rate double precision DEFAULT 0, color text DEFAULT '#4f46e5', active integer NOT NULL DEFAULT 1,
  sort integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS akari.bookings (
  id serial PRIMARY KEY, ref text UNIQUE NOT NULL, room_id integer NOT NULL REFERENCES akari.rooms(id),
  guest_name text NOT NULL, phone text DEFAULT '', email text DEFAULT '', guests integer DEFAULT 1,
  check_in text NOT NULL, check_out text NOT NULL, total double precision NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'booked', source text DEFAULT '', notes text DEFAULT '',
  created_by integer, created_at text NOT NULL, updated_at text NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bookings_dates ON akari.bookings (check_in, check_out);
CREATE TABLE IF NOT EXISTS akari.payments (
  id serial PRIMARY KEY, booking_id integer NOT NULL REFERENCES akari.bookings(id) ON DELETE CASCADE,
  amount double precision NOT NULL, method text DEFAULT 'cash', paid_on text NOT NULL, note text DEFAULT '',
  created_by integer, created_at text NOT NULL);
CREATE TABLE IF NOT EXISTS akari.activity (
  id serial PRIMARY KEY, at text NOT NULL, user_id integer, action text NOT NULL, booking_id integer,
  detail text DEFAULT '');

CREATE TABLE IF NOT EXISTS public.sync_version (id integer PRIMARY KEY DEFAULT 1, version bigint NOT NULL DEFAULT 0);
INSERT INTO public.sync_version (id, version) VALUES (1, 0) ON CONFLICT DO NOTHING;
ALTER TABLE public.sync_version ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_version_read ON public.sync_version;
CREATE POLICY sync_version_read ON public.sync_version FOR SELECT USING (true);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.sync_version FROM anon, authenticated;
    GRANT SELECT ON public.sync_version TO anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'sync_version') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sync_version;
  END IF;
END $$;

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION akari.fail(p_status int, p_msg text, p_extra jsonb DEFAULT '{}') RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_msg,
    DETAIL = jsonb_build_object('status', p_status, 'extra', p_extra)::text;
END $$;

CREATE OR REPLACE FUNCTION akari.now_iso() RETURNS text LANGUAGE sql AS
$$ SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') $$;

CREATE OR REPLACE FUNCTION akari.today() RETURNS text LANGUAGE sql AS
$$ SELECT ((now() AT TIME ZONE 'Asia/Manila')::date)::text $$;

CREATE OR REPLACE FUNCTION akari.s(b jsonb, k text, maxlen int DEFAULT 2000) RETURNS text LANGUAGE sql AS
$$ SELECT left(btrim(coalesce(b ->> k, '')), maxlen) $$;

CREATE OR REPLACE FUNCTION akari.req(b jsonb, k text, label text, maxlen int DEFAULT 200) RETURNS text
LANGUAGE plpgsql AS $$ DECLARE v text := akari.s(b, k, maxlen); BEGIN
  IF v = '' THEN PERFORM akari.fail(400, label || ' is required'); END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION akari.n(b jsonb, k text, dflt double precision DEFAULT 0) RETURNS double precision
LANGUAGE plpgsql AS $$ DECLARE v text := btrim(coalesce(b ->> k, '')); BEGIN
  IF v = '' THEN RETURN dflt; END IF;
  BEGIN RETURN round(v::numeric, 2)::double precision;
  EXCEPTION WHEN others THEN PERFORM akari.fail(400, k || ' must be a number'); END;
END $$;

CREATE OR REPLACE FUNCTION akari.d(b jsonb, k text, label text) RETURNS text
LANGUAGE plpgsql AS $$ DECLARE v text := coalesce(b ->> k, ''); BEGIN
  IF v !~ '^\d{4}-\d{2}-\d{2}$' THEN PERFORM akari.fail(400, label || ' must be a valid date'); END IF;
  BEGIN RETURN (v::date)::text;
  EXCEPTION WHEN others THEN PERFORM akari.fail(400, label || ' must be a valid date'); END;
END $$;

CREATE OR REPLACE FUNCTION akari.truthy(b jsonb, k text, dflt boolean DEFAULT false) RETURNS boolean LANGUAGE sql AS
$$ SELECT CASE WHEN NOT (b ? k) OR b -> k = 'null'::jsonb THEN dflt
               ELSE lower(coalesce(b ->> k, '')) NOT IN ('', 'false', '0', 'off', 'no') END $$;

CREATE OR REPLACE FUNCTION akari.hash_pw(pw text) RETURNS text LANGUAGE sql AS
$$ SELECT extensions.crypt(pw, extensions.gen_salt('bf', 8)) $$;

CREATE OR REPLACE FUNCTION akari.check_pw(pw text, stored text) RETURNS boolean LANGUAGE sql AS
$$ SELECT stored = extensions.crypt(pw, stored) $$;

CREATE OR REPLACE FUNCTION akari.bump() RETURNS bigint LANGUAGE sql AS
$$ UPDATE public.sync_version SET version = version + 1 WHERE id = 1 RETURNING version $$;

CREATE OR REPLACE FUNCTION akari.log(p_user jsonb, p_action text, p_booking int DEFAULT NULL, p_detail text DEFAULT '')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO akari.activity (at, user_id, action, booking_id, detail)
  VALUES (akari.now_iso(), (p_user ->> 'id')::int, p_action, p_booking, coalesce(p_detail, ''))
$$;

CREATE OR REPLACE FUNCTION akari.num_txt(x double precision) RETURNS text LANGUAGE sql AS
$$ SELECT CASE WHEN x = trunc(x) THEN trunc(x)::bigint::text ELSE x::text END $$;

CREATE OR REPLACE FUNCTION akari.settings() RETURNS jsonb LANGUAGE sql AS $$
  SELECT '{"business_name": "Akari Suites", "currency": "₱", "check_in_time": "14:00", "check_out_time": "12:00"}'::jsonb
         || coalesce((SELECT value FROM akari.meta WHERE key = 'settings'), '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION akari.public_user(u akari.users) RETURNS jsonb LANGUAGE sql AS
$$ SELECT jsonb_build_object('id', u.id, 'username', u.username, 'name', u.name, 'role', u.role, 'active', u.active) $$;

CREATE OR REPLACE FUNCTION akari.new_session(p_uid int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE t text := encode(extensions.gen_random_bytes(32), 'hex'); BEGIN
  DELETE FROM akari.sessions WHERE expires_at < now();
  INSERT INTO akari.sessions (token, user_id, expires_at) VALUES (t, p_uid, now() + interval '60 days');
  RETURN t;
END $$;

CREATE OR REPLACE FUNCTION akari.require_admin(p_user jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF p_user ->> 'role' <> 'admin' THEN PERFORM akari.fail(403, 'Only the owner/admin can do this'); END IF;
END $$;

CREATE OR REPLACE FUNCTION akari.load_booking(p_id int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN
  SELECT to_jsonb(b) INTO r FROM akari.bookings b WHERE id = p_id;
  IF r IS NULL THEN PERFORM akari.fail(404, 'Booking not found'); END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION akari.conflicts(p_room int, p_ci text, p_co text, p_exclude int DEFAULT NULL) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'ref', ref, 'guest_name', guest_name,
                                               'check_in', check_in, 'check_out', check_out) ORDER BY check_in), '[]')
  FROM akari.bookings WHERE room_id = p_room AND status NOT IN ('cancelled', 'no_show')
   AND check_in < p_co AND check_out > p_ci AND (p_exclude IS NULL OR id <> p_exclude)
$$;

CREATE OR REPLACE FUNCTION akari.booking_fields(body jsonb, existing jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE m jsonb := coalesce(existing, '{}') || body; room int; ci text; co text; st text; BEGIN
  room := CASE WHEN coalesce(m ->> 'room_id', '') ~ '^\d+$' THEN (m ->> 'room_id')::int ELSE 0 END;
  IF NOT EXISTS (SELECT 1 FROM akari.rooms WHERE id = room) THEN PERFORM akari.fail(400, 'Please choose a room'); END IF;
  ci := akari.d(m, 'check_in', 'Check-in date');
  co := akari.d(m, 'check_out', 'Check-out date');
  IF co <= ci THEN PERFORM akari.fail(400, 'Check-out must be after check-in'); END IF;
  st := coalesce(nullif(m ->> 'status', ''), 'booked');
  IF st NOT IN ('booked', 'checked_in', 'checked_out', 'cancelled', 'no_show') THEN PERFORM akari.fail(400, 'Invalid status'); END IF;
  RETURN jsonb_build_object(
    'room_id', room, 'guest_name', akari.req(m, 'guest_name', 'Guest name'),
    'phone', akari.s(m, 'phone', 50), 'email', akari.s(m, 'email', 200),
    'guests', greatest(1, trunc(akari.n(m, 'guests', 1))::int), 'check_in', ci, 'check_out', co,
    'total', greatest(0, akari.n(m, 'total', 0)), 'status', st,
    'source', akari.s(m, 'source', 50), 'notes', akari.s(m, 'notes'));
END $$;

CREATE OR REPLACE FUNCTION akari.room_fields(body jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'name', akari.req(body, 'name', 'Room name', 60), 'kind', akari.s(body, 'kind', 60),
    'capacity', greatest(1, trunc(akari.n(body, 'capacity', 2))::int), 'rate', greatest(0, akari.n(body, 'rate', 0)),
    'color', coalesce(nullif(akari.s(body, 'color', 9), ''), '#4f46e5'),
    'active', CASE WHEN akari.truthy(body, 'active', true) THEN 1 ELSE 0 END,
    'sort', trunc(akari.n(body, 'sort', 0))::int)
$$;

-- ---------- router ----------
CREATE OR REPLACE FUNCTION akari.route(p_method text, p_path text, b jsonb, p_token text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me jsonb; u akari.users; f jsonb; ex jsonb; c jsonb; id1 int; amt double precision; v text; uname text;
  role_v text; active_v int; changed text[]; k text; parts text[];
  path text := split_part(p_path, '?', 1);
BEGIN
  parts := regexp_match(path, '^/api/(\w+)(?:/(\d+))?(?:/(\w+))?$');
  IF parts IS NULL THEN PERFORM akari.fail(404, 'Not found'); END IF;
  id1 := parts[2]::int;

  -- public routes
  IF p_method = 'GET' AND path = '/api/setup' THEN
    RETURN jsonb_build_object('needs_setup', NOT EXISTS (SELECT 1 FROM akari.users));
  ELSIF p_method = 'POST' AND path = '/api/setup' THEN
    PERFORM pg_advisory_xact_lock(42);
    IF EXISTS (SELECT 1 FROM akari.users) THEN PERFORM akari.fail(400, 'Already set up'); END IF;
    uname := akari.req(b, 'username', 'Username', 50);
    v := akari.req(b, 'password', 'Password');
    IF length(v) < 6 THEN PERFORM akari.fail(400, 'Password must be at least 6 characters'); END IF;
    INSERT INTO akari.users (username, name, role, pw_hash, created_at)
      VALUES (uname, coalesce(nullif(akari.s(b, 'name', 100), ''), uname), 'admin', akari.hash_pw(v), akari.now_iso())
      RETURNING id INTO id1;
    f := akari.settings();
    IF akari.s(b, 'business_name') <> '' THEN f := f || jsonb_build_object('business_name', akari.s(b, 'business_name', 100)); END IF;
    IF akari.s(b, 'currency') <> '' THEN f := f || jsonb_build_object('currency', akari.s(b, 'currency', 5)); END IF;
    INSERT INTO akari.meta VALUES ('settings', f) ON CONFLICT (key) DO UPDATE SET value = excluded.value;
    INSERT INTO akari.rooms (name, sort, color)
      SELECT 'Suite ' || i, i - 1, (ARRAY['#4f46e5','#0891b2','#059669','#d97706','#db2777','#7c3aed','#dc2626','#2563eb','#65a30d','#0d9488'])[1 + (i - 1) % 10]
      FROM generate_series(1, least(greatest(trunc(akari.n(b, 'rooms', 0))::int, 0), 100)) i;
    PERFORM akari.bump();
    RETURN jsonb_build_object('token', akari.new_session(id1));
  ELSIF p_method = 'POST' AND path = '/api/login' THEN
    SELECT * INTO u FROM akari.users WHERE lower(username) = lower(akari.s(b, 'username', 50));
    IF u.id IS NULL OR u.active = 0 OR NOT akari.check_pw(coalesce(b ->> 'password', ''), u.pw_hash) THEN
      PERFORM pg_sleep(0.5);
      PERFORM akari.fail(401, 'Wrong username or password');
    END IF;
    RETURN jsonb_build_object('token', akari.new_session(u.id));
  END IF;

  -- authenticated routes
  SELECT us.* INTO u FROM akari.sessions s JOIN akari.users us ON us.id = s.user_id
   WHERE s.token = coalesce(p_token, '') AND s.expires_at > now() AND us.active = 1;
  IF u.id IS NULL THEN PERFORM akari.fail(401, CASE WHEN p_token IS NULL THEN 'Please log in' ELSE 'Session expired, please log in again' END); END IF;
  me := to_jsonb(u);

  IF p_method = 'POST' AND path = '/api/logout' THEN
    DELETE FROM akari.sessions WHERE token = p_token;
    RETURN '{"ok": true}';
  ELSIF p_method = 'GET' AND path = '/api/state' THEN
    RETURN jsonb_build_object(
      'version', (SELECT version FROM public.sync_version WHERE id = 1),
      'me', akari.public_user(u), 'settings', akari.settings(),
      'rooms', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.sort, r.id), '[]') FROM akari.rooms r),
      'bookings', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.check_in, x.id), '[]') FROM akari.bookings x),
      'payments', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.paid_on, p.id), '[]') FROM akari.payments p),
      'users', (SELECT coalesce(jsonb_agg(akari.public_user(x) ORDER BY x.id), '[]') FROM akari.users x));
  ELSIF p_method = 'GET' AND path = '/api/version' THEN
    RETURN jsonb_build_object('version', (SELECT version FROM public.sync_version WHERE id = 1));
  ELSIF p_method = 'GET' AND path = '/api/activity' THEN
    RETURN jsonb_build_object('activity', (SELECT coalesce(jsonb_agg(t ORDER BY (t ->> 'id')::int DESC), '[]') FROM (
      SELECT to_jsonb(a) || jsonb_build_object('user_name', us.name, 'ref', bk.ref, 'guest_name', bk.guest_name) t
      FROM akari.activity a LEFT JOIN akari.users us ON us.id = a.user_id LEFT JOIN akari.bookings bk ON bk.id = a.booking_id
      ORDER BY a.id DESC LIMIT 200) q));
  END IF;

  PERFORM pg_advisory_xact_lock(42);  -- serialize writes (matches db_lock in server.py)

  IF p_method = 'POST' AND path = '/api/bookings' THEN
    f := akari.booking_fields(b);
    c := akari.conflicts((f ->> 'room_id')::int, f ->> 'check_in', f ->> 'check_out');
    IF jsonb_array_length(c) > 0 AND NOT akari.truthy(b, 'force') THEN
      PERFORM akari.fail(409, 'This room is already booked for some of these dates', jsonb_build_object('conflicts', c));
    END IF;
    LOOP
      v := 'BK-' || (SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1), '') FROM generate_series(1, 5));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM akari.bookings WHERE ref = v);
    END LOOP;
    INSERT INTO akari.bookings (ref, room_id, guest_name, phone, email, guests, check_in, check_out, total, status, source, notes, created_by, created_at, updated_at)
    VALUES (v, (f ->> 'room_id')::int, f ->> 'guest_name', f ->> 'phone', f ->> 'email', (f ->> 'guests')::int, f ->> 'check_in', f ->> 'check_out',
            (f ->> 'total')::double precision, f ->> 'status', f ->> 'source', f ->> 'notes', u.id, akari.now_iso(), akari.now_iso())
    RETURNING id INTO id1;
    amt := akari.n(b, 'deposit', 0);
    IF amt > 0 THEN
      INSERT INTO akari.payments (booking_id, amount, method, paid_on, note, created_by, created_at)
      VALUES (id1, amt, coalesce(nullif(akari.s(b, 'deposit_method', 30), ''), 'cash'),
              CASE WHEN akari.s(b, 'deposit_date') <> '' THEN akari.d(b, 'deposit_date', 'Payment date') ELSE akari.today() END,
              'Deposit', u.id, akari.now_iso());
    END IF;
    PERFORM akari.log(me, 'created booking', id1, (f ->> 'check_in') || ' → ' || (f ->> 'check_out'));
    IF amt > 0 THEN PERFORM akari.log(me, 'recorded payment', id1, akari.num_txt(amt)); END IF;
    PERFORM akari.bump();
    RETURN akari.load_booking(id1);

  ELSIF p_method = 'PUT' AND parts[1] = 'bookings' AND id1 IS NOT NULL AND parts[3] IS NULL THEN
    ex := akari.load_booking(id1);
    f := akari.booking_fields(b, ex);
    IF f ->> 'status' NOT IN ('cancelled', 'no_show') THEN
      c := akari.conflicts((f ->> 'room_id')::int, f ->> 'check_in', f ->> 'check_out', id1);
      IF jsonb_array_length(c) > 0 AND NOT akari.truthy(b, 'force') THEN
        PERFORM akari.fail(409, 'This room is already booked for some of these dates', jsonb_build_object('conflicts', c));
      END IF;
    END IF;
    UPDATE akari.bookings SET room_id = (f ->> 'room_id')::int, guest_name = f ->> 'guest_name', phone = f ->> 'phone',
      email = f ->> 'email', guests = (f ->> 'guests')::int, check_in = f ->> 'check_in', check_out = f ->> 'check_out',
      total = (f ->> 'total')::double precision, status = f ->> 'status', source = f ->> 'source', notes = f ->> 'notes',
      updated_at = akari.now_iso() WHERE id = id1;
    changed := ARRAY(SELECT key FROM jsonb_each(f) WHERE (ex -> key) IS DISTINCT FROM value
                       AND NOT (jsonb_typeof(value) = 'number' AND jsonb_typeof(ex -> key) = 'number' AND (value)::numeric = (ex -> key)::numeric));
    IF changed = ARRAY['status'] THEN
      PERFORM akari.log(me, 'status → ' || replace(f ->> 'status', '_', ' '), id1);
    ELSIF cardinality(changed) > 0 THEN
      PERFORM akari.log(me, 'edited booking', id1, replace(array_to_string(changed, ', '), '_', ' '));
    END IF;
    PERFORM akari.bump();
    RETURN akari.load_booking(id1);

  ELSIF p_method = 'DELETE' AND parts[1] = 'bookings' AND id1 IS NOT NULL THEN
    PERFORM akari.require_admin(me);
    ex := akari.load_booking(id1);
    DELETE FROM akari.bookings WHERE id = id1;
    PERFORM akari.log(me, 'deleted booking', NULL, (ex ->> 'ref') || ' ' || (ex ->> 'guest_name'));
    PERFORM akari.bump();
    RETURN '{"ok": true}';

  ELSIF p_method = 'POST' AND parts[1] = 'bookings' AND parts[3] = 'payments' THEN
    PERFORM akari.load_booking(id1);
    amt := akari.n(b, 'amount', 0);
    IF amt = 0 THEN PERFORM akari.fail(400, 'Enter an amount'); END IF;
    INSERT INTO akari.payments (booking_id, amount, method, paid_on, note, created_by, created_at)
    VALUES (id1, amt, coalesce(nullif(akari.s(b, 'method', 30), ''), 'cash'),
            CASE WHEN akari.s(b, 'paid_on') <> '' THEN akari.d(b, 'paid_on', 'Payment date') ELSE akari.today() END,
            akari.s(b, 'note', 200), u.id, akari.now_iso());
    PERFORM akari.log(me, CASE WHEN amt > 0 THEN 'recorded payment' ELSE 'recorded refund' END, id1, akari.num_txt(amt));
    PERFORM akari.bump();
    RETURN '{"ok": true}';

  ELSIF p_method = 'DELETE' AND parts[1] = 'payments' AND id1 IS NOT NULL THEN
    SELECT jsonb_build_object('booking_id', booking_id, 'amount', amount) INTO ex FROM akari.payments WHERE id = id1;
    IF ex IS NULL THEN PERFORM akari.fail(404, 'Payment not found'); END IF;
    DELETE FROM akari.payments WHERE id = id1;
    PERFORM akari.log(me, 'removed payment', (ex ->> 'booking_id')::int, akari.num_txt((ex ->> 'amount')::double precision));
    PERFORM akari.bump();
    RETURN '{"ok": true}';

  ELSIF parts[1] = 'rooms' AND ((p_method = 'POST' AND id1 IS NULL) OR (p_method = 'PUT' AND id1 IS NOT NULL)) THEN
    PERFORM akari.require_admin(me);
    f := akari.room_fields(b);
    IF p_method = 'POST' THEN
      INSERT INTO akari.rooms (name, kind, capacity, rate, color, active, sort)
      VALUES (f ->> 'name', f ->> 'kind', (f ->> 'capacity')::int, (f ->> 'rate')::double precision, f ->> 'color', (f ->> 'active')::int, (f ->> 'sort')::int);
      PERFORM akari.log(me, 'added room', NULL, f ->> 'name');
    ELSE
      UPDATE akari.rooms SET name = f ->> 'name', kind = f ->> 'kind', capacity = (f ->> 'capacity')::int, rate = (f ->> 'rate')::double precision,
        color = f ->> 'color', active = (f ->> 'active')::int, sort = (f ->> 'sort')::int WHERE id = id1;
      PERFORM akari.log(me, 'edited room', NULL, f ->> 'name');
    END IF;
    PERFORM akari.bump();
    RETURN '{"ok": true}';

  ELSIF p_method = 'POST' AND path = '/api/users' THEN
    PERFORM akari.require_admin(me);
    uname := akari.req(b, 'username', 'Username', 50);
    IF uname !~ '^[A-Za-z0-9_.-]+$' THEN PERFORM akari.fail(400, 'Username can only contain letters, numbers, . _ -'); END IF;
    v := akari.req(b, 'password', 'Password');
    IF length(v) < 6 THEN PERFORM akari.fail(400, 'Password must be at least 6 characters'); END IF;
    IF EXISTS (SELECT 1 FROM akari.users WHERE lower(username) = lower(uname)) THEN PERFORM akari.fail(400, 'Username already taken'); END IF;
    INSERT INTO akari.users (username, name, role, pw_hash, created_at)
    VALUES (uname, coalesce(nullif(akari.s(b, 'name', 100), ''), uname), CASE WHEN b ->> 'role' = 'admin' THEN 'admin' ELSE 'staff' END,
            akari.hash_pw(v), akari.now_iso());
    PERFORM akari.log(me, 'added staff', NULL, uname);
    PERFORM akari.bump();
    RETURN '{"ok": true}';

  ELSIF p_method = 'PUT' AND parts[1] = 'users' AND id1 IS NOT NULL THEN
    PERFORM akari.require_admin(me);
    SELECT to_jsonb(x) INTO ex FROM akari.users x WHERE id = id1;
    IF ex IS NULL THEN PERFORM akari.fail(404, 'User not found'); END IF;
    role_v := CASE WHEN coalesce(b ->> 'role', ex ->> 'role') = 'admin' THEN 'admin' ELSE 'staff' END;
    active_v := CASE WHEN akari.truthy(b, 'active', (ex ->> 'active')::int = 1) THEN 1 ELSE 0 END;
    IF id1 = u.id AND (role_v <> 'admin' OR active_v = 0) THEN PERFORM akari.fail(400, 'You can''t remove your own admin access'); END IF;
    UPDATE akari.users SET name = coalesce(nullif(akari.s(b, 'name', 100), ''), ex ->> 'name'), role = role_v, active = active_v WHERE id = id1;
    IF coalesce(b ->> 'password', '') <> '' THEN
      IF length(b ->> 'password') < 6 THEN PERFORM akari.fail(400, 'Password must be at least 6 characters'); END IF;
      UPDATE akari.users SET pw_hash = akari.hash_pw(b ->> 'password') WHERE id = id1;
      DELETE FROM akari.sessions WHERE user_id = id1;
    END IF;
    IF active_v = 0 THEN DELETE FROM akari.sessions WHERE user_id = id1; END IF;
    PERFORM akari.log(me, 'updated staff', NULL, ex ->> 'username');
    PERFORM akari.bump();
    RETURN '{"ok": true}';

  ELSIF p_method = 'POST' AND path = '/api/password' THEN
    IF NOT akari.check_pw(coalesce(b ->> 'current', ''), u.pw_hash) THEN PERFORM akari.fail(400, 'Current password is wrong'); END IF;
    IF length(coalesce(b ->> 'new', '')) < 6 THEN PERFORM akari.fail(400, 'Password must be at least 6 characters'); END IF;
    UPDATE akari.users SET pw_hash = akari.hash_pw(b ->> 'new') WHERE id = u.id;
    RETURN '{"ok": true}';

  ELSIF p_method = 'PUT' AND path = '/api/settings' THEN
    PERFORM akari.require_admin(me);
    f := akari.settings();
    FOR k IN SELECT jsonb_object_keys(f) LOOP
      IF b ? k THEN f := f || jsonb_build_object(k, akari.s(b, k, 100)); END IF;
    END LOOP;
    INSERT INTO akari.meta VALUES ('settings', f) ON CONFLICT (key) DO UPDATE SET value = excluded.value;
    PERFORM akari.log(me, 'updated settings');
    PERFORM akari.bump();
    RETURN f;
  END IF;

  PERFORM akari.fail(404, 'Not found');
  RETURN NULL;
END $$;

-- ---------- public entry point ----------
-- Always answers HTTP 200 with {"status": <http status>, "body": <json>} so the client can handle errors uniformly.
CREATE OR REPLACE FUNCTION public.api(p_method text, p_path text, p_body jsonb DEFAULT '{}', p_token text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = akari, public, extensions AS $$
DECLARE msg text; det text; info jsonb; BEGIN
  BEGIN
    RETURN jsonb_build_object('status', 200, 'body', akari.route(upper(p_method), p_path, coalesce(p_body, '{}'), nullif(p_token, '')));
  EXCEPTION
    WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, det = PG_EXCEPTION_DETAIL;
      BEGIN info := det::jsonb; EXCEPTION WHEN others THEN info := NULL; END;
      IF info IS NULL THEN RETURN jsonb_build_object('status', 500, 'body', jsonb_build_object('error', 'Server error')); END IF;
      RETURN jsonb_build_object('status', (info ->> 'status')::int, 'body', jsonb_build_object('error', msg) || (info -> 'extra'));
    WHEN unique_violation THEN
      RETURN jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'That already exists'));
    WHEN data_exception THEN
      RETURN jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'Invalid input'));
  END;
END $$;

REVOKE ALL ON FUNCTION public.api(text, text, jsonb, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT EXECUTE ON FUNCTION public.api(text, text, jsonb, text) TO anon, authenticated;
  END IF;
END $$;
