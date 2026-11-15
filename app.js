'use strict';
/* EverReady — plain JavaScript, no build step.
   Security note: this file only ever holds the PUBLIC key (config.js).
   All privacy is enforced by the database's Row Level Security rules. */

const CFG = window.EVERREADY_CONFIG;
const sb = window.supabase.createClient(CFG.url, CFG.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});
const $app = document.getElementById('app');
const YEAR = new Date().getFullYear();

const S = {
  user: null, hh: null, admin: false,
  cats: [], items: [], hi: new Map(), batches: [],
  all: null, settings: {}, filter: 'all', loaded: false
};

/* ---------- small helpers ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root) => (root || document).querySelector(sel);
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function friendly(err) {
  const m = (err && err.message) || String(err || '');
  if (/invalid login/i.test(m)) return 'That email and password do not match. Please try again.';
  if (/already registered|already been registered/i.test(m)) return 'That email already has an account. Try logging in instead.';
  if (/database error saving new user|valid invite/i.test(m)) return 'This invite link is not valid any more. Ask for a new one.';
  if (/password/i.test(m) && /6|8|short|weak/i.test(m)) return 'Please choose a password with at least 8 characters.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a minute and try again.';
  if (/email.*confirm|not confirmed/i.test(m)) return 'Email confirmation is still switched on in Supabase. See the setup guide.';
  return m || 'Something went wrong. Please try again.';
}
const icon = {
  home: '<svg viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12.5L13 4l10 8.5"/><path d="M6 11v10h14V11"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>',
  chev: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>'
};
// Notes are escaped first, so only our own <strong> tag can ever appear.
function noteHtml(text) {
  return esc(text).replace(/^Guide:/, '<strong class="guide-word">Guide:</strong>');
}
function pctText(x) { return Math.round(x * 100) + '%'; }
function relDay(ts) {
  if (!ts) return 'Never';
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 14) return d + ' days ago';
  if (d < 60) return Math.floor(d / 7) + ' weeks ago';
  return Math.floor(d / 30) + ' months ago';
}

/* ---------- status maths (shared by user + admin views) ---------- */
function itemScore(it, row) {
  if (it.recommended_weeks) return Math.min((row && row.weeks_stocked) || 0, it.recommended_weeks) / it.recommended_weeks;
  return row && row.done ? 1 : 0;
}
function itemState(it, row) {
  const s = itemScore(it, row);
  if (s >= 1) return 'complete';
  if (s > 0) return 'low';
  return 'empty';
}
function batchStatus(b) {
  if (b.used) return { key: 'used', label: 'Used', cls: '' };
  if (b.expiry_year == null) return { key: 'ok', label: 'No expiry set', cls: '' };
  if (b.expiry_year < YEAR) return { key: 'expired', label: 'Expired', cls: 'bad' };
  if (b.expiry_year === YEAR) return { key: 'soon', label: 'Expires this year', cls: 'warn' };
  return { key: 'ok', label: 'Good', cls: 'home' };
}
function summarize(items, rowsByItem, batches) {
  let sum = 0, low = 0;
  items.forEach((it) => {
    const r = rowsByItem.get(it.id);
    sum += itemScore(it, r);
    if (itemState(it, r) === 'low') low++;
  });
  const expiring = batches.filter((b) => { const k = batchStatus(b).key; return k === 'expired' || k === 'soon'; }).length;
  return { ready: items.length ? sum / items.length : 0, low, expiring };
}
function tagsFor(it) {
  const t = [];
  if (it.is_optional) t.push('<span class="pill">Optional</span>');
  if (it.at_home) t.push('<span class="pill home">At home</span>');
  if (it.portable === 'small') t.push('<span class="pill kit">Small amount in kit</span>');
  if (it.portable === 'full') t.push('<span class="pill kit">Portable kit</span>');
  return t.join(' ');
}
function waterGoal(it) {
  if (!it.liters_per_person_per_day || !it.recommended_weeks || !S.hh) return '';
  const total = it.liters_per_person_per_day * S.hh.people * 7 * it.recommended_weeks;
  return 'Goal for ' + S.hh.people + (S.hh.people === 1 ? ' person' : ' people') + ': ' + total + ' L (' + it.liters_per_person_per_day + ' L per person per day for ' + it.recommended_weeks + ' weeks)';
}

function trimNum(n) { return String(Math.round(n * 10) / 10); }
function fmtGrams(g) { return (Math.round(g / 10) * 10).toLocaleString('en-US') + ' g'; }
// Estimated volume from weight, using a typical density for the food (g per ml).
function fmtVolume(ml) {
  if (ml >= 1000) return { n: trimNum(ml / 1000), u: 'L' };
  return { n: String(Math.round(ml / 10) * 10), u: 'ml' };
}
// One line for the household's own size, worked out from the per-person amount.
function householdAmount(it) {
  if (!it.per_person_min || !S.hh) return '';
  const lo = it.per_person_min * S.hh.people;
  const hi = (it.per_person_max || it.per_person_min) * S.hh.people;
  const grams = lo === hi ? fmtGrams(lo) : fmtGrams(lo).replace(' g', '') + ' to ' + fmtGrams(hi);
  let vol = '';
  if (it.per_person_density) {
    const a = fmtVolume(lo / it.per_person_density), b = fmtVolume(hi / it.per_person_density);
    if (lo === hi) vol = a.n + ' ' + a.u;
    else if (a.u === b.u) vol = a.n + ' to ' + b.n + ' ' + a.u;
    else vol = a.n + ' ' + a.u + ' to ' + b.n + ' ' + b.u;
  }
  return 'For your household of ' + S.hh.people + ': about ' + grams + (vol ? ' (about ' + vol + ')' : '');
}

