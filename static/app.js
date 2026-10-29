"use strict";
/* Akari Suite Booking System – single-file vanilla JS PWA client */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");

const S = {
  token: localStorage.getItem("suite_token"),
  data: null,
  online: true,
  sheet: null,
  ui: { day: null, calStart: null, calDays: 14, filter: "upcoming", search: "", reportMonth: null },
};

/* ---------- dates & money ---------- */
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(iso, n) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function diffDays(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }
function fmtDate(iso, opts = {}) { return new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", ...opts }); }
function fmtRange(b) { return `${fmtDate(b.check_in)} → ${fmtDate(b.check_out)}`; }
function money(n) {
  const cur = S.data?.settings.currency || "";
  return cur + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* ---------- derived data ---------- */
function derive() {
  const d = S.data;
  d.roomById = Object.fromEntries(d.rooms.map((r) => [r.id, r]));
  d.userById = Object.fromEntries(d.users.map((u) => [u.id, u]));
  d.paidBy = {};
  d.paymentsBy = {};
  for (const p of d.payments) {
    d.paidBy[p.booking_id] = (d.paidBy[p.booking_id] || 0) + p.amount;
    (d.paymentsBy[p.booking_id] ||= []).push(p);
  }
  d.bookingById = Object.fromEntries(d.bookings.map((b) => [b.id, b]));
  d.activeRooms = d.rooms.filter((r) => r.active);
}
const isActive = (b) => b.status !== "cancelled" && b.status !== "no_show";
function pay(b) {
  const paid = Math.round((S.data.paidBy[b.id] || 0) * 100) / 100;
  const balance = Math.round((b.total - paid) * 100) / 100;
  const status = b.total > 0 && balance <= 0 ? "paid" : paid > 0 ? "partial" : b.total === 0 ? "paid" : "unpaid";
  return { paid, balance, status, label: { paid: "Paid", partial: "Partial", unpaid: "Unpaid" }[status] };
}
const STATUS_LABEL = { booked: "Booked", checked_in: "Checked in", checked_out: "Checked out", cancelled: "Cancelled", no_show: "No-show" };
const statusBadge = (b) => `<span class="badge b-${b.status}">${STATUS_LABEL[b.status]}</span>`;
const payBadge = (b) => { const p = pay(b); return `<span class="badge b-${p.status}">${p.label}</span>`; };
const roomName = (id) => S.data.roomById[id]?.name || "?";
const roomColor = (id) => S.data.roomById[id]?.color || "#999";
function findConflicts(roomId, ci, co, excludeId) {
  return S.data.bookings.filter((b) => b.room_id === roomId && b.id !== excludeId && isActive(b) && b.check_in < co && b.check_out > ci);
}

/* ---------- API & sync ---------- */
const CFG = window.AKARI_CONFIG || {};
const SUPA = !!(CFG.supabaseUrl && CFG.anonKey);
const REST = CFG.restUrl || (CFG.supabaseUrl || "").replace(/\/$/, "") + "/rest/v1";

// Hosted mode: every API call goes to the Supabase function public.api(), which answers {status, body}.
async function supaFetch(method, path, body) {
  const r = await fetch(REST + "/rpc/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: CFG.anonKey },
    body: JSON.stringify({ p_method: method, p_path: path, p_body: body || {}, p_token: S.token || null }),
  });
  const out = await r.json().catch(() => null);
  if (!r.ok || !out) return { ok: false, status: r.status || 500, json: async () => ({ error: "Server error, please try again" }) };
  return { ok: out.status < 400, status: out.status, json: async () => out.body };
}

async function api(method, path, body) {
  let res;
  try {
    res = SUPA ? await supaFetch(method, path, body) : await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", ...(S.token ? { Authorization: "Bearer " + S.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    setOnline(false);
    throw Object.assign(new Error("No internet connection. Changes can only be saved when online."), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token && !path.startsWith("/api/login")) { logout(true); }
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong"), { status: res.status, data });
  return data;
}

async function loadState() {
  const data = await api("GET", "/api/state");
  S.data = data;
  derive();
  setOnline(true);
  try { localStorage.setItem("suite_state", JSON.stringify(data)); } catch { /* storage full */ }
  render();
}

let syncing = false;
async function syncLoop() {
  if (SUPA) return supaSyncLoop();
  if (syncing) return;
  syncing = true;
  while (S.token) {
    try {
      const { version } = await api("GET", "/api/wait?v=" + (S.data?.version ?? -1));
      setOnline(true);
      if (version !== S.data?.version) await loadState();
    } catch (e) {
      if (!S.token) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  syncing = false;
}

// Hosted mode: Supabase Realtime pushes a message whenever public.sync_version changes; a slow poll is the safety net.
let rtSocket = null, rtLive = false;
function realtimeConnect() {
  if (!S.token || rtSocket) return;
  let ref = 0, hb;
  const ws = new WebSocket(CFG.supabaseUrl.replace(/^http/, "ws").replace(/\/$/, "") +
    "/realtime/v1/websocket?apikey=" + encodeURIComponent(CFG.anonKey) + "&vsn=1.0.0");
  const send = (topic, event, payload) => ws.readyState === 1 && ws.send(JSON.stringify({ topic, event, payload, ref: String(++ref) }));
  ws.onopen = () => {
    send("realtime:akari-sync", "phx_join", {
      config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: [{ event: "*", schema: "public", table: "sync_version" }] },
      ...(CFG.anonKey.startsWith("eyJ") ? { access_token: CFG.anonKey } : {}),
    });
    hb = setInterval(() => send("phoenix", "heartbeat", {}), 25000);
  };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.topic !== "realtime:akari-sync") return;
    if (msg.event === "phx_reply" && msg.payload?.status === "ok") rtLive = true;
    if (msg.event === "postgres_changes" && msg.payload?.data?.record?.version !== S.data?.version) loadState().catch(() => {});
  };
  ws.onclose = () => {
    clearInterval(hb); rtLive = false; rtSocket = null;
    if (S.token) setTimeout(realtimeConnect, 3000);
  };
  rtSocket = ws;
}

async function supaSyncLoop() {
  if (syncing) return;
  syncing = true;
  realtimeConnect();
  while (S.token) {
    try {
      const { version } = await api("GET", "/api/version");
      setOnline(true);
      if (version !== S.data?.version) await loadState();
    } catch { /* offline: setOnline(false) already ran */ }
    await new Promise((r) => setTimeout(r, rtLive ? 30000 : 5000));
  }
  syncing = false;
}
document.addEventListener("visibilitychange", () => {
  if (SUPA && S.token && document.visibilityState === "visible") {
    api("GET", "/api/version").then(({ version }) => { setOnline(true); if (version !== S.data?.version) return loadState(); }).catch(() => {});
  }
});

function setOnline(on) {
  if (S.online === on) return;
  S.online = on;
  const el = $(".sync");
  if (el) { el.classList.toggle("off", !on); $(".sync span:last-child").textContent = on ? "Live" : "Offline"; }
}

function logout(expired) {
  if (S.token) api("POST", "/api/logout").catch(() => {});
  S.token = null; S.data = null;
  if (rtSocket) rtSocket.close();
  localStorage.removeItem("suite_token"); localStorage.removeItem("suite_state");
  closeSheet();
  renderAuth(expired ? "Your session expired, please log in again." : "");
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ---------- auth screens ---------- */
async function renderAuth(message = "") {
  let needsSetup = false;
  try { needsSetup = (await api("GET", "/api/setup")).needs_setup; } catch { /* offline */ }
  const app = $("#app");
  if (needsSetup) {
    app.innerHTML = `<div class="auth">
      <img class="logo" src="/icons/icon-192.png" alt="">
      <h1>Welcome</h1><p class="lead">Set up your booking app. You'll be the owner (admin) and can add staff after.</p>
      <form id="setup" class="card">
        <label class="f">Business name<input name="business_name" placeholder="e.g. Sunrise Suites" required></label>
        <div class="row">
          <label class="f">Currency symbol<input name="currency" value="₱" maxlength="5"></label>
          <label class="f">How many rooms/suites?<input name="rooms" type="number" min="0" max="100" value="5"></label>
        </div>
        <label class="f">Your name<input name="name" required></label>
        <label class="f">Username<input name="username" autocapitalize="none" autocomplete="username" required></label>
        <label class="f">Password<input name="password" type="password" autocomplete="new-password" minlength="6" required></label>
        <div class="err"></div>
        <button class="btn primary block">Create my account</button>
      </form></div>`;
    $("#setup").onsubmit = (e) => submitAuth(e, "/api/setup");
  } else {
    app.innerHTML = `<div class="auth">
      <img class="logo" src="/icons/icon-192.png" alt="">
      <h1>Akari Suite Booking System</h1><p class="lead">Staff login</p>
      <form id="login" class="card">
        <label class="f">Username<input name="username" autocapitalize="none" autocomplete="username" required></label>
        <label class="f">Password<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="err">${esc(message)}</div>
        <button class="btn primary block">Log in</button>
      </form>
      <p class="lead" style="font-size:13px">Ask the owner to create an account for you.</p></div>`;
    $("#login").onsubmit = (e) => submitAuth(e, "/api/login");
  }
}

async function submitAuth(e, path) {
  e.preventDefault();
  const form = e.target, btn = $("button", form);
  btn.disabled = true;
  try {
    const { token } = await api("POST", path, Object.fromEntries(new FormData(form)));
    S.token = token;
    localStorage.setItem("suite_token", token);
    await loadState();
    syncLoop();
  } catch (err) {
    $(".err", form).textContent = err.message;
  } finally { btn.disabled = false; }
}

/* ---------- shell ---------- */
const ICONS = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  bookings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
};

function route() { return (location.hash.replace(/^#\/?/, "") || "today").split("/"); }

function render() {
  if (!S.data) return;
  const [page, sub] = route();
  let app = $("#app");
  if (!$(".topbar", app)) {
    app.innerHTML = `<header class="topbar"><h1></h1><div class="sync"><span class="dot"></span><span>Live</span></div></header>
      <main id="view"></main>
      <button class="fab" id="fab"><span style="font-size:20px;line-height:1">+</span> Booking</button>
      <nav class="nav">${["today", "calendar", "bookings", "more"].map((p) => `<a href="#/${p}" data-p="${p}">${ICONS[p]}${p[0].toUpperCase() + p.slice(1)}</a>`).join("")}</nav>`;
    $("#fab").onclick = () => openBookingForm({});
    setOnline(!S.online); setOnline(!S.online);
  }
  $(".topbar h1").textContent = S.data.settings.business_name;
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.p === page));
  const view = $("#view");
  const scroll = window.scrollY;
  const calScroll = $(".cal-wrap")?.scrollLeft;
  const focused = document.activeElement?.id;
  const views = { today: viewToday, calendar: viewCalendar, bookings: viewBookings, more: viewMore };
  view.innerHTML = (views[page] || viewToday)(sub);
  bindView(view);
  if (page === "calendar" && calScroll != null && S.ui._keepCal) $(".cal-wrap").scrollLeft = calScroll;
  S.ui._keepCal = false;
  if (focused && $("#" + focused)) { const el = $("#" + focused); el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); }
  window.scrollTo(0, scroll);
  if (S.sheet?.type === "booking") renderBookingSheet(S.sheet.id);
}

function bindView(root) {
  $$("[data-booking]", root).forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); openBooking(+el.dataset.booking); }));
  $$("[data-act]", root).forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); ACTIONS[el.dataset.act](el, e); }));
}

