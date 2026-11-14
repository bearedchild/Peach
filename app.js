import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { toCents, fmtCad } from './lib/money.js';
import { todayLocal, formatRange } from './lib/dates.js';
import { DEFAULT_FUNDS } from './lib/chanda.js';
import { DEFAULT_RULES } from './lib/reimbursement.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById('app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPES = { chequing: 'Chequing', savings: 'Savings', credit_card: 'Credit card', cash: 'Cash' };
const GROUP_ORDER = ['chequing', 'savings', 'credit_card', 'cash'];   // accounts sort themselves into these sections
const GROUP_LABELS = { chequing: 'Chequing', savings: 'Savings', credit_card: 'Credit cards', cash: 'Cash' };
const KINDS = { expense: 'Expense', savings: 'Savings', rent: 'Rent (funded by rent funding)', chanda: 'Chanda' };
const BUDGET_LABELS = { communications: 'Communications', fuel: 'Car fuel' };
const TABLES = ['settings', 'allowance_schedule', 'reimbursement_rules', 'accounts', 'categories', 'budget_plans', 'claims',
  'transactions', 'transaction_lines', 'recurring_templates', 'chanda_funds', 'chanda_cycle_setup', 'chanda_payments'];

const state = { session: null, view: 'accounts', accounts: [], categories: [], settings: null, allowance: [], rules: [], loadError: null };

// ---------- helpers ----------
let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isError ? 5000 : 2500);
}
async function must(q) {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data;
}
const centsToInput = (c) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
const nextSort = (rows) => (rows.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) || 0) + 10;

function openForm({ title, body, submitLabel = 'Save', onSubmit, onOpen }) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog" class="stack"><h2>${esc(title)}</h2>${body}
    <div class="err" role="alert"></div>
    <div class="row"><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">${esc(submitLabel)}</button></div></form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const err = dlg.querySelector('.err');
  dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('.primary');
    btn.disabled = true;
    try { await onSubmit(Object.fromEntries(new FormData(form)), form); dlg.close(); }
    catch (ex) { err.textContent = ex.message || String(ex); btn.disabled = false; }
  });
  dlg.showModal();
  onOpen?.(dlg);
}

// ---------- data ----------
async function loadAll() {
  const [accounts, categories, settings, allowance, rules] = await Promise.all([
    must(sb.from('accounts').select('*').order('sort_order').order('name')),
    must(sb.from('categories').select('*').order('sort_order').order('name')),
    must(sb.from('settings').select('*').maybeSingle()),
    must(sb.from('allowance_schedule').select('*').order('effective_from', { ascending: false })),
    must(sb.from('reimbursement_rules').select('*').order('effective_from', { ascending: false })),
  ]);
  Object.assign(state, { accounts, categories, settings, allowance, rules, loadError: null });
}

// First-run defaults. Each table is seeded only if it is empty, so this is safe to retry.
async function ensureSeed() {
  let changed = false;
  if (!state.settings) { await must(sb.from('settings').insert({})); changed = true; }
  if (!state.categories.length) {
    const top = ['Groceries', 'Eating out', 'Phone', 'Internet', 'Subscriptions', 'Entertainment', 'Car fuel', 'Rent', 'Chanda', 'General savings', 'Other'];
    const kinds = { Rent: 'rent', Chanda: 'chanda', 'General savings': 'savings' };
    const parents = await must(sb.from('categories').insert(top.map((name, i) => ({ name, kind: kinds[name] ?? 'expense', sort_order: (i + 1) * 10 }))).select());
    const chandaId = parents.find((p) => p.name === 'Chanda').id;
    await must(sb.from('categories').insert(DEFAULT_FUNDS.map((f, i) => ({ name: f.name, parent_id: chandaId, kind: 'chanda', sort_order: (i + 1) * 10 }))));
    changed = true;
  }
  if (!state.rules.length) {
    await must(sb.from('reimbursement_rules').insert(Object.entries(DEFAULT_RULES.budgets).map(([k, b]) => ({ budget_key: k, cap_cents: b.capCents, effective_from: '2026-12-01' }))));
    changed = true;
  }
  if (!state.allowance.length) {
    await must(sb.from('allowance_schedule').insert({ effective_from: '2026-12-01', amount_cents: 60000 }));
    changed = true;
  }
  const funds = await must(sb.from('chanda_funds').select('id').limit(1));
  if (!funds.length) {
    await must(sb.from('chanda_funds').insert(DEFAULT_FUNDS.map((f, i) => ({
      name: f.name, kind: f.kind, percent_bps: f.percentBps ?? null, annual_cents: f.annualCents ?? null,
      cycle_start_month: f.cycleStartMonth, sort_order: (i + 1) * 10 }))));
    changed = true;
  }
  if (changed) await loadAll();
}