/* ---------- data loading ---------- */
async function loadAll() {
  const uid = S.user.id;
  const [c, i, h, a, st] = await Promise.all([
    sb.from('categories').select('*').eq('active', true).order('sort_order'),
    sb.from('items').select('*').eq('active', true).order('sort_order'),
    sb.from('households').select('*').eq('owner_id', uid).maybeSingle(),
    sb.from('admins').select('user_id').eq('user_id', uid).maybeSingle(),
    sb.from('app_settings').select('*')
  ]);
  if (c.error) throw c.error; if (i.error) throw i.error; if (h.error) throw h.error;
  S.cats = c.data; S.items = i.data; S.hh = h.data; S.admin = !!a.data;
  S.settings = {}; (st.data || []).forEach((r) => { S.settings[r.key] = r.value; });
  if (!S.hh) throw new Error('Your household record is missing. Please contact the administrator.');
  const [hi, bt] = await Promise.all([
    sb.from('household_items').select('*').eq('household_id', S.hh.id),
    sb.from('purchase_batches').select('*').eq('household_id', S.hh.id).order('expiry_year', { nullsFirst: false }).order('purchase_year')
  ]);
  if (hi.error) throw hi.error; if (bt.error) throw bt.error;
  S.hi = new Map(hi.data.map((r) => [r.item_id, r]));
  S.batches = bt.data;
  S.loaded = true;
  sb.from('households').update({ last_active_at: new Date().toISOString() }).eq('id', S.hh.id).then(() => {});
}
async function loadAdminData() {
  const [h, hi, bt, it, ct] = await Promise.all([
    sb.from('households').select('*').order('created_at'),
    sb.from('household_items').select('*'),
    sb.from('purchase_batches').select('*'),
    sb.from('items').select('*').order('sort_order'),
    sb.from('categories').select('*').order('sort_order')
  ]);
  for (const r of [h, hi, bt, it, ct]) if (r.error) throw r.error;
  const rows = new Map(); hi.data.forEach((r) => { if (!rows.has(r.household_id)) rows.set(r.household_id, new Map()); rows.get(r.household_id).set(r.item_id, r); });
  const bat = new Map(); bt.data.forEach((b) => { if (!bat.has(b.household_id)) bat.set(b.household_id, []); bat.get(b.household_id).push(b); });
  S.all = { households: h.data, rows, bat, items: it.data, cats: ct.data };
}

/* ---------- layout pieces ---------- */
function shell(inner, tab, wide) {
  const tabs = '<nav class="tabbar" aria-label="Main">' +
    '<a href="#/" class="' + (tab === 'home' ? 'on' : '') + '">' + icon.home + 'Home</a>' +
    (S.admin ? '<a href="#/admin" class="' + (tab === 'admin' ? 'on' : '') + '">' + icon.shield + 'Admin</a>' : '') +
    '<a href="#/account" class="' + (tab === 'account' ? 'on' : '') + '">' + icon.user + 'Account</a></nav>';
  const initials = (S.hh ? S.hh.name : 'EV').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return '<div class="wrap' + (wide ? ' wide' : '') + '"><header class="top"><a class="brand" href="#/"><img src="logo.png" alt="">EverReady</a>' +
    '<a class="avatar" href="#/account" aria-label="Account">' + esc(initials) + '</a></header>' + inner + '</div>' + tabs;
}
function bar(p, thick) { return '<div class="bar' + (thick ? ' thick' : '') + '"><i style="width:' + Math.round(p * 100) + '%"></i></div>'; }
function weekBoxes(it, row, interactive) {
  const n = (row && row.weeks_stocked) || 0;
  let h = '<div class="weeks">';
  for (let i = 1; i <= it.recommended_weeks; i++) {
    const on = i <= n;
    h += interactive
      ? '<button type="button" class="wk' + (on ? ' on' : '') + '" data-action="week" data-item="' + it.id + '" data-n="' + i + '" aria-pressed="' + on + '" aria-label="' + esc(it.name) + ', week ' + i + '">' + (on ? icon.check : i) + '</button>'
      : '<span class="wk static' + (on ? ' on' : '') + '">' + (on ? icon.check : i) + '</span>';
  }
  return h + '</div>';
}
function doneButton(it, row) {
  const on = !!(row && row.done);
  return '<button type="button" class="done' + (on ? ' on' : '') + '" data-action="done" data-item="' + it.id + '" aria-pressed="' + on + '"><span class="box">' + (on ? icon.check : '') + '</span>' + (on ? 'Done' : 'Mark as done') + '</button>';
}
function kitButton(it, row) {
  if (it.portable === 'none' || !it.at_home) return '';
  const on = !!(row && row.portable_done);
  return '<button type="button" class="done' + (on ? ' on' : '') + '" data-action="kit" data-item="' + it.id + '" aria-pressed="' + on + '"><span class="box">' + (on ? icon.check : '') + '</span>' + (it.portable === 'small' ? 'Small amount also in portable kit' : 'Also in portable kit') + '</button>';
}
function itemCard(it) {
  const row = S.hi.get(it.id);
  const weeks = it.recommended_weeks ? Math.min((row && row.weeks_stocked) || 0, it.recommended_weeks) : 0;
  let body;
  if (it.recommended_weeks) {
    body = weekBoxes(it, row, true) + '<div class="sub"><b style="color:var(--dark)">' + weeks + ' of ' + it.recommended_weeks + ' weeks stocked</b></div>';
  } else {
    body = doneButton(it, row);
  }
  const extra = [];
  if (it.target_quantity) extra.push('Target: ' + esc(it.target_quantity));
  const wg = waterGoal(it); if (wg) extra.push(esc(wg));
  const ha = householdAmount(it); if (ha) extra.push('<b style="color:var(--dark)">' + esc(ha) + '</b>');
  return '<div class="card stack"><div class="between"><span class="item-name">' + esc(it.name) + '</span>' +
    '<a class="link" href="#/item/' + it.id + '">Details</a></div><div class="row">' + tagsFor(it) + '</div>' + body +
    (extra.length ? '<div class="sub">' + extra.join('<br>') + '</div>' : '') + kitButton(it, row) + '</div>';
}

/* ---------- views ---------- */
function viewAuth(mode) {
  const invite = sessionStorage.getItem('er_invite') || '';
  const signup = mode === 'signup' && invite;
  let h = '<div class="auth"><a class="brand" href="#/"><img src="logo.png" alt="">EverReady</a>';
  if (signup) {
    h += '<div class="stack"><h1>Create your household account</h1><p class="sub">You have been invited. This takes about a minute.</p></div>' +
      '<div id="msg"></div><form id="signup" class="stack" style="gap:18px" novalidate>' +
      '<div class="field"><label for="hn">Household name</label><input id="hn" type="text" maxlength="80" placeholder="For example, Oakridge Household" autocomplete="off" required></div>' +
      '<div class="field"><span style="font-weight:600;margin-bottom:6px">People in your household</span><div class="stepper"><button type="button" data-action="people" data-d="-1" aria-label="One fewer person">&minus;</button><b id="pc">1</b><button type="button" data-action="people" data-d="1" aria-label="One more person">+</button></div><span class="hint">Used to work out how much water you need.</span></div>' +
      '<div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="email" placeholder="you@example.com" required></div>' +
      '<div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="new-password" placeholder="At least 8 characters" required></div>' +
      '<button class="btn block" type="submit">Create account</button></form>' +
      '<p class="hint" style="text-align:center">Already have an account? <a href="#/login">Log in</a></p>' +
      '<p class="hint" style="text-align:center">By continuing you agree to the <a href="#/terms">Terms</a> and <a href="#/privacy">Privacy Policy</a>.</p>';
  } else {
    h += '<div class="stack"><h1>Welcome back</h1><p class="sub">Log in to see your household\'s supplies.</p></div>' +
      '<div id="msg"></div><form id="login" class="stack" style="gap:18px" novalidate>' +
      '<div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="email" required></div>' +
      '<div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>' +
      '<button class="btn block" type="submit">Log in</button></form>' +
      (invite ? '<p class="hint" style="text-align:center">New here? <a href="#/signup">Create your household account</a></p>'
        : '<p class="hint" style="text-align:center">Need an account? Ask for an invite link.</p>') +
      '<p class="hint" style="text-align:center">Forgot your password? Ask the administrator to reset it for you.</p>';
  }
  return h + '</div>';
}