function bookingItem(b, extra = "") {
  const p = pay(b);
  return `<div class="item" data-booking="${b.id}">
    <div class="swatch" style="background:${roomColor(b.room_id)}"></div>
    <div class="main"><div class="title">${esc(b.guest_name)}</div>
      <div class="sub">${esc(roomName(b.room_id))} · ${fmtRange(b)} · ${plural(diffDays(b.check_in, b.check_out), "night")}</div></div>
    <div class="side">${extra || statusBadge(b)}${payBadge(b)}${p.balance > 0 && isActive(b) ? `<span style="color:var(--red);font-weight:700">${money(p.balance)} due</span>` : ""}</div>
  </div>`;
}

/* ---------- Today ---------- */
function viewToday() {
  const today = todayISO();
  const day = S.ui.day || today;
  const bs = S.data.bookings.filter(isActive);
  const arrivals = bs.filter((b) => b.check_in === day && b.status !== "checked_out");
  const departures = bs.filter((b) => b.check_out === day && b.status !== "cancelled");
  const inHouse = bs.filter((b) => b.check_in <= day && b.check_out > day && b.status !== "checked_out");
  const occupiedRooms = new Set(bs.filter((b) => b.check_in <= day && b.check_out > day).map((b) => b.room_id));
  const freeRooms = S.data.activeRooms.filter((r) => !occupiedRooms.has(r.id));
  const outstanding = bs.filter((b) => b.status !== "booked" || b.check_in <= addDays(today, 30)).reduce((s, b) => s + Math.max(0, pay(b).balance), 0);
  const missedCheckin = day === today ? bs.filter((b) => b.status === "booked" && b.check_in < today) : [];
  const lateCheckout = day === today ? bs.filter((b) => b.status === "checked_in" && b.check_out < today) : [];
  const unpaidArrivingSoon = day === today ? bs.filter((b) => b.status === "booked" && b.check_in > today && b.check_in <= addDays(today, 3) && pay(b).status === "unpaid") : [];

  const dayLabel = day === today ? "Today" : day === addDays(today, 1) ? "Tomorrow" : day === addDays(today, -1) ? "Yesterday" : fmtDate(day);
  return `
    <div class="cal-ctrl">
      <button class="btn small" data-act="dayPrev">‹</button>
      <div class="title" style="text-align:center">${dayLabel}<div style="font-size:12px;color:var(--muted);font-weight:600">${fmtDate(day, { year: "numeric" })}</div></div>
      <button class="btn small" data-act="dayNext">›</button>
      ${day !== today ? `<button class="btn small" data-act="dayToday">Today</button>` : ""}
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${occupiedRooms.size}/${S.data.activeRooms.length}</div><div class="l">Rooms occupied</div></div>
      <div class="stat"><div class="v">${arrivals.length}</div><div class="l">Arrivals</div></div>
      <div class="stat"><div class="v">${departures.length}</div><div class="l">Departures</div></div>
      <div class="stat"><div class="v" style="color:var(--red)">${money(outstanding)}</div><div class="l">Unpaid balance</div></div>
    </div>
    ${missedCheckin.length ? `<div class="section-title">Not checked in yet (past arrival date)</div>${missedCheckin.map((b) => bookingItem(b)).join("")}` : ""}
    ${lateCheckout.length ? `<div class="section-title">Should have checked out</div>${lateCheckout.map((b) => bookingItem(b)).join("")}` : ""}
    <div class="section-title">Arrivals</div>
    ${arrivals.map((b) => bookingItem(b, b.status === "booked" ? `<button class="btn small green" data-act="checkin" data-id="${b.id}">Check in</button>` : statusBadge(b))).join("") || `<div class="empty">No arrivals</div>`}
    <div class="section-title">Departures</div>
    ${departures.map((b) => bookingItem(b, b.status === "checked_in" ? `<button class="btn small" data-act="checkout" data-id="${b.id}">Check out</button>` : statusBadge(b))).join("") || `<div class="empty">No departures</div>`}
    <div class="section-title">Staying ${day === today ? "tonight" : "this night"}</div>
    ${inHouse.map((b) => bookingItem(b)).join("") || `<div class="empty">No guests</div>`}
    ${unpaidArrivingSoon.length ? `<div class="section-title">Arriving in 3 days – not paid yet</div>${unpaidArrivingSoon.map((b) => bookingItem(b)).join("")}` : ""}
    <div class="section-title">Available rooms</div>
    ${freeRooms.length ? `<div class="card row" style="gap:6px">${freeRooms.map((r) => `<button class="btn small" style="flex:none;border-left:4px solid ${r.color}" data-act="quickBook" data-room="${r.id}" data-date="${day}">${esc(r.name)} +</button>`).join("")}</div>` : `<div class="empty">Fully booked 🎉</div>`}
  `;
}