async function refresh() {
  try { await loadAll(); await ensureSeed(); } catch (e) { state.loadError = e.message; }
  render();
}

async function reorder(table, siblings, id, dir) {
  const list = [...siblings].sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
  const i = list.findIndex((x) => x.id === id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await Promise.all(list.map((x, k) => must(sb.from(table).update({ sort_order: (k + 1) * 10 }).eq('id', x.id))));
}

// ---------- views ----------
function viewAccounts() {
  const active = state.accounts.filter((a) => !a.archived_at);
  const archived = state.accounts.filter((a) => a.archived_at);
  const bySort = (a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name);
  const groups = GROUP_ORDER.map((t) => [t, active.filter((a) => a.type === t).sort(bySort)]).filter(([, l]) => l.length);
  const card = (a, i, list) => {
    const cc = a.type === 'credit_card';
    const bal = cc
      ? (a.opening_balance_cents <= 0 ? `Owed at start: ${fmtCad(-a.opening_balance_cents)}` : `Credit at start: ${fmtCad(a.opening_balance_cents)}`)
      : `Opening balance: ${fmtCad(a.opening_balance_cents)}`;
    return `<div class="card ${a.archived_at ? 'archived' : ''}">
      <div class="row"><div><h3>${esc(a.name)}${a.nickname ? ` <span class="muted">· ${esc(a.nickname)}</span>` : ''}${a.last4 ? ` <span class="muted">••${esc(a.last4)}</span>` : ''}</h3>
      <div class="small muted">${TYPES[a.type]} · ${bal} on ${esc(a.opening_date)}</div></div>
      ${a.archived_at ? '<span class="badge">Archived</span>' : ''}</div>
      <div class="actions">
        <button class="small" data-act="edit-account" data-id="${a.id}">Edit</button>
        ${a.archived_at
          ? `<button class="small" data-act="restore-account" data-id="${a.id}">Restore</button>`
          : `<button class="small" data-act="move-account" data-id="${a.id}" data-dir="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
             <button class="small" data-act="move-account" data-id="${a.id}" data-dir="down" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
             <button class="small danger" data-act="archive-account" data-id="${a.id}">Archive</button>`}
      </div></div>`;
  };
  return `<div class="wrap"><div class="page-head"><h1>Accounts</h1><button class="primary" data-act="add-account">+ Add account</button></div>
    <div class="note">Accounts group themselves by type. Use ↑ ↓ to put your most-used first within each group. Live balances appear once transactions exist (next stage). Never enter full account numbers: the last four digits are optional.</div>
    ${groups.length ? groups.map(([t, list]) => `<h2 class="group-h">${GROUP_LABELS[t]} <span class="muted small">(${list.length})</span></h2>${list.map((a, i) => card(a, i, list)).join('')}`).join('')
      : '<p class="muted">No accounts yet. Add your chequing, savings, cards and cash.</p>'}
    ${archived.length ? `<h2 style="margin:1.25rem 0 .6rem">Archived</h2>${archived.map(card).join('')}` : ''}</div>`;
}

function viewCategories() {
  const tops = state.categories.filter((c) => !c.parent_id && !c.archived_at);
  const kids = (id) => state.categories.filter((c) => c.parent_id === id && !c.archived_at);
  const archived = state.categories.filter((c) => c.archived_at);
  const item = (c, siblings, i, isChild) => `<div class="card ${isChild ? '' : ''}">
    <div class="row"><h3>${esc(c.name)}</h3>${c.kind !== 'expense' ? `<span class="badge">${esc(KINDS[c.kind] ?? c.kind)}</span>` : ''}</div>
    <div class="actions">
      <button class="small" data-act="edit-category" data-id="${c.id}">Rename</button>
      ${isChild ? '' : `<button class="small" data-act="add-category" data-parent="${c.id}">+ Sub-category</button>`}
      <button class="small" data-act="move-category" data-id="${c.id}" data-dir="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="small" data-act="move-category" data-id="${c.id}" data-dir="down" ${i === siblings.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="small danger" data-act="archive-category" data-id="${c.id}">Archive</button></div></div>`;
  return `<div class="wrap"><div class="page-head"><h1>Categories</h1><button class="primary" data-act="add-category">+ Add category</button></div>
    <div class="note">Categories are separate from reimbursement eligibility. A streaming subscription can sit under Subscriptions and still be flagged as a Communications expense when you add it as a transaction.</div>
    ${tops.map((c, i) => `${item(c, tops, i, false)}${kids(c.id).length ? `<div class="sub">${kids(c.id).map((k, j, arr) => item(k, arr, j, true)).join('')}</div>` : ''}`).join('')}
    ${archived.length ? `<h2 style="margin:1.25rem 0 .6rem">Archived</h2>${archived.map((c) => `<div class="card archived"><div class="row"><h3>${esc(c.name)}</h3>
      <button class="small" data-act="restore-category" data-id="${c.id}">Restore</button></div></div>`).join('')}` : ''}</div>`;
}

function viewSettings() {
  const s = state.settings;
  if (!s) return '<div class="wrap"><p class="muted">Settings not loaded.</p></div>';
  const periodExample = formatRange('2026-11-21', '2026-12-20').replace(/ \d{4}$/, '');
  const sd = s.period_start_day;
  const rows = state.rules;
  const latest = (k) => rows.find((r) => r.budget_key === k);
  return `<div class="wrap"><div class="page-head"><h1>Settings</h1></div>

    <div class="card"><h2>Start date</h2>
      <p class="small muted">Tracking begins on this date. Opening balances and opening claims are entered as of it.</p>
      <form data-form="tracking" class="stack"><div class="field"><label>Tracking start date</label><input type="date" name="tracking_start" value="${esc(s.tracking_start)}" required></div>
      <button class="primary" type="submit">Save start date</button></form></div>

    <div class="card"><h2>Allowance</h2>
      <p class="small muted">Effective-dated. Adding a new amount never rewrites earlier months.</p>
      ${state.allowance.map((a) => `<div class="row" style="padding:.4rem 0;border-bottom:1px solid var(--line)"><div><span class="amount">${fmtCad(a.amount_cents)}</span> <span class="muted small">per month, from ${esc(a.effective_from)}</span></div>
        <button class="small danger" data-act="delete-allowance" data-id="${a.id}">Delete</button></div>`).join('') || '<p class="muted">None yet.</p>'}
      <form data-form="allowance" class="stack" style="margin-top:.9rem"><div class="grid2">
        <div class="field"><label>New monthly amount (CAD)</label><input name="amount" inputmode="decimal" placeholder="600.00" required></div>
        <div class="field"><label>Effective from</label><input type="date" name="effective_from" value="${todayLocal()}" required></div></div>
      <button class="primary" type="submit">Add allowance amount</button></form></div>

    <div class="card"><h2>Reimbursement periods and caps</h2>
      <p class="small muted">Work expense period runs the ${sd}${sd === 21 ? 'st' : 'th'} through the day before, e.g. ${esc(periodExample)}. Personal budgets still use calendar months.</p>
      <form data-form="rules" class="stack"><div class="grid2">
        <div class="field"><label>Period starts on day (1–28)</label><input type="number" name="period_start_day" min="1" max="28" value="${sd}" required></div>
        <div class="field"><label>Reimbursed on day (1–28)</label><input type="number" name="reimbursement_pay_day" min="1" max="28" value="${s.reimbursement_pay_day}" required></div></div>
        <div class="field"><label>Warn when a category reaches (% of plan)</label><input type="number" name="warn_at_percent" min="1" max="100" value="${s.warn_at_percent}" required></div>
        <label style="display:flex;gap:.5rem;align-items:center;color:var(--text)"><input type="checkbox" name="carry_over_unused" ${s.carry_over_unused ? 'checked' : ''}> Carry unused reimbursement cap into the next period (off = it expires)</label>
        <button class="primary" type="submit">Save period rules</button></form>
      <hr style="border:0;border-top:1px solid var(--line);margin:1rem 0">
      <form data-form="caps" class="stack"><div class="grid2">
        <div class="field"><label>Communications cap per period</label><input name="communications" inputmode="decimal" value="${latest('communications') ? centsToInput(latest('communications').cap_cents) : ''}" required></div>
        <div class="field"><label>Car fuel cap per period</label><input name="fuel" inputmode="decimal" value="${latest('fuel') ? centsToInput(latest('fuel').cap_cents) : ''}" required></div></div>
        <div class="field"><label>Effective from</label><input type="date" name="effective_from" value="${esc(s.tracking_start)}" required></div>
        <button class="primary" type="submit">Save caps</button></form>
      <p class="small muted" style="margin-top:.75rem">${rows.map((r) => `${BUDGET_LABELS[r.budget_key]}: ${fmtCad(r.cap_cents)} from ${esc(r.effective_from)}`).join(' · ')}</p></div>

    <div class="card"><h2>Your data</h2>
      <p class="small muted">Free Supabase projects have no automatic backups. Download an export regularly (monthly is a good habit) and keep it somewhere safe. It contains your financial records.</p>
      <div class="actions"><button data-act="export">Download all data (JSON)</button></div></div>

    <div class="card"><h2>Account</h2><p class="small muted">Signed in as ${esc(state.session?.user?.email)}</p>
      <div class="actions"><button data-act="sign-out">Sign out</button></div></div></div>`;
}

const VIEWS = { accounts: viewAccounts, categories: viewCategories, settings: viewSettings };
const NAV = [['accounts', 'Accounts', '◉'], ['categories', 'Categories', '❖'], ['settings', 'Settings', '⚙']];

function renderLogin(message = '') {
  app.innerHTML = `<div class="login"><h1>Peach</h1><p class="muted">Sign in to continue.</p>
    <form id="login" class="stack">
      <div class="field"><label for="em">Email</label><input id="em" type="email" name="email" autocomplete="username" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="current-password" required></div>
      <div class="err" role="alert">${esc(message)}</div>
      <button class="primary" type="submit">Sign in</button></form></div>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button'); btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
    if (error) renderLogin(error.message === 'Invalid login credentials' ? 'Email or password is not right.' : error.message);
  });
}

function render() {
  if (!state.session) return renderLogin();
  if (state.loadError) {
    app.innerHTML = `<div class="login"><h1>Could not load</h1><p class="err">${esc(state.loadError)}</p><button class="primary" data-act="retry">Try again</button></div>`;
    return;
  }
  const view = VIEWS[state.view] ? state.view : 'accounts';
  app.innerHTML = `<div class="shell"><nav class="nav" aria-label="Main"><div class="brand">Peach</div>
    ${NAV.map(([k, label, ico]) => `<a href="#${k}" ${k === view ? 'aria-current="page"' : ''}><span class="ico" aria-hidden="true">${ico}</span>${label}</a>`).join('')}</nav>
    <main>${VIEWS[view]()}</main></div>`;
}

// ---------- actions ----------
function accountForm(a) {
  const types = Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${a?.type === k ? 'selected' : ''}>${v}</option>`).join('');
  const entered = a ? (a.type === 'credit_card' ? -a.opening_balance_cents : a.opening_balance_cents) : 0;
  return `<div class="field"><label>Name</label><input name="name" required value="${esc(a?.name)}" placeholder="e.g. RBC Visa"></div>
    <div class="grid2"><div class="field"><label>Type</label><select name="type">${types}</select></div>
    <div class="field"><label>Nickname (optional)</label><input name="nickname" value="${esc(a?.nickname)}"></div></div>
    <div class="grid2"><div class="field"><label>Last 4 digits (optional)</label><input name="last4" inputmode="numeric" maxlength="4" pattern="[0-9]{0,4}" value="${esc(a?.last4)}"></div>
    <div class="field"><label>Opening date</label><input type="date" name="opening_date" required value="${esc(a?.opening_date ?? state.settings?.tracking_start ?? todayLocal())}"></div></div>
    <div class="field"><label id="balLabel">Opening balance</label><input name="opening" inputmode="decimal" value="${centsToInput(entered)}"></div>`;
}
function wireBalanceLabel(dlg) {
  const sel = dlg.querySelector('[name=type]'), lab = dlg.querySelector('#balLabel');
  const upd = () => { lab.textContent = sel.value === 'credit_card' ? 'Amount owed on this card at the opening date (positive number)' : 'Balance at the opening date'; };
  sel.addEventListener('change', upd); upd();
}
function accountRow(f) {
  const name = f.name.trim();
  if (!name) throw new Error('Name is required');
  const last4 = (f.last4 ?? '').trim();
  if (last4 && !/^\d{1,4}$/.test(last4)) throw new Error('Last digits: numbers only, up to 4. Never enter a full account number.');
  let cents = toCents(f.opening || '0');
  if (f.type === 'credit_card') cents = -cents;
  return { name, nickname: (f.nickname ?? '').trim() || null, last4: last4 || null, type: f.type, opening_balance_cents: cents, opening_date: f.opening_date };
}