function viewDashboard() {
  const sm = summarize(S.items, S.hi, S.batches);
  const C = 2 * Math.PI * 54;
  const ring = '<svg width="132" height="132" viewBox="0 0 132 132" role="img" aria-label="Overall readiness ' + pctText(sm.ready) + '"><circle cx="66" cy="66" r="54" fill="none" stroke="#E8E2D6" stroke-width="12"/><circle cx="66" cy="66" r="54" fill="none" stroke="#2F6B4F" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + (C * sm.ready).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 66 66)"/><text x="66" y="75" text-anchor="middle" font-size="30" font-family="Fraunces,Georgia,serif" font-weight="700" fill="#1F2A24">' + pctText(sm.ready) + '</text></svg>';
  const itemById = new Map(S.items.map((x) => [x.id, x]));
  const att = [];
  S.batches.forEach((b) => {
    const st = batchStatus(b); const it = itemById.get(b.item_id);
    if (it && (st.key === 'expired' || st.key === 'soon')) att.push({ id: it.id, name: it.name + ' — ' + b.purchase_year + ' batch', detail: 'Estimated expiry ' + b.expiry_year, tag: st.label, cls: st.cls, w: st.key === 'expired' ? 0 : 1 });
  });
  S.items.forEach((it) => {
    const r = S.hi.get(it.id);
    if (itemState(it, r) === 'low') att.push({ id: it.id, name: it.name, detail: ((r && r.weeks_stocked) || 0) + ' of ' + it.recommended_weeks + ' weeks stocked', tag: 'Low', cls: 'bad', w: 2 });
  });
  att.sort((a, b) => a.w - b.w);
  const attHtml = att.length
    ? att.slice(0, 8).map((a) => '<a class="card between" style="text-decoration:none;color:inherit" href="#/item/' + a.id + '"><div><div class="item-name" style="font-size:16px">' + esc(a.name) + '</div><div class="sub" style="font-size:14px">' + esc(a.detail) + '</div></div><span class="pill ' + a.cls + '">' + esc(a.tag) + '</span></a>').join('') + (att.length > 8 ? '<p class="hint">and ' + (att.length - 8) + ' more</p>' : '')
    : '<div class="card sub">Nothing needs attention right now.</div>';
  const cats = S.cats.map((c) => {
    const its = S.items.filter((i) => i.category_id === c.id);
    const s = summarize(its, S.hi, []);
    const todo = its.filter((i) => itemState(i, S.hi.get(i.id)) !== 'complete').length;
    return '<a class="card cat-link" href="#/cat/' + c.id + '"><div class="between"><span class="item-name" style="font-size:16px">' + esc(c.name) + '</span><span style="display:flex;align-items:center;gap:6px;font-weight:700;color:var(--dark)">' + pctText(s.ready) + icon.chev + '</span></div>' + bar(s.ready) + '<span class="hint">' + (todo ? todo + (todo === 1 ? ' item' : ' items') + ' to stock' : 'All done') + '</span></a>';
  }).join('');
  return shell('<div class="stack" style="gap:2px"><h1>' + esc(S.hh.name) + '</h1><span class="sub">' + S.hh.people + (S.hh.people === 1 ? ' person' : ' people') + '</span></div>' +
    '<section class="card big stack" style="gap:18px"><div class="hero">' + ring + '<div class="stack" style="gap:6px"><span class="eyebrow">Overall readiness</span><span style="font-family:Fraunces,Georgia,serif;font-size:22px;font-weight:700;line-height:1.2">' + (sm.ready >= 1 ? 'Fully stocked. Well done.' : sm.ready >= 0.5 ? 'A solid start. Keep going.' : 'Every week you add counts.') + '</span></div></div>' +
    '<div class="row">' + (sm.low ? '<span class="pill bad" style="font-size:14px;padding:8px 14px">' + sm.low + ' low on stock</span>' : '') + (sm.expiring ? '<span class="pill warn" style="font-size:14px;padding:8px 14px">' + sm.expiring + ' expiring or expired</span>' : '') + '</div></section>' +
    '<section class="stack"><h2>Needs attention</h2>' + attHtml + '</section>' +
    '<section class="stack"><h2>Your supplies</h2>' + cats + '</section>', 'home');
}

function viewCategory(id) {
  const c = S.cats.find((x) => x.id === id); if (!c) return notFound();
  const its = S.items.filter((i) => i.category_id === id);
  const s = summarize(its, S.hi, []);
  const f = S.filter;
  const shown = its.filter((i) => { const st = itemState(i, S.hi.get(i.id)); return f === 'all' || (f === 'todo' && st !== 'complete') || (f === 'done' && st === 'complete'); });
  let body = '', lastGroup = '__none__';
  shown.forEach((it) => {
    const g = it.group_title || '';
    if (g !== lastGroup) { if (g) body += '<h3 class="group">' + esc(g) + '</h3>'; lastGroup = g; }
    body += itemCard(it);
  });
  if (!shown.length) body = '<div class="card sub">Nothing to show here.</div>';
  return shell('<div class="stack"><a class="back" href="#/">' + icon.back + 'Home</a><div class="between" style="align-items:flex-end"><h1>' + esc(c.name) + '</h1><span style="font-family:Fraunces,Georgia,serif;font-size:26px;font-weight:700;color:var(--dark)">' + pctText(s.ready) + '</span></div>' + (c.label ? '<span class="hint">' + esc(c.label) + '</span>' : '') + bar(s.ready, true) + '</div>' +
    '<div class="row"><button class="chip' + (f === 'all' ? ' on' : '') + '" data-action="filter" data-f="all">All</button><button class="chip' + (f === 'todo' ? ' on' : '') + '" data-action="filter" data-f="todo">Needs stocking</button><button class="chip' + (f === 'done' ? ' on' : '') + '" data-action="filter" data-f="done">Complete</button></div>' + body, 'home');
}

