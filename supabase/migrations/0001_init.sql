-- flappybid.lol — complete database schema
--
-- Consolidated from the 35 incremental migrations this project was built
-- through. Applying this file to an empty database produces exactly the
-- structure those 35 produced: verified table-by-table and column-by-column
-- (24 tables, 184 columns) against the live database before replacing them.
--
-- Run it against a fresh Supabase project — SQL editor, or `supabase db push`.
--
-- check_function_bodies is disabled for the load because functions are
-- created before the tables they query; it is a load-time setting only.

set check_function_bodies = false;

--
--

--
-- Name: admin_player_stats(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_player_stats(since_day date, today_day date) RETURNS TABLE(players_window bigint, players_today bigint, returning_players bigint)
    LANGUAGE sql STABLE
    AS $$
  with ids as (
    select coalesce(device_id, ip_hash) as pid, day
    from runs
    where day >= since_day
      and coalesce(device_id, ip_hash) is not null
  )
  select
    (select count(distinct pid) from ids),
    (select count(distinct pid) from ids where day = today_day),
    (select count(*) from (
       select pid from ids group by pid having count(distinct day) >= 2
     ) r);
$$;

--
-- Name: buy_cosmetic(text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.buy_cosmetic(p_handle text, p_piece text, p_cost integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare new_balance integer;
begin
  if p_handle is null or p_handle = '' or p_piece is null or p_piece = ''
     or p_cost is null or p_cost <= 0 then
    return null;
  end if;

  -- claim ownership; a conflict means it's already owned (no charge)
  insert into cosmetics_owned (handle_lower, handle, piece_id, coins)
    values (lower(p_handle), p_handle, p_piece, p_cost)
  on conflict (handle_lower, piece_id) do nothing;
  if not found then
    return coalesce(
      (select balance from wallets where handle_lower = lower(p_handle)), 0
    );
  end if;

  -- newly claimed — charge for it, rolling the claim back if it can't be paid
  update wallets
     set balance = balance - p_cost, updated_at = now()
   where handle_lower = lower(p_handle)
     and balance >= p_cost
  returning balance into new_balance;
  if not found then
    delete from cosmetics_owned
      where handle_lower = lower(p_handle) and piece_id = p_piece;
    return null;
  end if;

  return new_balance;
end;
$$;

--
-- Name: credit_coins(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_coins(p_handle text, p_amount integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare new_balance integer;
begin
  if p_handle is null or p_handle = '' or p_amount <= 0 then
    return null;
  end if;
  insert into wallets (handle_lower, handle, balance, updated_at)
    values (lower(p_handle), p_handle, p_amount, now())
  on conflict (handle_lower) do update
    set balance = wallets.balance + excluded.balance,
        handle = excluded.handle,
        updated_at = now()
  returning balance into new_balance;
  return new_balance;
end;
$$;

--
-- Name: duel_board(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.duel_board(p_day date) RETURNS TABLE(handle text, score bigint, wins bigint, losses bigint, last_fight_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
  with events as (
    select w.handle, 1 as delta, w.created_at, w.id
    from duel_wins w where w.day = p_day
    union all
    select w.opponent, -1, w.created_at, w.id
    from duel_wins w where w.day = p_day
  ),
  walks as (
    -- each handle's raw running total, fight by fight (id breaks
    -- created_at ties so the walk is deterministic)
    select e.handle, e.delta, e.created_at,
      sum(e.delta) over (partition by e.handle order by e.created_at, e.id) as s
    from events e
  ),
  totals as (
    select k.handle,
      sum(k.delta) as net,
      -- how far below zero the raw walk ever sank; adding it back is
      -- exactly the clamped-at-zero score (W_n = S_n - min(0, min S_k))
      least(0, min(k.s)) as debt,
      count(*) filter (where k.delta = 1) as wins,
      count(*) filter (where k.delta = -1) as losses,
      max(k.created_at) as last_fight_at
    from walks k
    group by k.handle
  )
  select t.handle, (t.net - t.debt)::bigint as score, t.wins, t.losses, t.last_fight_at
  from totals t
  where lower(t.handle) not in (select lower(h.handle) from duel_hall_of_fame h)
  order by (t.net - t.debt) desc, t.last_fight_at asc
$$;

--
-- Name: global_leaderboard(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.global_leaderboard(row_limit integer, row_offset integer) RETURNS TABLE(rank bigint, product_id uuid, slug text, kind text, name text, url text, best_score integer, best_at timestamp with time zone, days_played bigint, total_runs bigint, total_count bigint)
    LANGUAGE sql STABLE
    AS $$
  with elig as (
    select
      ds.product_id as pid,
      ds.best_score as sc,
      ds.best_at    as at_t,
      ds.runs_count as rc
    from daily_scores ds
    where ds.best_score > 0
      and not exists (select 1 from bans b where b.product_id = ds.product_id)
  ),
  -- each product's peak day: highest score ever, earliest if it repeated
  peak as (
    select distinct on (pid) pid, sc as mx, at_t as mx_at
    from elig
    order by pid, sc desc, at_t asc nulls last
  ),
  counts as (
    select pid, count(*) as days, coalesce(sum(rc), 0) as runs
    from elig
    group by pid
  ),
  board as (
    select
      p.id        as pid,
      p.slug      as slug,
      p.kind      as kind,
      p.name      as name,
      p.url       as url,
      peak.mx     as mx,
      peak.mx_at  as mx_at,
      counts.days as days,
      counts.runs as runs
    from peak
    join counts on counts.pid = peak.pid
    join products p on p.id = peak.pid
  )
  select
    row_number() over (order by board.mx desc, board.mx_at asc nulls last),
    board.pid,
    board.slug,
    board.kind,
    board.name,
    board.url,
    board.mx,
    board.mx_at,
    board.days,
    board.runs,
    count(*) over ()
  from board
  order by board.mx desc, board.mx_at asc nulls last
  limit row_limit offset row_offset;
$$;

--
-- Name: grant_x_share_boost(text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.grant_x_share_boost(p_ip_hash text, p_day date) RETURNS TABLE(pid uuid)
    LANGUAGE sql
    AS $$
  update runs
     set boost = 2, effective_score = score * 2
   where runs.ip_hash = p_ip_hash
     and runs.day = p_day
     and runs.status = 'scored'
     and runs.boost = 1
     and runs.score is not null
  returning runs.product_id;
$$;

--
-- Name: increment_champion_clicks(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_champion_clicks(d date) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    AS $$
  update hall_of_fame set clicks_sent = clicks_sent + 1 where date = d;
$$;

--
-- Name: increment_duel_clicks(text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_duel_clicks(h text, d date) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    AS $$
  insert into duel_entry_clicks (handle_lower, day, clicks)
  values (lower(h), d, 1)
  on conflict (handle_lower, day)
  do update set clicks = duel_entry_clicks.clicks + 1;
$$;

--
-- Name: increment_entry_clicks(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_entry_clicks(pid uuid, d date) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    AS $$
  insert into daily_scores (product_id, day, clicks_count)
  values (pid, d, 1)
  on conflict (product_id, day)
  do update set clicks_count = daily_scores.clicks_count + 1;
$$;

--
-- Name: increment_sponsor_clicks(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_sponsor_clicks(sid uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    AS $$
  update sponsors set clicks_count = clicks_count + 1 where id = sid;
$$;

--
-- Name: open_duel_wager(text, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.open_duel_wager(p_code text, p_a text, p_b text, p_amount integer) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
declare wager_id uuid;
begin
  if p_a is null or p_b is null or p_a = '' or p_b = ''
     or p_amount is null or p_amount <= 0
     or lower(p_a) = lower(p_b) then
    return null;
  end if;

  -- debit seat 0
  update wallets
     set balance = balance - p_amount, updated_at = now()
   where handle_lower = lower(p_a) and balance >= p_amount;
  if not found then
    return null;  -- host can't cover — nothing moved
  end if;

  -- debit seat 1
  update wallets
     set balance = balance - p_amount, updated_at = now()
   where handle_lower = lower(p_b) and balance >= p_amount;
  if not found then
    -- challenger can't cover — undo the host's debit and abort
    update wallets
       set balance = balance + p_amount, updated_at = now()
     where handle_lower = lower(p_a);
    return null;
  end if;

  insert into duel_wagers (code, handle_a, handle_b, amount)
    values (p_code, p_a, p_b, p_amount)
  returning id into wager_id;
  return wager_id;
end;
$$;

--
-- Name: refund_duel_wager(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refund_duel_wager(p_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
declare rec duel_wagers;
begin
  select * into rec from duel_wagers where id = p_id and status = 'open' for update;
  if not found then
    return false;
  end if;

  update duel_wagers set status = 'refunded', settled_at = now() where id = p_id;

  insert into wallets (handle_lower, handle, balance, updated_at)
    values (lower(rec.handle_a), rec.handle_a, rec.amount, now())
  on conflict (handle_lower) do update
    set balance = wallets.balance + excluded.balance,
        handle = excluded.handle,
        updated_at = now();
  insert into wallets (handle_lower, handle, balance, updated_at)
    values (lower(rec.handle_b), rec.handle_b, rec.amount, now())
  on conflict (handle_lower) do update
    set balance = wallets.balance + excluded.balance,
        handle = excluded.handle,
        updated_at = now();
  return true;
end;
$$;

--
-- Name: refund_stale_wagers(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refund_stale_wagers(p_age interval DEFAULT '00:15:00'::interval) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare stale uuid; n integer := 0;
begin
  for stale in
    select id from duel_wagers
     where status = 'open' and created_at < now() - p_age
     for update skip locked
  loop
    if refund_duel_wager(stale) then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

--
-- Name: settle_duel_wager(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settle_duel_wager(p_id uuid, p_winner text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
declare rec duel_wagers;
begin
  select * into rec from duel_wagers where id = p_id and status = 'open' for update;
  if not found then
    return false;
  end if;
  if p_winner is null
     or (lower(p_winner) <> lower(rec.handle_a)
         and lower(p_winner) <> lower(rec.handle_b)) then
    return false;  -- unknown winner — don't touch the escrow
  end if;

  update duel_wagers
     set status = 'settled', winner = p_winner, settled_at = now()
   where id = p_id;

  insert into wallets (handle_lower, handle, balance, updated_at)
    values (lower(p_winner), p_winner, rec.amount * 2, now())
  on conflict (handle_lower) do update
    set balance = wallets.balance + excluded.balance,
        handle = excluded.handle,
        updated_at = now();
  return true;
end;
$$;

--
-- Name: spend_for_revive(text, uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.spend_for_revive(p_handle text, p_run uuid, p_cost integer, p_cap integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare new_balance integer;
begin
  if p_handle is null or p_handle = '' then
    return null;
  end if;

  update runs
     set revives_used = revives_used + 1
   where id = p_run
     and status = 'open'
     and revives_used < p_cap;
  if not found then
    return null;
  end if;

  update wallets
     set balance = balance - p_cost, updated_at = now()
   where handle_lower = lower(p_handle)
     and balance >= p_cost
  returning balance into new_balance;
  if not found then
    update runs set revives_used = revives_used - 1 where id = p_run;
    return null;
  end if;

  return new_balance;
end;
$$;

--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    body text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: bans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid,
    ip_hash text,
    run_id uuid,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text,
    CONSTRAINT bans_target_check CHECK (((product_id IS NOT NULL) OR (ip_hash IS NOT NULL) OR (device_id IS NOT NULL)))
);

--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id bigint NOT NULL,
    name text NOT NULL,
    body text NOT NULL,
    seed integer DEFAULT 0 NOT NULL,
    ip_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    fit text DEFAULT ''::text NOT NULL,
    color text DEFAULT ''::text NOT NULL,
    x_handle text DEFAULT ''::text NOT NULL,
    effect text DEFAULT ''::text NOT NULL,
    body_color text DEFAULT ''::text NOT NULL,
    gif_url text DEFAULT ''::text NOT NULL,
    recipient text DEFAULT ''::text NOT NULL
);

--
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.chat_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: coin_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coin_purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    handle_lower text NOT NULL,
    handle text,
    pack_id text NOT NULL,
    coins integer NOT NULL,
    price_cents integer NOT NULL,
    stripe_session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    provider text DEFAULT 'stripe'::text NOT NULL,
    coinbase_charge_id text,
    nowpayments_payment_id text
);

--
-- Name: cosmetics_owned; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cosmetics_owned (
    handle_lower text NOT NULL,
    handle text NOT NULL,
    piece_id text NOT NULL,
    coins integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: daily_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_scores (
    product_id uuid NOT NULL,
    day date NOT NULL,
    best_score integer DEFAULT 0 NOT NULL,
    best_at timestamp with time zone,
    runs_count integer DEFAULT 0 NOT NULL,
    clicks_count integer DEFAULT 0 NOT NULL
);

--
-- Name: duel_entry_clicks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.duel_entry_clicks (
    handle_lower text NOT NULL,
    day date NOT NULL,
    clicks integer DEFAULT 0 NOT NULL
);

--
-- Name: duel_hall_of_fame; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.duel_hall_of_fame (
    date date NOT NULL,
    handle text NOT NULL,
    score integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: duel_matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.duel_matches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    duel_id uuid NOT NULL,
    nickname text NOT NULL,
    script integer[] NOT NULL,
    ip_hash text,
    device_id text,
    winner text NOT NULL,
    ko boolean DEFAULT false NOT NULL,
    frames integer NOT NULL,
    ghost_hp integer NOT NULL,
    challenger_hp integer NOT NULL,
    ghost_dmg integer NOT NULL,
    challenger_dmg integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duel_matches_winner_check CHECK ((winner = ANY (ARRAY['ghost'::text, 'challenger'::text, 'draw'::text])))
);

--
-- Name: duel_ref_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.duel_ref_links (
    handle_lower text NOT NULL,
    handle text NOT NULL,
    url text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: duel_wagers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.duel_wagers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    handle_a text NOT NULL,
    handle_b text NOT NULL,
    amount integer NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    winner text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT duel_wagers_amount_check CHECK ((amount > 0)),
    CONSTRAINT duel_wagers_status_check CHECK ((status = ANY (ARRAY['open'::text, 'settled'::text, 'refunded'::text])))
);

--
-- Name: duel_wins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.duel_wins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    day date NOT NULL,
    handle text NOT NULL,
    opponent text NOT NULL,
    code text NOT NULL,
    reason text NOT NULL,
    ticks integer DEFAULT 0 NOT NULL,
    ip_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duel_wins_reason_check CHECK ((reason = ANY (ARRAY['ko'::text, 'time'::text, 'forfeit'::text])))
);

--
-- Name: duels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.duels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    mode text DEFAULT 'gauntlet'::text NOT NULL,
    nickname text NOT NULL,
    taunt text,
    ruleset jsonb DEFAULT '{}'::jsonb NOT NULL,
    script integer[] NOT NULL,
    duel_version smallint NOT NULL,
    owner_token text NOT NULL,
    ip_hash text,
    device_id text,
    expires_at timestamp with time zone NOT NULL,
    wins integer DEFAULT 0 NOT NULL,
    losses integer DEFAULT 0 NOT NULL,
    draws integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duels_mode_check CHECK ((mode = ANY (ARRAY['gauntlet'::text, 'first_blood'::text]))),
    CONSTRAINT duels_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'expired'::text])))
);

--
-- Name: hall_of_fame; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hall_of_fame (
    date date NOT NULL,
    product_id uuid NOT NULL,
    best_score integer NOT NULL,
    runs_taken integer DEFAULT 0 NOT NULL,
    clicks_sent integer DEFAULT 0 NOT NULL
);

--
-- Name: logo_bids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.logo_bids (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand text NOT NULL,
    url text,
    logo_data_url text NOT NULL,
    price_cents integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    stripe_session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT logo_bids_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending'::text, 'approved'::text, 'rejected'::text])))
);

--
-- Name: ph_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ph_votes (
    ip_hash text NOT NULL,
    day date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text
);

--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    last_won_on date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT products_kind_check CHECK ((kind = ANY (ARRAY['url'::text, 'handle'::text])))
);

--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    day date NOT NULL,
    seed bigint NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    score integer,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    submitted_at timestamp with time zone,
    ip_hash text,
    flap_frames integer[],
    cheat_reason text,
    review text,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    map text DEFAULT 'classic'::text NOT NULL,
    shot_frames integer[],
    boost smallint DEFAULT 1 NOT NULL,
    effective_score integer,
    device_id text,
    checkpoints jsonb,
    cp_nonce text,
    revives_used smallint DEFAULT 0 NOT NULL,
    revive_frames integer[],
    CONSTRAINT runs_review_check CHECK ((review = ANY (ARRAY['approved'::text, 'rejected'::text]))),
    CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'scored'::text, 'rejected'::text, 'cheated'::text])))
);

--
-- Name: showcase_clicks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.showcase_clicks (
    id bigint NOT NULL,
    date date NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    ip_hash text
);

--
-- Name: showcase_clicks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.showcase_clicks ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.showcase_clicks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: sponsors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sponsors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    pitch text NOT NULL,
    url text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    price_cents integer NOT NULL,
    stripe_session_id text,
    live_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    clicks_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT sponsors_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'live'::text, 'rejected'::text, 'expired'::text])))
);

--
-- Name: visitors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visitors (
    id uuid NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallets (
    handle_lower text NOT NULL,
    handle text NOT NULL,
    balance integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallets_balance_check CHECK ((balance >= 0))
);

--
-- Name: x_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.x_connections (
    token_hash text NOT NULL,
    x_id text NOT NULL,
    x_handle text NOT NULL,
    ip_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: x_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.x_shares (
    ip_hash text NOT NULL,
    day date NOT NULL,
    device_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);

--
-- Name: bans bans_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bans
    ADD CONSTRAINT bans_device_id_key UNIQUE (device_id);

--
-- Name: bans bans_ip_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bans
    ADD CONSTRAINT bans_ip_hash_key UNIQUE (ip_hash);

--
-- Name: bans bans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bans
    ADD CONSTRAINT bans_pkey PRIMARY KEY (id);

--
-- Name: bans bans_product_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bans
    ADD CONSTRAINT bans_product_id_key UNIQUE (product_id);

--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);

--
-- Name: coin_purchases coin_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coin_purchases
    ADD CONSTRAINT coin_purchases_pkey PRIMARY KEY (id);

--
-- Name: coin_purchases coin_purchases_stripe_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coin_purchases
    ADD CONSTRAINT coin_purchases_stripe_session_id_key UNIQUE (stripe_session_id);

--
-- Name: cosmetics_owned cosmetics_owned_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cosmetics_owned
    ADD CONSTRAINT cosmetics_owned_pkey PRIMARY KEY (handle_lower, piece_id);

--
-- Name: daily_scores daily_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_scores
    ADD CONSTRAINT daily_scores_pkey PRIMARY KEY (product_id, day);

--
-- Name: duel_entry_clicks duel_entry_clicks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.duel_entry_clicks
    ADD CONSTRAINT duel_entry_clicks_pkey PRIMARY KEY (handle_lower, day);

--
-- Name: duel_hall_of_fame duel_hall_of_fame_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.duel_hall_of_fame
    ADD CONSTRAINT duel_hall_of_fame_pkey PRIMARY KEY (date);

--
-- Name: duel_matches duel_matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.duel_matches
    ADD CONSTRAINT duel_matches_pkey PRIMARY KEY (id);

--
-- Name: duel_ref_links duel_ref_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.duel_ref_links
    ADD CONSTRAINT duel_ref_links_pkey PRIMARY KEY (handle_lower);

--
-- Name: duel_wagers duel_wagers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.duel_wagers
    ADD CONSTRAINT duel_wagers_pkey PRIMARY KEY (id);

--
-- Name: duel_wins duel_wins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.duel_wins
    ADD CONSTRAINT duel_wins_pkey PRIMARY KEY (id);

--
-- Name: duels duels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.duels
    ADD CONSTRAINT duels_pkey PRIMARY KEY (id);

--
-- Name: hall_of_fame hall_of_fame_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hall_of_fame
    ADD CONSTRAINT hall_of_fame_pkey PRIMARY KEY (date);

--
-- Name: logo_bids logo_bids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logo_bids
    ADD CONSTRAINT logo_bids_pkey PRIMARY KEY (id);

--
-- Name: logo_bids logo_bids_stripe_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logo_bids
    ADD CONSTRAINT logo_bids_stripe_session_id_key UNIQUE (stripe_session_id);

--
-- Name: ph_votes ph_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ph_votes
    ADD CONSTRAINT ph_votes_pkey PRIMARY KEY (ip_hash, day);

--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

--
-- Name: products products_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_slug_key UNIQUE (slug);

--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);

--
-- Name: showcase_clicks showcase_clicks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.showcase_clicks
    ADD CONSTRAINT showcase_clicks_pkey PRIMARY KEY (id);

--
-- Name: sponsors sponsors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsors
    ADD CONSTRAINT sponsors_pkey PRIMARY KEY (id);

--
-- Name: sponsors sponsors_stripe_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsors
    ADD CONSTRAINT sponsors_stripe_session_id_key UNIQUE (stripe_session_id);

--
-- Name: visitors visitors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visitors
    ADD CONSTRAINT visitors_pkey PRIMARY KEY (id);

--
-- Name: wallets wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (handle_lower);

--
-- Name: x_connections x_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.x_connections
    ADD CONSTRAINT x_connections_pkey PRIMARY KEY (token_hash);

--
-- Name: x_shares x_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.x_shares
    ADD CONSTRAINT x_shares_pkey PRIMARY KEY (ip_hash, day);

--
-- Name: announcements_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX announcements_live ON public.announcements USING btree (created_at DESC) WHERE active;

--
-- Name: chat_messages_dm_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_dm_from ON public.chat_messages USING btree (x_handle, id DESC) WHERE (recipient <> ''::text);

--
-- Name: chat_messages_dm_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_dm_to ON public.chat_messages USING btree (recipient, id DESC) WHERE (recipient <> ''::text);

--
-- Name: chat_messages_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_recent ON public.chat_messages USING btree (id DESC);

--
-- Name: coin_purchases_coinbase_charge_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX coin_purchases_coinbase_charge_idx ON public.coin_purchases USING btree (coinbase_charge_id) WHERE (coinbase_charge_id IS NOT NULL);

--
-- Name: coin_purchases_handle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coin_purchases_handle_idx ON public.coin_purchases USING btree (handle_lower);

--
-- Name: coin_purchases_nowpayments_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX coin_purchases_nowpayments_payment_idx ON public.coin_purchases USING btree (nowpayments_payment_id) WHERE (nowpayments_payment_id IS NOT NULL);

--
-- Name: cosmetics_owned_handle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cosmetics_owned_handle_idx ON public.cosmetics_owned USING btree (handle_lower);

--
-- Name: daily_scores_day_rank_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_scores_day_rank_idx ON public.daily_scores USING btree (day, best_score DESC, best_at);

--
-- Name: duel_matches_duel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX duel_matches_duel_idx ON public.duel_matches USING btree (duel_id, created_at DESC);

--
-- Name: duel_wagers_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX duel_wagers_open_idx ON public.duel_wagers USING btree (created_at) WHERE (status = 'open'::text);

--
-- Name: duel_wins_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX duel_wins_day_idx ON public.duel_wins USING btree (day, handle);

--
-- Name: duels_board_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX duels_board_idx ON public.duels USING btree (status, expires_at DESC);

--
-- Name: logo_bids_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logo_bids_status_idx ON public.logo_bids USING btree (status, created_at DESC);

--
-- Name: runs_day_ip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_day_ip_idx ON public.runs USING btree (day, ip_hash);

--
-- Name: runs_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_device_id_idx ON public.runs USING btree (device_id);

--
-- Name: runs_open_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_open_started_idx ON public.runs USING btree (status, started_at);

--
-- Name: runs_product_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_product_day_idx ON public.runs USING btree (product_id, day);

--
-- Name: showcase_clicks_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX showcase_clicks_date_idx ON public.showcase_clicks USING btree (date);

--
-- Name: visitors_last_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visitors_last_seen_idx ON public.visitors USING btree (last_seen DESC);

--
-- Name: bans bans_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bans
    ADD CONSTRAINT bans_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: bans bans_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bans
    ADD CONSTRAINT bans_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;

--
-- Name: daily_scores daily_scores_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_scores
    ADD CONSTRAINT daily_scores_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: duel_matches duel_matches_duel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.duel_matches
    ADD CONSTRAINT duel_matches_duel_id_fkey FOREIGN KEY (duel_id) REFERENCES public.duels(id);

--
-- Name: hall_of_fame hall_of_fame_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hall_of_fame
    ADD CONSTRAINT hall_of_fame_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);

--
-- Name: runs runs_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--
-- Name: announcements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: bans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bans ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: coin_purchases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coin_purchases ENABLE ROW LEVEL SECURITY;

--
-- Name: cosmetics_owned; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cosmetics_owned ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_scores ENABLE ROW LEVEL SECURITY;

--
-- Name: duel_hall_of_fame; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.duel_hall_of_fame ENABLE ROW LEVEL SECURITY;

--
-- Name: duel_matches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.duel_matches ENABLE ROW LEVEL SECURITY;

--
-- Name: duel_ref_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.duel_ref_links ENABLE ROW LEVEL SECURITY;

--
-- Name: duel_wagers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.duel_wagers ENABLE ROW LEVEL SECURITY;

--
-- Name: duel_wins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.duel_wins ENABLE ROW LEVEL SECURITY;

--
-- Name: duels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.duels ENABLE ROW LEVEL SECURITY;

--
-- Name: hall_of_fame; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hall_of_fame ENABLE ROW LEVEL SECURITY;

--
-- Name: logo_bids; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.logo_bids ENABLE ROW LEVEL SECURITY;

--
-- Name: ph_votes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ph_votes ENABLE ROW LEVEL SECURITY;

--
-- Name: products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

--
-- Name: hall_of_fame public read hall; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read hall" ON public.hall_of_fame FOR SELECT USING (true);

--
-- Name: products public read products; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read products" ON public.products FOR SELECT USING (true);

--
-- Name: daily_scores public read scores; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read scores" ON public.daily_scores FOR SELECT USING (true);

--
-- Name: runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;

--
-- Name: showcase_clicks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.showcase_clicks ENABLE ROW LEVEL SECURITY;

--
-- Name: sponsors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sponsors ENABLE ROW LEVEL SECURITY;

--
-- Name: visitors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.visitors ENABLE ROW LEVEL SECURITY;

--
-- Name: wallets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

--
-- Name: x_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.x_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: x_shares; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.x_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

--
--

--
-- Realtime. The board subscribes to daily_scores. Publication membership is
-- cluster-level, so a schema-scoped dump drops it — restored explicitly here.
-- The guard lets this file load on a plain Postgres that has no Supabase
-- realtime publication.
--

do $$
begin
  alter publication supabase_realtime add table public.daily_scores;
exception
  when undefined_object then null;  -- not a Supabase database
  when duplicate_object then null;  -- already a member
end
$$;