const byId = (list, id) => list.find((x) => x.id === id);
const handlers = {
  retry: () => refresh(),
  'sign-out': async () => { await sb.auth.signOut(); },
  'add-account': () => openForm({ title: 'Add account', body: accountForm(null), submitLabel: 'Add', onOpen: wireBalanceLabel,
    onSubmit: async (f) => { await must(sb.from('accounts').insert({ ...accountRow(f), sort_order: nextSort(state.accounts) })); await refresh(); toast('Account added'); } }),
  'edit-account': ({ id }) => { const a = byId(state.accounts, id); openForm({ title: 'Edit account', body: accountForm(a), onOpen: wireBalanceLabel,
    onSubmit: async (f) => { await must(sb.from('accounts').update(accountRow(f)).eq('id', id)); await refresh(); toast('Saved'); } }); },
  'archive-account': async ({ id }) => {
    if (!confirm('Archive this account? Its history is kept and you can restore it any time.')) return;
    try { await must(sb.from('accounts').update({ archived_at: new Date().toISOString() }).eq('id', id)); await refresh(); toast('Archived'); } catch (e) { toast(e.message, true); } },
  'restore-account': async ({ id }) => { try { await must(sb.from('accounts').update({ archived_at: null }).eq('id', id)); await refresh(); } catch (e) { toast(e.message, true); } },
  'move-account': async ({ id, dir }) => {
    const a = byId(state.accounts, id); // reorder only among active accounts of the same type
    try { await reorder('accounts', state.accounts.filter((x) => !x.archived_at && x.type === a.type), id, dir); await refresh(); } catch (e) { toast(e.message, true); } },

  'add-category': ({ parent }) => {
    const tops = state.categories.filter((c) => !c.parent_id && !c.archived_at);
    openForm({ title: parent ? 'Add sub-category' : 'Add category', submitLabel: 'Add',
      body: `<div class="field"><label>Name</label><input name="name" required></div>
        <div class="field"><label>Parent</label><select name="parent_id"><option value="">None (top level)</option>${tops.map((t) => `<option value="${t.id}" ${t.id === parent ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Type (top level only)</label><select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>`,
      onSubmit: async (f) => {
        const name = f.name.trim(); if (!name) throw new Error('Name is required');
        const parentRow = f.parent_id ? byId(state.categories, f.parent_id) : null;
        const sibs = state.categories.filter((c) => (c.parent_id ?? null) === (f.parent_id || null));
        await must(sb.from('categories').insert({ name, parent_id: f.parent_id || null, kind: parentRow ? parentRow.kind : f.kind, sort_order: nextSort(sibs) }));
        await refresh(); toast('Category added'); } });
  },
  'edit-category': ({ id }) => { const c = byId(state.categories, id);
    openForm({ title: 'Rename category', body: `<div class="field"><label>Name</label><input name="name" required value="${esc(c.name)}"></div>`,
      onSubmit: async (f) => { const name = f.name.trim(); if (!name) throw new Error('Name is required');
        await must(sb.from('categories').update({ name }).eq('id', id)); await refresh(); toast('Saved'); } }); },
  'archive-category': async ({ id }) => {
    const kids = state.categories.filter((c) => c.parent_id === id && !c.archived_at);
    if (!confirm(`Archive this category${kids.length ? ` and its ${kids.length} sub-categories` : ''}? Past transactions keep it.`)) return;
    try { const now = new Date().toISOString();
      await must(sb.from('categories').update({ archived_at: now }).in('id', [id, ...kids.map((k) => k.id)])); await refresh(); toast('Archived'); } catch (e) { toast(e.message, true); } },
  'restore-category': async ({ id }) => { try { await must(sb.from('categories').update({ archived_at: null }).eq('id', id)); await refresh(); } catch (e) { toast(e.message, true); } },
  'move-category': async ({ id, dir }) => {
    const c = byId(state.categories, id);
    const sibs = state.categories.filter((x) => (x.parent_id ?? null) === (c.parent_id ?? null) && !x.archived_at);
    try { await reorder('categories', sibs, id, dir); await refresh(); } catch (e) { toast(e.message, true); } },

  'delete-allowance': async ({ id }) => {
    if (state.allowance.length <= 1) return toast('Keep at least one allowance amount.', true);
    if (!confirm('Delete this allowance entry? Chanda calculations for those months will use the previous amount.')) return;
    try { await must(sb.from('allowance_schedule').delete().eq('id', id)); await refresh(); } catch (e) { toast(e.message, true); } },
  export: async () => {
    try {
      const out = { exported_at: new Date().toISOString(), currency: 'CAD', note: 'Amounts are integer cents.' };
      for (const t of TABLES) out[t] = await must(sb.from(t).select('*'));
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `budget-export-${todayLocal()}.json`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Export downloaded');
    } catch (e) { toast(e.message, true); }
  },
};

const forms = {
  tracking: async (f) => { await must(sb.from('settings').update({ tracking_start: f.tracking_start, updated_at: new Date().toISOString() }).eq('user_id', state.session.user.id)); },
  allowance: async (f) => {
    const cents = toCents(f.amount); if (cents < 0) throw new Error('Amount cannot be negative');
    await must(sb.from('allowance_schedule').upsert({ effective_from: f.effective_from, amount_cents: cents }, { onConflict: 'user_id,effective_from' })); },
  rules: async (f, form) => {
    const sd = parseInt(f.period_start_day, 10), pd = parseInt(f.reimbursement_pay_day, 10), wp = parseInt(f.warn_at_percent, 10);
    if (!(sd >= 1 && sd <= 28 && pd >= 1 && pd <= 28 && wp >= 1 && wp <= 100)) throw new Error('Check the numbers: days 1–28, warning 1–100');
    await must(sb.from('settings').update({ period_start_day: sd, reimbursement_pay_day: pd, warn_at_percent: wp,
      carry_over_unused: form.elements.carry_over_unused.checked, updated_at: new Date().toISOString() }).eq('user_id', state.session.user.id)); },
  caps: async (f) => {
    const rows = ['communications', 'fuel'].map((k) => ({ budget_key: k, cap_cents: toCents(f[k]), effective_from: f.effective_from }));
    if (rows.some((r) => r.cap_cents < 0)) throw new Error('Caps cannot be negative');
    await must(sb.from('reimbursement_rules').upsert(rows, { onConflict: 'user_id,budget_key,effective_from' })); },
};

app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && handlers[b.dataset.act]) handlers[b.dataset.act](b.dataset);
});
app.addEventListener('submit', async (e) => {
  const name = e.target.dataset?.form;
  if (!name || !forms[name]) return;
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  try { await forms[name](Object.fromEntries(new FormData(e.target)), e.target); await refresh(); toast('Saved'); }
  catch (ex) { toast(ex.message || String(ex), true); }
  btn.disabled = false;
});

function route() { state.view = (location.hash || '#accounts').slice(1); render(); window.scrollTo(0, 0); }
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.session && !document.querySelector('dialog[open]')) refresh(); // pick up changes from other devices
});

(async function boot() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  sb.auth.onAuthStateChange((_evt, session) => {
    const was = !!state.session;
    state.session = session;
    if (!!session !== was) { session ? (route(), refresh()) : render(); }
  });
  state.view = (location.hash || '#accounts').slice(1);
  if (state.session) await refresh(); else render();
})();