function batchesHtml(it, hhId, readonly) {
  const list = (readonly ? readonly : S.batches).filter((b) => b.item_id === it.id);
  const firstId = (list.filter((b) => !b.used && b.expiry_year != null).sort((a, b) => a.expiry_year - b.expiry_year)[0] || {}).id;
  if (!list.length) return '<div class="card sub">No purchases recorded yet.</div>';
  return list.slice().sort((a, b) => (a.expiry_year == null) - (b.expiry_year == null) || (a.expiry_year || 0) - (b.expiry_year || 0) || a.purchase_year - b.purchase_year).map((b) => {
    const st = batchStatus(b);
    return '<div class="card stack"><div class="between"><span class="item-name">' + esc(it.name) + ' — ' + b.purchase_year + '</span><span class="sub" style="font-weight:600">' + esc(b.quantity || '') + '</span></div>' +
      '<div class="row">' + (b.id === firstId ? '<span class="pill first">Use first</span>' : '') + '<span class="pill ' + st.cls + '">' + esc(st.label) + '</span></div>' +
      '<div class="between sub" style="font-size:14px"><span>' + (b.shelf_life_years ? 'Shelf life ' + b.shelf_life_years + ' years' : 'No shelf life set') + '</span><span>' + (b.expiry_year ? 'Estimated expiry ' + b.expiry_year : '') + '</span></div>' +
      (b.exact_date ? '<div class="hint">Purchased ' + esc(b.exact_date) + '</div>' : '') + (b.note ? '<div class="sub" style="font-size:14px">' + esc(b.note) + '</div>' : '') +
      (readonly ? '' : '<div class="row"><button class="btn line small" data-action="batch-used" data-id="' + b.id + '">' + (b.used ? 'Mark as not used' : 'Mark this batch as used') + '</button><button class="link" data-action="batch-del" data-id="' + b.id + '">Delete</button></div>') + '</div>';
  }).join('');
}

function viewItem(id) {
  const it = S.items.find((x) => x.id === id); if (!it) return notFound();
  const row = S.hi.get(id);
  const cat = S.cats.find((c) => c.id === it.category_id);
  const weeks = it.recommended_weeks ? Math.min((row && row.weeks_stocked) || 0, it.recommended_weeks) : 0;
  const wg = waterGoal(it);
  return shell('<div class="stack"><a class="back" href="#/cat/' + it.category_id + '">' + icon.back + esc(cat ? cat.name : 'Back') + '</a><h1 style="font-size:32px">' + esc(it.name) + '</h1>' + (it.group_title ? '<span class="hint">' + esc(it.group_title) + '</span>' : '') + '<div class="row">' + tagsFor(it) + '</div></div>' +
    ((it.notes || householdAmount(it)) ? '<div class="card sub note">' + (it.notes ? noteHtml(it.notes) : '') + (householdAmount(it) ? '<div class="household-line">' + esc(householdAmount(it)) + '</div>' : '') + '</div>' : '') +
    '<section class="card big stack">' + (it.recommended_weeks
      ? '<div class="between"><h3>Weeks stocked</h3><span style="font-family:Fraunces,Georgia,serif;font-size:22px;font-weight:700;color:var(--dark)">' + weeks + ' of ' + it.recommended_weeks + '</span></div>' + weekBoxes(it, row, true)
      : '<h3>Stocked?</h3>' + doneButton(it, row)) +
    (it.target_quantity ? '<div class="sub">Target: ' + esc(it.target_quantity) + '</div>' : '') + (wg ? '<div class="sub">' + esc(wg) + '</div>' : '') + kitButton(it, row) + '</section>' +
    '<section class="stack"><label for="nt" style="margin:0;color:var(--muted);font-size:15px">Your storage notes</label><textarea id="nt" data-item="' + id + '" maxlength="500" placeholder="Where it is stored, brand, anything to remember">' + esc((row && row.notes) || '') + '</textarea></section>' +
    '<section class="stack"><div class="between"><h2>Purchases</h2><span class="hint">Oldest expiry first</span></div>' + batchesHtml(it) + '</section>' +
    '<section class="card big stack" style="border:2px solid var(--green)"><h3>Add a purchase</h3><form id="addbatch" class="stack" data-item="' + id + '" novalidate>' +
    '<div class="row" style="flex-wrap:nowrap"><div class="field" style="flex:1"><label for="py">Year</label><input id="py" type="number" inputmode="numeric" value="' + YEAR + '" min="1980" max="2200"></div><div class="field" style="flex:1"><label for="pq">Quantity</label><input id="pq" type="text" maxlength="40" placeholder="10 kg"></div></div>' +
    '<div class="field"><label for="ps">Shelf life in years (optional)</label><input id="ps" type="number" inputmode="numeric" min="1" max="100" value="' + (it.default_shelf_life_years || '') + '" placeholder="For example, 10"></div>' +
    '<div class="field"><label for="pd">Exact date (optional)</label><input id="pd" type="text" placeholder="2026-11-14" maxlength="10"></div>' +
    '<div class="field"><label for="pn">Note (optional)</label><input id="pn" type="text" maxlength="200"></div>' +
    '<button class="btn block" type="submit">Save purchase</button></form></section>', 'home');
}

function viewAccount() {
  return shell('<h1>Account</h1><div id="msg"></div>' +
    '<form id="acct" class="card big stack" novalidate><h3>Household</h3><div class="field"><label for="an">Household name</label><input id="an" type="text" maxlength="80" value="' + esc(S.hh.name) + '"></div>' +
    '<div class="field"><span style="font-weight:600;margin-bottom:6px">People in your household</span><div class="stepper"><button type="button" data-action="people" data-d="-1" aria-label="One fewer person">&minus;</button><b id="pc">' + S.hh.people + '</b><button type="button" data-action="people" data-d="1" aria-label="One more person">+</button></div></div>' +
    '<p class="hint">Signed in as ' + esc(S.user.email) + '</p><button class="btn" type="submit">Save</button></form>' +
    '<form id="pwform" class="card big stack" novalidate><h3>Change password</h3><div class="field"><label for="np">New password</label><input id="np" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div><button class="btn" type="submit">Change password</button></form>' +
    '<div class="card big stack"><button class="btn line" data-action="logout">Log out</button><div class="row"><a class="link" href="#/privacy">Privacy policy</a><a class="link" href="#/terms">Terms of use</a></div></div>' +
    '<div class="card big stack"><h3>Delete my account</h3><p class="sub">This permanently removes your account and everything you have recorded. It cannot be undone.</p><button class="btn danger" data-action="delete-account">Delete my account and data</button></div>', 'account');
}