/* ---------- Calendar ---------- */
const CELL = 46;
function viewCalendar() {
  const today = todayISO();
  const start = S.ui.calStart || addDays(today, -2);
  const days = S.ui.calDays;
  const end = addDays(start, days);
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const head = dates.map((d) => {
    const dt = new Date(d + "T00:00:00Z");
    const we = dt.getUTCDay() === 0 || dt.getUTCDay() === 6;
    return `<div class="cal-cell ${we ? "we" : ""} ${d === today ? "today" : ""}">${dt.toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short" })}<b>${dt.getUTCDate()}</b></div>`;
  }).join("");
  const rowsHtml = S.data.activeRooms.map((r) => {
    const cells = dates.map((d) => {
      const dt = new Date(d + "T00:00:00Z");
      const we = dt.getUTCDay() === 0 || dt.getUTCDay() === 6;
      return `<div class="cal-cell ${we ? "we" : ""} ${d === today ? "today" : ""}" data-act="quickBook" data-room="${r.id}" data-date="${d}"></div>`;
    }).join("");
    const bars = S.data.bookings.filter((b) => b.room_id === r.id && isActive(b) && b.check_in < end && b.check_out > start).map((b) => {
      const s = Math.max(-0.5, diffDays(start, b.check_in) + 0.5);
      const e = Math.min(days, diffDays(start, b.check_out) + 0.5);
      const left = 92 + s * CELL + 2, width = Math.max(18, (e - s) * CELL - 4);
      const p = pay(b);
      return `<div class="cal-bar ${p.status} ${b.status === "checked_out" ? "out" : ""} ${b.status === "checked_in" ? "in" : ""}" style="left:${left}px;width:${width}px" data-booking="${b.id}" title="${esc(b.guest_name)}">${esc(b.guest_name)}<small>${p.label}${p.balance > 0 ? " · " + money(p.balance) : ""}</small></div>`;
    }).join("");
    return `<div class="cal-row"><div class="cal-room"><i style="background:${r.color}"></i>${esc(r.name)}</div>${cells}${bars}</div>`;
  }).join("");
  const monthLabel = new Date(start + "T00:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", month: "long", year: "numeric" });
  return `
    <div class="cal-ctrl">
      <button class="btn small" data-act="calPrev">‹</button>
      <div class="title">${monthLabel}</div>
      <button class="btn small" data-act="calToday">Today</button>
      <select class="btn small" data-act="calRange" id="calRange" style="flex:none">
        ${[7, 14, 30, 60].map((n) => `<option value="${n}" ${n === days ? "selected" : ""}>${n} days</option>`).join("")}
      </select>
      <button class="btn small" data-act="calNext">›</button>
    </div>
    <div class="cal-wrap"><div class="cal" style="width:${92 + days * CELL}px">
      <div class="cal-row cal-head"><div class="cal-room" style="font-weight:600;color:var(--muted)">Room</div>${head}</div>
      ${rowsHtml || `<div class="empty">Add rooms under More → Rooms</div>`}
    </div></div>
    <div class="legend"><span style="--c:var(--green)">Paid</span><span style="--c:#d97706">Partial</span><span style="--c:var(--red)">Unpaid</span><span>White outline = checked in · faded = checked out</span></div>
    <p style="font-size:13px;color:var(--muted);margin:4px">Tap an empty day to book that room. Tap a booking to see details, take payment or check in.</p>`;
}

/* ---------- Bookings list ---------- */
function viewBookings() {
  const today = todayISO();
  const f = S.ui.filter, q = S.ui.search.trim().toLowerCase();
  const filters = {
    upcoming: ["Upcoming", (b) => b.status === "booked" && b.check_out >= today],
    inhouse: ["Checked in", (b) => b.status === "checked_in"],
    unpaid: ["Unpaid / Partial", (b) => isActive(b) && pay(b).balance > 0],
    past: ["Past", (b) => b.status === "checked_out" || (b.status === "booked" && b.check_out < today)],
    cancelled: ["Cancelled", (b) => !isActive(b)],
    all: ["All", () => true],
  };
  let list = S.data.bookings.filter(filters[f][1]);
  if (q) list = S.data.bookings.filter((b) => [b.guest_name, b.phone, b.ref, roomName(b.room_id), b.notes, b.email].join(" ").toLowerCase().includes(q));
  list.sort((a, b) => (f === "past" || f === "cancelled" || f === "all" ? b.check_in.localeCompare(a.check_in) : a.check_in.localeCompare(b.check_in)));
  const due = list.filter(isActive).reduce((s, b) => s + Math.max(0, pay(b).balance), 0);
  return `
    <input class="search" id="search" placeholder="Search name, phone, booking #, room…" value="${esc(S.ui.search)}" autocomplete="off">
    ${q ? "" : `<div class="chips">${Object.entries(filters).map(([k, [label]]) => `<button class="chip ${k === f ? "on" : ""}" data-act="filter" data-f="${k}">${label}</button>`).join("")}</div>`}
    <div class="section-title"><span>${plural(list.length, "booking")}</span>${due > 0 ? `<span style="color:var(--red)">${money(due)} due</span>` : ""}</div>
    ${list.map((b) => bookingItem(b)).join("") || `<div class="empty">Nothing here</div>`}`;
}