function viewLegal(kind) {
  const inner = kind === 'privacy'
    ? '<h1>Privacy policy</h1><div class="card big legal stack"><p>EverReady is a small private app run by an individual in Canada for family and friends. It is not a business and is not open to the public.</p>' +
      '<h2>What we collect</h2><p>Your email address, your household name and size, and the supplies you record (weeks stocked, purchase years, quantities, shelf life and notes).</p>' +
      '<h2>Who can see it</h2><p>You can see your own household. The app administrator can view all households\' records, including what each has and is missing. Other households can never see yours. Your data is not sold, shared with advertisers or used for anything else.</p>' +
      '<h2>Where it is stored</h2><p>In a database hosted in Canada (Montreal) with Supabase. The website is served by Vercel. Passwords are stored only as secure hashes.</p>' +
      '<h2>Your choices</h2><p>You can change your details or delete your account and all your data yourself from the Account page at any time. You can also ask the administrator to do it for you.</p>' +
      '<h2>Questions</h2><p>Ask the person who invited you. This policy is written in plain language and may be updated as the app changes.</p></div>'
    : '<h1>Terms of use</h1><div class="card big legal stack"><p>EverReady is a private, invite-only tool provided free of charge as a convenience. By using it you agree to these simple terms.</p>' +
      '<ul><li>Use it only for your own household\'s preparedness planning.</li><li>Keep your password private. You are responsible for activity on your account.</li><li>The supply list is a general guide. It is not professional emergency, medical or safety advice.</li><li>The app is provided as is, with no guarantee it will always be available or error free. Keep your own copy of anything important.</li><li>The administrator may remove accounts or change the app at any time.</li></ul></div>';
  return shell('<a class="back" href="javascript:history.back()">' + icon.back + 'Back</a>' + inner, 'account');
}
function notFound() { return shell('<h1>Not found</h1><p class="sub">That page does not exist.</p><a class="btn" href="#/">Go home</a>', 'home'); }

/* ---------- admin views ---------- */
function hhStats(h) {
  const rows = S.all.rows.get(h.id) || new Map();
  const bat = S.all.bat.get(h.id) || [];
  const act = S.all.items.filter((i) => i.active);
  return Object.assign({ h, rows, bat }, summarize(act, rows, bat));
}
function inviteLink() { return location.origin + location.pathname + '?invite=' + encodeURIComponent(S.settings.invite_code || ''); }

function viewAdmin() {
  const stats = S.all.households.map(hhStats);
  const avg = stats.length ? stats.reduce((a, s) => a + s.ready, 0) / stats.length : 0;
  const on = S.settings.invites_enabled === 'true';
  const rows = stats.map((s) => '<tr class="click" data-action="go" data-to="#/admin/hh/' + s.h.id + '"><td><a href="#/admin/hh/' + s.h.id + '" style="font-weight:700;color:var(--ink);text-decoration:none">' + esc(s.h.name) + '</a><div class="hint">' + esc(s.h.email || '') + '</div></td><td>' + s.h.people + '</td><td style="min-width:150px"><div class="row" style="flex-wrap:nowrap">' + '<div style="flex:1">' + bar(s.ready) + '</div><b style="width:40px">' + pctText(s.ready) + '</b></div></td><td>' + s.low + '</td><td>' + s.expiring + '</td><td class="sub">' + relDay(s.h.last_active_at) + '</td></tr>').join('');
  return shell('<div class="between"><h1>Admin</h1><div class="row"><a class="btn line small" href="#/admin/master">Master list</a><button class="btn small" data-action="backup">Download backup</button></div></div>' +
    '<div class="grid"><div class="card stat"><span class="eyebrow">Households</span><b>' + stats.length + '</b></div><div class="card stat"><span class="eyebrow">Average readiness</span><b>' + pctText(avg) + '</b></div><div class="card stat"><span class="eyebrow">Items low</span><b>' + stats.reduce((a, s) => a + s.low, 0) + '</b></div><div class="card stat"><span class="eyebrow">Expiring or expired</span><b>' + stats.reduce((a, s) => a + s.expiring, 0) + '</b></div></div>' +
    '<section class="card big stack"><h2 style="font-size:18px">All households</h2><div class="scroll"><table><thead><tr><th>Household</th><th>People</th><th>Readiness</th><th>Low</th><th>Expiring</th><th>Last active</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="sub">No households yet.</td></tr>') + '</tbody></table></div></section>' +
    '<section class="card big stack"><h2 style="font-size:18px">Invite link</h2><p class="sub">Anyone with this link can create a household account. Status: <b>' + (on ? 'on' : 'off') + '</b></p>' +
    '<div class="mono">' + esc(inviteLink()) + '</div><div class="row"><button class="btn line small" data-action="copy-invite">Copy link</button><button class="btn line small" data-action="new-invite">Replace link</button><button class="btn ' + (on ? 'danger' : '') + ' small" data-action="toggle-invite">' + (on ? 'Turn off' : 'Turn on') + '</button></div></section>', 'admin', true);
}

function viewAdminHousehold(id) {
  const h = S.all.households.find((x) => x.id === id); if (!h) return notFound();
  const s = hhStats(h);
  const act = S.all.items.filter((i) => i.active);
  const cats = S.all.cats.filter((c) => c.active);
  const catRows = cats.map((c) => {
    const its = act.filter((i) => i.category_id === c.id);
    const sm = summarize(its, s.rows, []);
    return '<div class="row" style="flex-wrap:nowrap"><span style="flex:0 0 170px;font-weight:600;font-size:14px">' + esc(c.name) + '</span><div style="flex:1">' + bar(sm.ready) + '</div><b style="width:44px;text-align:right">' + pctText(sm.ready) + '</b></div>';
  }).join('');
  const itemById = new Map(S.all.items.map((i) => [i.id, i]));
  const detail = cats.map((c) => {
    const its = act.filter((i) => i.category_id === c.id);
    const trs = its.map((it) => {
      const r = s.rows.get(it.id); const st = itemState(it, r);
      const val = it.recommended_weeks ? (((r && r.weeks_stocked) || 0) + ' / ' + it.recommended_weeks + ' wk') : (r && r.done ? 'Done' : '—');
      const kit = it.portable !== 'none' && r && r.portable_done ? ' <span class="pill kit">kit</span>' : '';
      return '<tr><td>' + esc(it.name) + (it.group_title ? '<div class="hint">' + esc(it.group_title) + '</div>' : '') + (r && r.notes ? '<div class="hint">Note: ' + esc(r.notes) + '</div>' : '') + '</td><td>' + esc(val) + kit + '</td><td><span class="pill ' + (st === 'complete' ? 'home' : st === 'low' ? 'bad' : '') + '">' + (st === 'complete' ? 'Complete' : st === 'low' ? 'Low' : 'Empty') + '</span></td></tr>';
    }).join('');
    return '<details class="card"><summary style="cursor:pointer;font-weight:700;min-height:44px;display:flex;align-items:center">' + esc(c.name) + '</summary><div class="scroll"><table><tbody>' + trs + '</tbody></table></div></details>';
  }).join('');
  const bt = s.bat.slice().sort((a, b) => (a.expiry_year || 9999) - (b.expiry_year || 9999)).map((b) => {
    const it = itemById.get(b.item_id); const st = batchStatus(b);
    return '<tr><td>' + esc(it ? it.name : '?') + '</td><td>' + b.purchase_year + '</td><td>' + esc(b.quantity || '') + '</td><td>' + (b.expiry_year || '—') + '</td><td><span class="pill ' + st.cls + '">' + esc(st.label) + '</span></td></tr>';
  }).join('');
  return shell('<a class="back" href="#/admin">' + icon.back + 'All households</a>' +
    '<div class="stack" style="gap:2px"><span class="eyebrow">Full view</span><h1>' + esc(h.name) + '</h1><span class="sub">' + h.people + ' people · ' + esc(h.email || '') + ' · ' + pctText(s.ready) + ' ready · last active ' + relDay(h.last_active_at) + '</span></div>' +
    '<div class="two"><section class="card big stack"><h2 style="font-size:18px">Progress by category</h2>' + catRows + '</section>' +
    '<section class="card big stack"><h2 style="font-size:18px">Account tools</h2><p class="sub">Set a new password (tell them in person), or remove the account and all its data.</p><div class="row"><button class="btn line small" data-action="admin-pw" data-id="' + h.id + '">Set new password</button><button class="btn danger small" data-action="admin-del" data-id="' + h.id + '">Remove household</button></div></section></div>' +
    '<section class="stack"><h2>All items</h2>' + detail + '</section>' +
    '<section class="card big stack"><h2 style="font-size:18px">Purchases</h2><div class="scroll"><table><thead><tr><th>Item</th><th>Year</th><th>Qty</th><th>Expiry</th><th>Status</th></tr></thead><tbody>' + (bt || '<tr><td colspan="5" class="sub">None recorded.</td></tr>') + '</tbody></table></div></section>', 'admin', true);
}

function viewAdminMaster() {
  const cats = S.all.cats;
  const body = cats.map((c) => {
    const its = S.all.items.filter((i) => i.category_id === c.id);
    return '<section class="card big stack"><div class="between"><h2 style="font-size:19px">' + esc(c.name) + (c.active ? '' : ' <span class="pill">hidden</span>') + '</h2><div class="row"><button class="btn line small" data-action="edit-cat" data-id="' + c.id + '">Edit</button><button class="btn small" data-action="add-item" data-cat="' + c.id + '">Add item</button></div></div><div class="scroll"><table><tbody>' +
      its.map((i) => '<tr><td>' + esc(i.name) + (i.group_title ? '<div class="hint">' + esc(i.group_title) + '</div>' : '') + (i.active ? '' : ' <span class="pill">hidden</span>') + '</td><td class="sub">' + (i.recommended_weeks ? i.recommended_weeks + ' wk' : 'checkbox') + '</td><td><button class="link" data-action="edit-item" data-id="' + i.id + '">Edit</button></td></tr>').join('') + '</tbody></table></div></section>';
  }).join('');
  return shell('<a class="back" href="#/admin">' + icon.back + 'Admin</a><div class="between"><h1>Master list</h1><button class="btn small" data-action="add-cat">Add category</button></div><p class="sub">Changes apply to everyone straight away. Hiding an item keeps everyone\'s progress; it just stops showing.</p>' + body, 'admin', true);
}