/* ---------- More ---------- */
function viewMore(sub) {
  const admin = S.data.me.role === "admin";
  if (sub === "rooms") return viewRooms();
  if (sub === "staff" && admin) return viewStaff();
  if (sub === "reports") return viewReports();
  if (sub === "activity") { loadActivity(); return `<a href="#/more" class="btn small">‹ Back</a><div class="section-title">Activity log</div><div id="activity"><div class="empty">Loading…</div></div>`; }
  const link = (href, label, hint) => `<a class="item" href="${href}" style="text-decoration:none;color:inherit"><div class="main"><div class="title">${label}</div><div class="sub">${hint}</div></div><div class="side">›</div></a>`;
  return `
    <div class="card"><div style="font-weight:800">${esc(S.data.me.name)}</div><div class="sub" style="color:var(--muted);font-size:13px">@${esc(S.data.me.username)} · ${S.data.me.role === "admin" ? "Owner / admin" : "Staff"}</div></div>
    <div class="section-title">Appearance</div>
    <div class="card"><div class="seg">${[["light", "☀️ Light"], ["dark", "🌙 Dark"], ["system", "Auto"]].map(([t, l]) => `<button class="${themePref() === t ? "on" : ""}" data-act="theme" data-t="${t}">${l}</button>`).join("")}</div>
      <div style="color:var(--muted);font-size:12px;margin-top:8px">Auto follows your phone's light/dark setting.</div></div>
    ${link("#/more/reports", "Reports", "Income, occupancy, booking sources")}
    ${link("#/more/rooms", "Rooms / suites", admin ? "Add rooms, set default prices" : "View rooms")}
    ${admin ? link("#/more/staff", "Staff accounts", "Give your staff their own login") : ""}
    ${link("#/more/activity", "Activity log", "Who booked, edited or received payment")}
    <div class="item" data-act="exportCsv"><div class="main"><div class="title">Export bookings (CSV)</div><div class="sub">Open in Excel / Google Sheets</div></div><div class="side">⤓</div></div>
    ${admin ? `<div class="item" data-act="settings"><div class="main"><div class="title">Business settings</div><div class="sub">Name, currency, check-in/out time</div></div><div class="side">›</div></div>` : ""}
    ${window.AndroidApp ? `<div class="item" data-act="server"><div class="main"><div class="title">Server address</div><div class="sub">${esc(AndroidApp.serverUrl())}</div></div><div class="side">›</div></div>` : ""}
    <div class="item ${window.AndroidApp ? "hidden" : ""}" data-act="install"><div class="main"><div class="title">Install on this phone</div><div class="sub">Add to home screen</div></div><div class="side">›</div></div>
    <div class="item" data-act="password"><div class="main"><div class="title">Change my password</div></div><div class="side">›</div></div>
    <div class="item" data-act="logout"><div class="main"><div class="title" style="color:var(--red)">Log out</div></div></div>`;
}

function viewRooms() {
  const admin = S.data.me.role === "admin";
  return `<a href="#/more" class="btn small">‹ Back</a>
    <div class="section-title"><span>Rooms / suites</span>${admin ? `<button class="btn small primary" data-act="editRoom">+ Add room</button>` : ""}</div>
    ${S.data.rooms.map((r) => `<div class="item" ${admin ? `data-act="editRoom" data-id="${r.id}"` : ""}>
      <div class="swatch" style="background:${r.color}"></div>
      <div class="main"><div class="title">${esc(r.name)} ${r.active ? "" : '<span class="badge b-cancelled">Hidden</span>'}</div>
      <div class="sub">${esc(r.kind || "Room")} · up to ${r.capacity} guests</div></div>
      <div class="side"><b>${money(r.rate)}</b><span style="color:var(--muted)">per night</span></div></div>`).join("") || `<div class="empty">No rooms yet</div>`}`;
}

function viewStaff() {
  return `<a href="#/more" class="btn small">‹ Back</a>
    <div class="section-title"><span>Staff accounts</span><button class="btn small primary" data-act="editUser">+ Add staff</button></div>
    ${S.data.users.map((u) => `<div class="item" data-act="editUser" data-id="${u.id}">
      <div class="main"><div class="title">${esc(u.name)}</div><div class="sub">@${esc(u.username)}</div></div>
      <div class="side"><span class="badge ${u.role === "admin" ? "b-booked" : "b-checked_out"}">${u.role === "admin" ? "Admin" : "Staff"}</span>${u.active ? "" : '<span class="badge b-unpaid">Disabled</span>'}</div></div>`).join("")}
    <p style="font-size:13px;color:var(--muted)">Staff can create/edit bookings, take payments and check guests in/out. Only admins can manage rooms, staff, settings and delete bookings.</p>`;
}

function viewReports() {
  const month = S.ui.reportMonth || todayISO().slice(0, 7);
  const mStart = month + "-01";
  const [y, m] = month.split("-").map(Number);
  const mEnd = `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-01`;
  const daysInMonth = diffDays(mStart, mEnd);
  const active = S.data.bookings.filter(isActive);
  let roomNights = 0, earned = 0;
  const bySource = {}, byRoom = {};
  for (const b of active) {
    const s = b.check_in > mStart ? b.check_in : mStart, e = b.check_out < mEnd ? b.check_out : mEnd;
    const n = diffDays(s, e);
    if (n <= 0) continue;
    const share = b.total * (n / diffDays(b.check_in, b.check_out));
    roomNights += n; earned += share;
    const src = b.source || "Unspecified";
    bySource[src] = (bySource[src] || 0) + 1;
    byRoom[b.room_id] = (byRoom[b.room_id] || 0) + n;
  }
  const collected = S.data.payments.filter((p) => p.paid_on >= mStart && p.paid_on < mEnd).reduce((s, p) => s + p.amount, 0);
  const capacity = S.data.activeRooms.length * daysInMonth;
  const occ = capacity ? Math.round((roomNights / capacity) * 100) : 0;
  const newBookings = S.data.bookings.filter((b) => b.created_at.slice(0, 7) === month).length;
  const outstanding = active.filter((b) => b.check_in < mEnd && b.check_out > mStart).reduce((s, b) => s + Math.max(0, pay(b).balance), 0);
  const maxSrc = Math.max(1, ...Object.values(bySource));
  const label = new Date(mStart + "T00:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", month: "long", year: "numeric" });
  return `<a href="#/more" class="btn small">‹ Back</a>
    <div class="cal-ctrl" style="margin-top:12px"><button class="btn small" data-act="repPrev">‹</button><div class="title" style="text-align:center">${label}</div><button class="btn small" data-act="repNext">›</button></div>
    <div class="stats">
      <div class="stat"><div class="v" style="color:var(--green)">${money(collected)}</div><div class="l">Cash collected</div></div>
      <div class="stat"><div class="v">${money(earned)}</div><div class="l">Booked revenue (nights in month)</div></div>
      <div class="stat"><div class="v">${occ}%</div><div class="l">Occupancy (${roomNights}/${capacity} nights)</div></div>
      <div class="stat"><div class="v" style="color:var(--red)">${money(outstanding)}</div><div class="l">Still unpaid</div></div>
    </div>
    <div class="section-title">Nights booked per room</div>
    <div class="card bars">${S.data.activeRooms.map((r) => `<div class="hbar"><span class="lab">${esc(r.name)}</span><span class="track"><div style="width:${Math.round(((byRoom[r.id] || 0) / daysInMonth) * 100)}%;background:${r.color}"></div></span><span class="num">${byRoom[r.id] || 0}/${daysInMonth}</span></div>`).join("") || "No rooms"}</div>
    <div class="section-title">Where bookings came from</div>
    <div class="card bars">${Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="hbar"><span class="lab">${esc(k)}</span><span class="track"><div style="width:${(v / maxSrc) * 100}%"></div></span><span class="num">${v}</span></div>`).join("") || "No bookings this month"}</div>
    <p style="font-size:13px;color:var(--muted)">${plural(newBookings, "new booking")} created this month.</p>`;
}

async function loadActivity() {
  try {
    const { activity } = await api("GET", "/api/activity");
    const el = $("#activity");
    if (!el) return;
    el.innerHTML = activity.map((a) => `<div class="item" ${a.booking_id && S.data.bookingById[a.booking_id] ? `data-booking="${a.booking_id}"` : ""}>
      <div class="main"><div class="title" style="font-weight:600">${esc(a.user_name || "System")} ${esc(a.action)}${a.guest_name ? ` – ${esc(a.guest_name)}` : ""}</div>
      <div class="sub">${esc(a.detail || "")}${a.detail ? " · " : ""}${new Date(a.at).toLocaleString()}</div></div></div>`).join("") || `<div class="empty">No activity yet</div>`;
    bindView(el);
  } catch (e) { toast(e.message); }
}

/* ---------- actions ---------- */
const ACTIONS = {
  dayPrev: () => { S.ui.day = addDays(S.ui.day || todayISO(), -1); render(); },
  dayNext: () => { S.ui.day = addDays(S.ui.day || todayISO(), 1); render(); },
  dayToday: () => { S.ui.day = null; render(); },
  calPrev: () => { S.ui.calStart = addDays(S.ui.calStart || addDays(todayISO(), -2), -Math.max(7, Math.floor(S.ui.calDays / 2))); render(); },
  calNext: () => { S.ui.calStart = addDays(S.ui.calStart || addDays(todayISO(), -2), Math.max(7, Math.floor(S.ui.calDays / 2))); render(); },
  calToday: () => { S.ui.calStart = null; render(); },
  calRange: () => {},
  repPrev: () => { const [y, m] = (S.ui.reportMonth || todayISO().slice(0, 7)).split("-").map(Number); S.ui.reportMonth = m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; render(); },
  repNext: () => { const [y, m] = (S.ui.reportMonth || todayISO().slice(0, 7)).split("-").map(Number); S.ui.reportMonth = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; render(); },
  filter: (el) => { S.ui.filter = el.dataset.f; render(); },
  quickBook: (el) => openBookingForm({ room_id: +el.dataset.room, check_in: el.dataset.date, check_out: addDays(el.dataset.date, 1) }),
  checkin: (el) => setStatus(+el.dataset.id, "checked_in"),
  checkout: (el) => setStatus(+el.dataset.id, "checked_out"),
  editRoom: (el) => openRoomForm(el.dataset.id ? S.data.roomById[el.dataset.id] : null),
  editUser: (el) => openUserForm(el.dataset.id ? S.data.userById[el.dataset.id] : null),
  settings: () => openSettings(),
  password: () => openPassword(),
  install: () => openInstall(),
  theme: (el) => { localStorage.setItem(THEME_KEY, el.dataset.t); applyTheme(); render(); },
  server: () => window.AndroidApp && AndroidApp.changeServer(),
  exportCsv: () => exportCsv(),
  logout: () => { if (confirm("Log out of this phone?")) logout(); },
};

document.addEventListener("input", (e) => {
  if (e.target.id === "search") { S.ui.search = e.target.value; render(); }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "calRange") { S.ui.calDays = +e.target.value; render(); }
});

async function setStatus(id, status) {
  const b = S.data.bookingById[id];
  if (status === "checked_out" && pay(b).balance > 0 && !confirm(`${b.guest_name} still owes ${money(pay(b).balance)}. Check out anyway?`)) return;
  try {
    await api("PUT", `/api/bookings/${id}`, { status, force: true });
    toast(`${b.guest_name}: ${STATUS_LABEL[status]}`);
    await loadState();
  } catch (e) { toast(e.message); }
}

/* ---------- sheets ---------- */
function openSheet(title, bodyHtml, state = { type: "form" }) {
  closeSheet();
  S.sheet = state;
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet"><div class="sheet-head"><h2>${title}</h2><button class="x" aria-label="Close">×</button></div><div class="sheet-body">${bodyHtml}</div></div>`;
  bg.addEventListener("click", (e) => { if (e.target === bg) closeSheet(); });
  $(".x", bg).onclick = closeSheet;
  document.body.appendChild(bg);
  document.body.style.overflow = "hidden";
  return bg;
}
function closeSheet() {
  $(".sheet-bg")?.remove();
  S.sheet = null;
  document.body.style.overflow = "";
}

function openBooking(id) {
  openSheet("", "", { type: "booking", id });
  renderBookingSheet(id);
}