/* ---------- router ---------- */
async function route() {
  const hash = location.hash || '#/';
  const m = hash.replace(/^#\/?/, '').split('/');
  if (!S.user) { $app.innerHTML = viewAuth(m[0] === 'signup' ? 'signup' : 'login'); return; }
  if (!S.loaded) { $app.innerHTML = '<p class="boot">Loading your household…</p>'; return; }
  const y = window.scrollY; let html;
  try {
    if (m[0] === 'admin') {
      if (!S.admin) { html = notFound(); }
      else {
        await loadAdminData();
        if (m[1] === 'hh') html = viewAdminHousehold(m[2]);
        else if (m[1] === 'master') html = viewAdminMaster();
        else html = viewAdmin();
      }
    } else if (m[0] === 'cat') html = viewCategory(Number(m[1]));
    else if (m[0] === 'item') html = viewItem(Number(m[1]));
    else if (m[0] === 'account') html = viewAccount();
    else if (m[0] === 'privacy' || m[0] === 'terms') html = viewLegal(m[0]);
    else if (m[0] === 'login' || m[0] === 'signup' || m[0] === '') html = viewDashboard();
    else html = notFound();
  } catch (e) { html = shell('<div class="err">' + esc(friendly(e)) + '</div>', 'home'); }
  $app.innerHTML = html;
  if (window.__keepScroll) { window.scrollTo(0, y); window.__keepScroll = false; } else window.scrollTo(0, 0);
}
function rerender() { window.__keepScroll = true; route(); }

/* ---------- writes ---------- */
async function saveRow(itemId, patch) {
  const prev = S.hi.get(itemId);
  const next = Object.assign({ household_id: S.hh.id, item_id: itemId, weeks_stocked: 0, done: false, portable_done: false, notes: null }, prev || {}, patch);
  S.hi.set(itemId, next);
  rerender();
  const payload = Object.assign({ household_id: S.hh.id, item_id: itemId }, patch);
  const { error } = await sb.from('household_items').upsert(payload, { onConflict: 'household_id,item_id' });
  if (error) { toast('Could not save. Please try again.'); if (prev) S.hi.set(itemId, prev); else S.hi.delete(itemId); rerender(); }
}

/* ---------- master-list dialogs ---------- */
const dlg = document.getElementById('dlg');
function openDlg(html) { dlg.innerHTML = html; if (!dlg.open) dlg.showModal(); }
function closeDlg() { if (dlg.open) dlg.close(); }
function itemForm(it, catId) {
  const cats = S.all.cats;
  const v = it || { category_id: catId, group_title: '', name: '', notes: '', recommended_weeks: null, is_optional: false, at_home: true, portable: 'none', target_quantity: '', liters_per_person_per_day: null, default_shelf_life_years: null, active: true };
  return '<form id="itemform" data-id="' + (it ? it.id : '') + '" class="stack" novalidate><h2>' + (it ? 'Edit item' : 'Add item') + '</h2><div id="dmsg"></div>' +
    '<div class="field"><label for="f_cat">Category</label><select id="f_cat">' + cats.map((c) => '<option value="' + c.id + '"' + (c.id === v.category_id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="f_name">Name</label><input id="f_name" type="text" maxlength="120" value="' + esc(v.name) + '"></div>' +
    '<div class="field"><label for="f_grp">Group heading (optional)</label><input id="f_grp" type="text" maxlength="120" value="' + esc(v.group_title || '') + '"></div>' +
    '<div class="field"><label for="f_notes">Instructions / notes</label><textarea id="f_notes" maxlength="1000">' + esc(v.notes || '') + '</textarea></div>' +
    '<div class="field"><label for="f_wk">Recommended weeks (1–10, blank = simple checkbox)</label><input id="f_wk" type="number" min="1" max="10" value="' + (v.recommended_weeks || '') + '"></div>' +
    '<div class="field"><label for="f_tq">Target quantity (text, optional)</label><input id="f_tq" type="text" maxlength="60" value="' + esc(v.target_quantity || '') + '"></div>' +
    '<div class="field"><label for="f_lt">Litres per person per day (water only)</label><input id="f_lt" type="number" step="0.5" min="0" value="' + (v.liters_per_person_per_day || '') + '"></div>' +
    '<div class="field"><label for="f_sl">Suggested shelf life in years (optional)</label><input id="f_sl" type="number" min="1" max="100" value="' + (v.default_shelf_life_years || '') + '"></div>' +
    '<div class="field"><label for="f_pt">Portable kit</label><select id="f_pt"><option value="none"' + (v.portable === 'none' ? ' selected' : '') + '>Not in kit</option><option value="small"' + (v.portable === 'small' ? ' selected' : '') + '>Small amount in kit</option><option value="full"' + (v.portable === 'full' ? ' selected' : '') + '>Portable kit item</option></select></div>' +
    '<div class="row"><label style="margin:0;display:flex;gap:8px;align-items:center"><input id="f_home" type="checkbox"' + (v.at_home ? ' checked' : '') + '> At home</label><label style="margin:0;display:flex;gap:8px;align-items:center"><input id="f_opt" type="checkbox"' + (v.is_optional ? ' checked' : '') + '> Optional</label><label style="margin:0;display:flex;gap:8px;align-items:center"><input id="f_act" type="checkbox"' + (v.active ? ' checked' : '') + '> Shown to everyone</label></div>' +
    '<div class="row"><button class="btn" type="submit">Save</button><button class="btn line" type="button" data-action="close-dlg">Cancel</button></div></form>';
}
function catForm(c) {
  const v = c || { name: '', label: '', active: true };
  return '<form id="catform" data-id="' + (c ? c.id : '') + '" class="stack" novalidate><h2>' + (c ? 'Edit category' : 'Add category') + '</h2><div id="dmsg"></div>' +
    '<div class="field"><label for="c_name">Name</label><input id="c_name" type="text" maxlength="80" value="' + esc(v.name) + '"></div>' +
    '<div class="field"><label for="c_label">Label (optional)</label><input id="c_label" type="text" maxlength="60" value="' + esc(v.label || '') + '"></div>' +
    '<label style="display:flex;gap:8px;align-items:center"><input id="c_act" type="checkbox"' + (v.active ? ' checked' : '') + '> Shown to everyone</label>' +
    '<div class="row"><button class="btn" type="submit">Save</button><button class="btn line" type="button" data-action="close-dlg">Cancel</button></div></form>';
}
async function refreshBase() {
  const [c, i] = await Promise.all([sb.from('categories').select('*').eq('active', true).order('sort_order'), sb.from('items').select('*').eq('active', true).order('sort_order')]);
  if (!c.error) S.cats = c.data; if (!i.error) S.items = i.data;
}

/* ---------- events ---------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action;
  try {
    if (a === 'week') {
      const id = Number(el.dataset.item), n = Number(el.dataset.n);
      const cur = (S.hi.get(id) || {}).weeks_stocked || 0;
      saveRow(id, { weeks_stocked: cur === n ? n - 1 : n });
    } else if (a === 'done') {
      const id = Number(el.dataset.item); saveRow(id, { done: !((S.hi.get(id) || {}).done) });
    } else if (a === 'kit') {
      const id = Number(el.dataset.item); saveRow(id, { portable_done: !((S.hi.get(id) || {}).portable_done) });
    } else if (a === 'filter') { S.filter = el.dataset.f; rerender(); }
    else if (a === 'people') {
      const pc = $('#pc'); const n = Math.max(1, Math.min(50, Number(pc.textContent) + Number(el.dataset.d))); pc.textContent = n;
    } else if (a === 'go') { location.hash = el.dataset.to; }
    else if (a === 'logout') { await sb.auth.signOut(); }
    else if (a === 'batch-used') {
      const b = S.batches.find((x) => x.id === el.dataset.id); const used = !b.used;
      const { error } = await sb.from('purchase_batches').update({ used, used_at: used ? new Date().toISOString() : null }).eq('id', b.id);
      if (error) throw error; b.used = used; rerender();
    } else if (a === 'batch-del') {
      if (!confirm('Delete this purchase?')) return;
      const { error } = await sb.from('purchase_batches').delete().eq('id', el.dataset.id);
      if (error) throw error; S.batches = S.batches.filter((x) => x.id !== el.dataset.id); rerender();
    } else if (a === 'delete-account') {
      const t = prompt('This permanently deletes your account and all your data.\nType DELETE to confirm.');
      if (t !== 'DELETE') return;
      const { error } = await sb.rpc('delete_my_account'); if (error) throw error;
      await sb.auth.signOut(); toast('Your account has been deleted.');
    } else if (a === 'copy-invite') {
      try { await navigator.clipboard.writeText(inviteLink()); toast('Invite link copied'); } catch (_) { prompt('Copy this link:', inviteLink()); }
    } else if (a === 'new-invite') {
      if (!confirm('Replace the invite link? The old link will stop working.')) return;
      const code = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
      const { error } = await sb.from('app_settings').upsert({ key: 'invite_code', value: code }); if (error) throw error;
      S.settings.invite_code = code; toast('New invite link created'); rerender();
    } else if (a === 'toggle-invite') {
      const v = S.settings.invites_enabled === 'true' ? 'false' : 'true';
      const { error } = await sb.from('app_settings').upsert({ key: 'invites_enabled', value: v }); if (error) throw error;
      S.settings.invites_enabled = v; rerender();
    } else if (a === 'backup') {
      const out = { exported_at: new Date().toISOString() };
      for (const t of ['categories', 'items', 'households', 'household_items', 'purchase_batches']) {
        const r = await sb.from(t).select('*'); if (r.error) throw r.error; out[t] = r.data;
      }
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
      link.download = 'everready-backup-' + new Date().toISOString().slice(0, 10) + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000); toast('Backup downloaded');
    } else if (a === 'admin-pw') {
      const h = S.all.households.find((x) => x.id === el.dataset.id);
      const pw = prompt('New password for ' + h.name + ' (at least 8 characters):'); if (!pw) return;
      const { error } = await sb.rpc('admin_set_password', { target: h.owner_id, new_password: pw }); if (error) throw error;
      toast('Password updated. Tell them in person.');
    } else if (a === 'admin-del') {
      const h = S.all.households.find((x) => x.id === el.dataset.id);
      if (!confirm('Permanently remove "' + h.name + '" and all of its data?')) return;
      const { error } = await sb.rpc('admin_delete_user', { target: h.owner_id }); if (error) throw error;
      toast('Household removed'); location.hash = '#/admin'; route();
    } else if (a === 'edit-item') { openDlg(itemForm(S.all.items.find((x) => x.id === Number(el.dataset.id)))); }
    else if (a === 'add-item') { openDlg(itemForm(null, Number(el.dataset.cat))); }
    else if (a === 'edit-cat') { openDlg(catForm(S.all.cats.find((x) => x.id === Number(el.dataset.id)))); }
    else if (a === 'add-cat') { openDlg(catForm(null)); }
    else if (a === 'close-dlg') { closeDlg(); }
  } catch (err) { toast(friendly(err)); }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; const msg = $('#msg') || $('#dmsg');
  const say = (t, ok) => { if (msg) msg.innerHTML = '<div class="' + (ok ? 'ok' : 'err') + '">' + esc(t) + '</div>'; };
  const btn = f.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (f.id === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#pw').value });
      if (error) throw error;
    } else if (f.id === 'signup') {
      const name = $('#hn').value.trim(); const email = $('#em').value.trim(); const pw = $('#pw').value;
      if (!name) throw new Error('Please enter a household name.');
      if (!email) throw new Error('Please enter your email.');
      if (pw.length < 8) throw new Error('Please choose a password with at least 8 characters.');
      const { data, error } = await sb.auth.signUp({ email, password: pw, options: { data: { household_name: name, people: Number($('#pc').textContent), invite_code: sessionStorage.getItem('er_invite') || '' } } });
      if (error) throw error;
      if (!data.session) throw new Error('Email confirmation is still switched on in Supabase. See the setup guide.');
    } else if (f.id === 'acct') {
      const name = $('#an').value.trim(); if (!name) throw new Error('Please enter a household name.');
      const people = Number($('#pc').textContent);
      const { error } = await sb.from('households').update({ name, people }).eq('id', S.hh.id); if (error) throw error;
      S.hh.name = name; S.hh.people = people; say('Saved.', true);
    } else if (f.id === 'pwform') {
      const pw = $('#np').value; if (pw.length < 8) throw new Error('Please choose a password with at least 8 characters.');
      const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error;
      $('#np').value = ''; say('Password changed.', true);
    } else if (f.id === 'addbatch') {
      const itemId = Number(f.dataset.item);
      const year = Number($('#py').value); if (!(year >= 1980 && year <= 2200)) throw new Error('Please enter a valid year.');
      const sl = $('#ps').value ? Number($('#ps').value) : null;
      const d = $('#pd').value.trim(); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Use the date format 2026-11-14, or leave it blank.');
      const row = { household_id: S.hh.id, item_id: itemId, purchase_year: year, quantity: $('#pq').value.trim() || null, shelf_life_years: sl, exact_date: d || null, note: $('#pn').value.trim() || null };
      const { data, error } = await sb.from('purchase_batches').insert(row).select().single(); if (error) throw error;
      S.batches.push(data); toast('Purchase saved'); rerender();
    } else if (f.id === 'itemform') {
      const name = $('#f_name').value.trim(); if (!name) throw new Error('Please enter a name.');
      const wk = $('#f_wk').value ? Number($('#f_wk').value) : null; if (wk !== null && (wk < 1 || wk > 10)) throw new Error('Weeks must be between 1 and 10.');
      const rec = { category_id: Number($('#f_cat').value), name, group_title: $('#f_grp').value.trim() || null, notes: $('#f_notes').value.trim() || null, recommended_weeks: wk, target_quantity: $('#f_tq').value.trim() || null, liters_per_person_per_day: $('#f_lt').value ? Number($('#f_lt').value) : null, default_shelf_life_years: $('#f_sl').value ? Number($('#f_sl').value) : null, portable: $('#f_pt').value, at_home: $('#f_home').checked, is_optional: $('#f_opt').checked, active: $('#f_act').checked };
      let r;
      if (f.dataset.id) r = await sb.from('items').update(rec).eq('id', Number(f.dataset.id));
      else { rec.sort_order = Math.max(0, ...S.all.items.map((i) => i.sort_order)) + 1; r = await sb.from('items').insert(rec); }
      if (r.error) throw r.error; closeDlg(); await refreshBase(); toast('Saved'); route();
    } else if (f.id === 'catform') {
      const name = $('#c_name').value.trim(); if (!name) throw new Error('Please enter a name.');
      const rec = { name, label: $('#c_label').value.trim() || null, active: $('#c_act').checked };
      let r;
      if (f.dataset.id) r = await sb.from('categories').update(rec).eq('id', Number(f.dataset.id));
      else { rec.sort_order = Math.max(0, ...S.all.cats.map((c) => c.sort_order)) + 1; r = await sb.from('categories').insert(rec); }
      if (r.error) throw r.error; closeDlg(); await refreshBase(); toast('Saved'); route();
    }
  } catch (err) { say(friendly(err)); }
  if (btn) btn.disabled = false;
});

document.addEventListener('focusout', async (e) => {
  const t = e.target;
  if (t.id === 'nt') {
    const id = Number(t.dataset.item); const v = t.value.trim() || null;
    if (((S.hi.get(id) || {}).notes || null) === v) return;
    const prev = S.hi.get(id);
    S.hi.set(id, Object.assign({ household_id: S.hh.id, item_id: id, weeks_stocked: 0, done: false, portable_done: false }, prev || {}, { notes: v }));
    const { error } = await sb.from('household_items').upsert({ household_id: S.hh.id, item_id: id, notes: v }, { onConflict: 'household_id,item_id' });
    if (error) toast('Could not save your note.'); else toast('Note saved');
  }
});

window.addEventListener('hashchange', route);

/* ---------- boot ---------- */
(function captureInvite() {
  const p = new URLSearchParams(location.search).get('invite');
  if (p) { sessionStorage.setItem('er_invite', p); history.replaceState(null, '', location.pathname + '#/signup'); }
})();

let booting = false;
async function onSession(session) {
  if (!session) { S.user = null; S.loaded = false; S.hh = null; S.admin = false; if (!/^#\/(signup|login)/.test(location.hash)) location.hash = sessionStorage.getItem('er_invite') ? '#/signup' : '#/login'; route(); return; }
  if (booting || (S.user && S.user.id === session.user.id && S.loaded)) return;
  booting = true; S.user = session.user;
  $app.innerHTML = '<p class="boot">Loading your household…</p>';
  try { await loadAll(); if (/^#\/(signup|login)/.test(location.hash)) location.hash = '#/'; route(); }
  catch (err) { $app.innerHTML = '<div class="auth"><div class="err">' + esc(friendly(err)) + '</div><button class="btn line" data-action="logout">Log out</button></div>'; }
  booting = false;
}
sb.auth.onAuthStateChange((_evt, session) => { setTimeout(() => onSession(session), 0); });
sb.auth.getSession().then(({ data }) => onSession(data.session));