function renderBookingSheet(id) {
  const bg = $(".sheet-bg");
  const b = S.data.bookingById[id];
  if (!bg) return;
  if (!b) { closeSheet(); toast("This booking was deleted"); return; }
  const p = pay(b);
  const nights = diffDays(b.check_in, b.check_out);
  const pays = S.data.paymentsBy[b.id] || [];
  const digits = (b.phone || "").replace(/[^\d+]/g, "");
  const admin = S.data.me.role === "admin";
  const amountEl = $("#payAmount", bg);
  const keepAmount = amountEl ? { amount: amountEl.value, method: $("#payMethod", bg).value, open: !$("#payForm", bg).classList.contains("hidden") } : null;
  $(".sheet-head h2", bg).innerHTML = `${esc(b.guest_name)} <div style="font-size:12px;color:var(--muted);font-weight:600">${esc(b.ref)}</div>`;
  const statusButtons = {
    booked: [["checked_in", "Check in", "green"], ["cancelled", "Cancel booking", "danger"], ["no_show", "No-show", ""]],
    checked_in: [["checked_out", "Check out", "primary"], ["booked", "Undo check-in", ""]],
    checked_out: [["checked_in", "Undo check-out", ""]],
    cancelled: [["booked", "Restore booking", ""]],
    no_show: [["booked", "Restore booking", ""]],
  }[b.status];
  $(".sheet-body", bg).innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:12px">${statusBadge(b)} ${payBadge(b)}</div>
    <div class="card">
      <div class="kv"><span class="k">Room</span><span class="v"><span style="color:${roomColor(b.room_id)}">●</span> ${esc(roomName(b.room_id))}</span></div>
      <div class="kv"><span class="k">Check-in</span><span class="v">${fmtDate(b.check_in, { year: "numeric" })} · ${esc(S.data.settings.check_in_time)}</span></div>
      <div class="kv"><span class="k">Check-out</span><span class="v">${fmtDate(b.check_out, { year: "numeric" })} · ${esc(S.data.settings.check_out_time)}</span></div>
      <div class="kv"><span class="k">Nights / guests</span><span class="v">${plural(nights, "night")} · ${plural(b.guests, "guest")}</span></div>
      ${b.phone ? `<div class="kv"><span class="k">Phone</span><span class="v">${esc(b.phone)}</span></div>` : ""}
      ${b.email ? `<div class="kv"><span class="k">Email</span><span class="v">${esc(b.email)}</span></div>` : ""}
      ${b.source ? `<div class="kv"><span class="k">Source</span><span class="v">${esc(b.source)}</span></div>` : ""}
      ${b.notes ? `<div class="kv"><span class="k">Notes</span><span class="v" style="white-space:pre-wrap;font-weight:400">${esc(b.notes)}</span></div>` : ""}
      <div class="kv"><span class="k">Booked by</span><span class="v" style="font-weight:400">${esc(S.data.userById[b.created_by]?.name || "-")} · ${new Date(b.created_at).toLocaleDateString()}</span></div>
    </div>
    ${digits ? `<div class="row" style="margin-bottom:12px">
      <a class="btn" href="tel:${esc(digits)}">Call</a><a class="btn" href="sms:${esc(digits)}">SMS</a>
      <a class="btn" target="_blank" rel="noopener" href="https://wa.me/${esc(digits.replace(/^\+/, ""))}">WhatsApp</a></div>` : ""}
    <div class="card">
      <div class="kv"><span class="k">Total</span><span class="v">${money(b.total)}</span></div>
      <div class="kv"><span class="k">Paid</span><span class="v" style="color:var(--green)">${money(p.paid)}</span></div>
      <div class="kv"><span class="k">Balance</span><span class="v" style="color:${p.balance > 0 ? "var(--red)" : "var(--green)"}">${money(p.balance)}</span></div>
      <div class="progress"><div style="width:${b.total ? Math.min(100, (p.paid / b.total) * 100) : 100}%"></div></div>
      ${pays.map((x) => `<div class="kv" style="font-size:13px"><span class="k">${fmtDate(x.paid_on)} · ${esc(x.method)}${x.note ? " · " + esc(x.note) : ""}${S.data.userById[x.created_by] ? " · " + esc(S.data.userById[x.created_by].name) : ""}</span>
        <span class="v">${money(x.amount)} <button class="btn small danger" style="padding:2px 8px" data-delpay="${x.id}">×</button></span></div>`).join("")}
      <button class="btn green block" id="payToggle" style="margin-top:10px">+ Record payment</button>
      <form id="payForm" class="hidden" style="margin-top:12px">
        <div class="row"><label class="f">Amount<input id="payAmount" name="amount" type="number" step="0.01" inputmode="decimal" value="${p.balance > 0 ? p.balance : ""}" required></label>
        <label class="f">Method<select id="payMethod" name="method">${PAY_METHODS.map((m) => `<option>${m}</option>`).join("")}</select></label></div>
        <div class="row"><label class="f">Date<input name="paid_on" type="date" value="${todayISO()}"></label>
        <label class="f">Note / ref #<input name="note" placeholder="optional"></label></div>
        <button class="btn green block">Save payment</button>
      </form>
    </div>
    <div class="row" style="margin-bottom:10px">${statusButtons.map(([s, label, cls]) => `<button class="btn ${cls}" data-status="${s}">${label}</button>`).join("")}</div>
    <div class="row">
      <button class="btn" id="editBk">Edit booking</button>
      <button class="btn" id="shareBk">Share confirmation</button>
    </div>
    ${admin ? `<button class="btn danger block" id="delBk" style="margin-top:10px">Delete permanently</button>` : ""}
  `;
  if (keepAmount) {
    $("#payAmount", bg).value = keepAmount.amount; $("#payMethod", bg).value = keepAmount.method;
    if (keepAmount.open) $("#payForm", bg).classList.remove("hidden");
  }
  $("#payToggle", bg).onclick = () => { $("#payForm", bg).classList.toggle("hidden"); $("#payAmount", bg).focus(); };
  $("#payForm", bg).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("POST", `/api/bookings/${id}/payments`, Object.fromEntries(new FormData(e.target)));
      $("#payForm", bg).reset(); $("#payForm", bg).classList.add("hidden"); $("#payAmount", bg).value = "";
      toast("Payment saved");
      await loadState();
    } catch (err) { toast(err.message); }
  };
  $$("[data-delpay]", bg).forEach((el) => el.onclick = async () => {
    if (!confirm("Remove this payment?")) return;
    try { await api("DELETE", `/api/payments/${el.dataset.delpay}`); await loadState(); } catch (err) { toast(err.message); }
  });
  $$("[data-status]", bg).forEach((el) => el.onclick = () => {
    const s = el.dataset.status;
    if ((s === "cancelled" || s === "no_show") && !confirm(`Mark as ${STATUS_LABEL[s]}? The room becomes available again.`)) return;
    if (s === "booked" && !isActive(b) && findConflicts(b.room_id, b.check_in, b.check_out, b.id).length) {
      if (!confirm("The room has since been booked by someone else for these dates. Restore anyway (double booking)?")) return;
    }
    setStatus(id, s);
  });
  $("#editBk", bg).onclick = () => openBookingForm(b);
  $("#shareBk", bg).onclick = () => shareBooking(b);
  if ($("#delBk", bg)) $("#delBk", bg).onclick = async () => {
    if (!confirm("Delete this booking and its payments forever? (Use Cancel instead to keep a record.)")) return;
    try { await api("DELETE", `/api/bookings/${id}`); closeSheet(); toast("Deleted"); await loadState(); } catch (err) { toast(err.message); }
  };
}

const PAY_METHODS = ["Cash", "GCash", "Maya", "Bank transfer", "Card", "Other"];
const SOURCES = ["Walk-in", "Phone / text", "Facebook", "Instagram", "Airbnb", "Booking.com", "Agoda", "Referral", "Repeat guest", "Other"];

function shareBooking(b) {
  const s = S.data.settings, p = pay(b);
  const text = `${s.business_name} – Booking confirmation\n` +
    `Booking #: ${b.ref}\nGuest: ${b.guest_name}\nRoom: ${roomName(b.room_id)}\n` +
    `Check-in: ${fmtDate(b.check_in, { year: "numeric" })} from ${s.check_in_time}\n` +
    `Check-out: ${fmtDate(b.check_out, { year: "numeric" })} by ${s.check_out_time}\n` +
    `Nights: ${diffDays(b.check_in, b.check_out)}  Guests: ${b.guests}\n` +
    `Total: ${money(b.total)}  Paid: ${money(p.paid)}  Balance: ${money(p.balance)}\n` +
    `Thank you!`;
  if (window.AndroidApp) AndroidApp.share(text);
  else if (navigator.share) navigator.share({ text }).catch(() => {});
  else navigator.clipboard?.writeText(text).then(() => toast("Copied – paste it in Messenger/SMS"), () => prompt("Copy this:", text));
}

/* ---------- booking form ---------- */
function openBookingForm(b) {
  if (!S.data.activeRooms.length) { toast("Add a room first (More → Rooms)"); return; }
  const isNew = !b.id;
  const today = todayISO();
  const v = {
    room_id: S.data.activeRooms[0].id, check_in: today, check_out: addDays(today, 1), guests: 1, status: "booked",
    guest_name: "", phone: "", email: "", source: "", notes: "", total: "", ...b,
  };
  const room = S.data.roomById[v.room_id];
  const nights0 = diffDays(v.check_in, v.check_out);
  const rate0 = isNew ? room?.rate || 0 : nights0 > 0 ? Math.round((v.total / nights0) * 100) / 100 : 0;
  if (isNew && v.total === "") v.total = rate0 * nights0;
  const rooms = S.data.rooms.filter((r) => r.active || r.id === v.room_id);
  const bg = openSheet(isNew ? "New booking" : "Edit booking", `
    <form id="bkForm">
      <label class="f">Guest name<input name="guest_name" value="${esc(v.guest_name)}" required autocomplete="off"></label>
      <div class="row"><label class="f">Phone<input name="phone" type="tel" value="${esc(v.phone)}" autocomplete="off"></label>
      <label class="f">Guests<input name="guests" type="number" min="1" value="${v.guests}"></label></div>
      <label class="f">Room / suite<select name="room_id">${rooms.map((r) => `<option value="${r.id}" ${r.id === v.room_id ? "selected" : ""}>${esc(r.name)}${r.rate ? " – " + money(r.rate) + "/night" : ""}</option>`).join("")}</select></label>
      <div class="row"><label class="f">Check-in<input name="check_in" type="date" value="${v.check_in}" required></label>
      <label class="f">Check-out<input name="check_out" type="date" value="${v.check_out}" required></label></div>
      <div id="avail"></div>
      <div class="row"><label class="f">Price per night<input name="rate" type="number" step="0.01" inputmode="decimal" value="${rate0}"></label>
      <label class="f">Total price<input name="total" type="number" step="0.01" inputmode="decimal" value="${v.total}"></label></div>
      ${isNew ? `<div class="row"><label class="f">Down payment / paid now<input name="deposit" type="number" step="0.01" inputmode="decimal" placeholder="0"></label>
      <label class="f">Method<select name="deposit_method">${PAY_METHODS.map((m) => `<option>${m}</option>`).join("")}</select></label></div>` : ""}
      <label class="f">Booked via<select name="source"><option value="">—</option>${SOURCES.map((s) => `<option ${s === v.source ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="f">Email (optional)<input name="email" type="email" value="${esc(v.email)}"></label>
      <label class="f">Notes<textarea name="notes" placeholder="Early check-in, extra bed, special requests…">${esc(v.notes)}</textarea></label>
      <div class="err"></div>
      <button class="btn primary block">${isNew ? "Save booking" : "Save changes"}</button>
    </form>`);
  const form = $("#bkForm", bg);
  const F = (n) => form.elements[n];
  let totalTouched = !isNew;
  const recalc = (fromRate) => {
    const n = diffDays(F("check_in").value, F("check_out").value);
    if ((fromRate || !totalTouched) && n > 0) F("total").value = Math.round(F("rate").value * n * 100) / 100;
    const conflicts = n > 0 ? findConflicts(+F("room_id").value, F("check_in").value, F("check_out").value, b.id) : [];
    $("#avail", bg).innerHTML = n <= 0 ? `<div class="warn">Check-out must be after check-in</div>`
      : conflicts.length ? `<div class="warn">⚠ Already booked: ${conflicts.map((c) => `${esc(c.guest_name)} (${fmtRange(c)})`).join(", ")}</div>`
        : `<div class="ok">✓ Available · ${plural(n, "night")}</div>`;
  };
  F("check_in").addEventListener("change", () => {
    if (F("check_out").value <= F("check_in").value) F("check_out").value = addDays(F("check_in").value, 1);
    recalc();
  });
  F("check_out").addEventListener("change", () => recalc());
  F("room_id").addEventListener("change", () => {
    const r = S.data.roomById[F("room_id").value];
    if (r?.rate && isNew) { F("rate").value = r.rate; recalc(true); } else recalc();
  });
  F("rate").addEventListener("input", () => recalc(true));
  F("total").addEventListener("input", () => { totalTouched = true; });
  recalc();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    if (isNew) body.deposit_date = todayISO();
    const btn = $("button.primary", form);
    btn.disabled = true;
    try {
      const saved = await save(body);
      if (!saved) return;
      toast(isNew ? "Booking saved" : "Changes saved");
      await loadState();
      openBooking(saved.id);
    } catch (err) {
      $(".err", form).textContent = err.message;
    } finally { btn.disabled = false; }
  };
  async function save(body) {
    try {
      return isNew ? await api("POST", "/api/bookings", body) : await api("PUT", `/api/bookings/${b.id}`, body);
    } catch (err) {
      if (err.status === 409) {
        const list = (err.data.conflicts || []).map((c) => `• ${c.guest_name} ${c.check_in} → ${c.check_out}`).join("\n");
        if (!confirm(`${err.message}:\n${list}\n\nSave anyway (double booking)?`)) return null;
        return save({ ...body, force: true });
      }
      throw err;
    }
  }
}

/* ---------- admin forms ---------- */
function formSheet(title, fieldsHtml, submitLabel, onSubmit) {
  const bg = openSheet(title, `<form id="sf">${fieldsHtml}<div class="err"></div><button class="btn primary block">${submitLabel}</button></form>`);
  const form = $("#sf", bg);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("button.primary", form);
    btn.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), form);
      closeSheet();
      await loadState();
    } catch (err) { $(".err", form).textContent = err.message; } finally { btn.disabled = false; }
  };
  return form;
}

function openRoomForm(r) {
  const v = r || { name: "", kind: "", capacity: 2, rate: "", color: ["#4f46e5", "#0891b2", "#059669", "#d97706", "#db2777", "#7c3aed"][S.data.rooms.length % 6], active: 1, sort: S.data.rooms.length };
  formSheet(r ? "Edit room" : "Add room", `
    <label class="f">Name<input name="name" value="${esc(v.name)}" placeholder="e.g. Suite 1 / Deluxe A" required></label>
    <label class="f">Type<input name="kind" value="${esc(v.kind)}" placeholder="e.g. Family suite"></label>
    <div class="row"><label class="f">Max guests<input name="capacity" type="number" min="1" value="${v.capacity}"></label>
    <label class="f">Default price / night<input name="rate" type="number" step="0.01" value="${v.rate}"></label></div>
    <div class="row"><label class="f">Color<input name="color" type="color" value="${v.color}" style="height:46px;padding:4px"></label>
    <label class="f">Order<input name="sort" type="number" value="${v.sort}"></label></div>
    <label class="f" style="display:flex;gap:8px;align-items:center;color:var(--text)"><input name="active" type="checkbox" ${v.active ? "checked" : ""} style="width:auto;margin:0"> Show in calendar (uncheck to hide a room you no longer rent out)</label>`,
  "Save room", (body) => { body.active = !!body.active; return r ? api("PUT", `/api/rooms/${r.id}`, body) : api("POST", "/api/rooms", body); });
}

function openUserForm(u) {
  formSheet(u ? "Edit staff" : "Add staff", `
    <label class="f">Full name<input name="name" value="${esc(u?.name || "")}" required></label>
    ${u ? "" : `<label class="f">Username (for login)<input name="username" autocapitalize="none" required></label>`}
    <label class="f">${u ? "New password (leave blank to keep)" : "Password"}<input name="password" type="text" ${u ? "" : "required"} minlength="6" autocomplete="off"></label>
    <label class="f">Role<select name="role"><option value="staff">Staff</option><option value="admin" ${u?.role === "admin" ? "selected" : ""}>Admin (owner/manager)</option></select></label>
    ${u ? `<label class="f" style="display:flex;gap:8px;align-items:center;color:var(--text)"><input name="active" type="checkbox" ${u.active ? "checked" : ""} style="width:auto;margin:0"> Account active (uncheck to block login)</label>` : ""}`,
  u ? "Save" : "Create account", (body) => {
    if (u) { body.active = !!body.active; return api("PUT", `/api/users/${u.id}`, body); }
    return api("POST", "/api/users", body);
  });
}

function openSettings() {
  const s = S.data.settings;
  formSheet("Business settings", `
    <label class="f">Business name<input name="business_name" value="${esc(s.business_name)}" required></label>
    <label class="f">Currency symbol<input name="currency" value="${esc(s.currency)}" maxlength="5"></label>
    <div class="row"><label class="f">Check-in time<input name="check_in_time" type="time" value="${esc(s.check_in_time)}"></label>
    <label class="f">Check-out time<input name="check_out_time" type="time" value="${esc(s.check_out_time)}"></label></div>`,
  "Save", (body) => api("PUT", "/api/settings", body));
}

function openPassword() {
  formSheet("Change password", `
    <label class="f">Current password<input name="current" type="password" required></label>
    <label class="f">New password<input name="new" type="password" minlength="6" required></label>`,
  "Change password", async (body) => { await api("POST", "/api/password", body); toast("Password changed"); });
}

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });
function openInstall() {
  if (installPrompt) { installPrompt.prompt(); installPrompt = null; return; }
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  openSheet("Install on your phone", standalone ? `<div class="ok">✓ Already installed – you're using the app.</div>` : `
    <div class="card"><b>iPhone (Safari)</b><ol><li>Tap the <b>Share</b> button (square with arrow)</li><li>Tap <b>Add to Home Screen</b></li><li>Tap <b>Add</b></li></ol></div>
    <div class="card"><b>Android (Chrome)</b><ol><li>Tap the <b>⋮</b> menu</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b></li></ol></div>
    <p style="color:var(--muted);font-size:13px">Each staff member installs it on their own phone and logs in with their own account. Everyone sees the same bookings instantly.</p>`);
}

function exportCsv() {
  const cols = ["ref", "guest_name", "phone", "email", "room", "check_in", "check_out", "nights", "guests", "status", "source", "total", "paid", "balance", "notes", "created_at"];
  const lines = [cols.join(",")];
  for (const b of S.data.bookings) {
    const p = pay(b);
    const row = { ...b, room: roomName(b.room_id), nights: diffDays(b.check_in, b.check_out), paid: p.paid, balance: p.balance };
    lines.push(cols.map((c) => `"${String(row[c] ?? "").replace(/"/g, '""')}"`).join(","));
  }
  if (window.AndroidApp) { AndroidApp.saveFile(`bookings-${todayISO()}.csv`, "text/csv", "\ufeff" + lines.join("\n")); return; }
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bookings-${todayISO()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- theme ---------- */
const THEME_KEY = "akari_theme";
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function themePref() { return localStorage.getItem(THEME_KEY) || "system"; }
function applyTheme() {
  const p = themePref();
  const dark = p === "dark" || (p === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const bar = getComputedStyle(document.documentElement).getPropertyValue("--topbar").trim();
  $('meta[name="theme-color"]')?.setAttribute("content", bar);
  if (window.AndroidApp?.setStatusBar) AndroidApp.setStatusBar(bar);
}
darkQuery.addEventListener?.("change", applyTheme);
applyTheme();

/* ---------- boot ---------- */
window.__androidBack = () => {
  if ($(".sheet-bg")) { closeSheet(); return true; }
  const [page, sub] = route();
  if (sub) { location.hash = "#/" + page; return true; }
  if (page !== "today" && S.token) { location.hash = "#/today"; return true; }
  return false;
};
window.addEventListener("hashchange", () => { closeSheet(); window.scrollTo(0, 0); render(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.token) loadState().catch(() => {}); });
window.addEventListener("online", () => S.token && loadState().catch(() => {}));
window.addEventListener("offline", () => setOnline(false));

(async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (!S.token) return renderAuth();
  const cached = localStorage.getItem("suite_state");
  if (cached) { try { S.data = JSON.parse(cached); derive(); render(); } catch { /* ignore */ } }
  try { await loadState(); } catch (e) {
    if (!S.token) return;
    if (!S.data) { $("#app").innerHTML = `<div class="auth"><h1>Offline</h1><p class="lead">Connect to the internet and reload.</p></div>`; return; }
    setOnline(false);
  }
  syncLoop();
})();
