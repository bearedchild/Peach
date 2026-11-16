import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { toCents, fmtCad, sum } from './lib/money.js';
import { todayLocal, formatRange, calendarMonthOf, monthKey, addMonthsKey, parseDate, nextDueDate } from './lib/dates.js';
import { DEFAULT_FUNDS, allowanceOn } from './lib/chanda.js';
import { DEFAULT_RULES, summarizePeriod } from './lib/reimbursement.js';
import { personalSpendByCategory, reimbursableByLine, categoryStatus, rentEarmark } from './lib/budget.js';
import { accountBalances } from './lib/accounts.js';
import { dueReminders, dueLabel, buildCardIcs } from './lib/cards.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById('app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GROUP_ORDER = ['chequing', 'savings', 'credit_card', 'cash'];
const GROUP_LABELS = { chequing: 'Chequing', savings: 'Savings', credit_card: 'Credit cards', cash: 'Cash' };
const TYPES = { chequing: 'Chequing', savings: 'Savings', credit_card: 'Credit card', cash: 'Cash' };
const KINDS = { expense: 'Expense', savings: 'Savings', rent: 'Rent (funded by rent funding)', chanda: 'Chanda' };
const BUDGET_LABELS = { communications: 'Communications', fuel: 'Car fuel', petty_cash: 'Petty cash' };
const INCOME_LABELS = { allowance: 'Allowance', rent_funding: 'Rent funding', reimbursement: 'Reimbursement received', other: 'Other income' };
const TABLES = ['settings', 'allowance_schedule', 'reimbursement_rules', 'accounts', 'categories', 'budget_plans', 'claims',
  'transactions', 'transaction_lines', 'recurring_templates', 'chanda_funds', 'chanda_cycle_setup', 'chanda_payments'];

const state = { session: null, view: 'home', month: null, accounts: [], categories: [], settings: null, allowance: [], rules: [],
  txns: [], lines: [], loadError: null };

// ---------- helpers ----------
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: fine */ } };
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
const bySort = (a, b) => ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || String(a.name).localeCompare(String(b.name));
const byId = (list, id) => list.find((x) => x.id === id);
const activeAccounts = () => state.accounts.filter((a) => !a.archived_at);
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th'}`;
function checkDate(s) { parseDate(s); return s; }
function positiveCents(input, label) {
  const c = toCents(input || '0');
  if (c <= 0) throw new Error(`${label} must be more than $0.00`);
  return c;
}

function openForm({ title, intro = '', body, submitLabel = 'Save', onSubmit, onOpen }) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog" class="stack"><h2>${esc(title)}</h2>${intro ? `<p class="small muted" style="margin:0">${intro}</p>` : ''}${body}
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
  const [accounts, categories, settings, allowance, rules, txns, lines] = await Promise.all([
    must(sb.from('accounts').select('*').order('sort_order').order('name')),
    must(sb.from('categories').select('*').order('sort_order').order('name')),
    must(sb.from('settings').select('*').maybeSingle()),
    must(sb.from('allowance_schedule').select('*').order('effective_from', { ascending: false })),
    must(sb.from('reimbursement_rules').select('*').order('effective_from', { ascending: false })),
    must(sb.from('transactions').select('*').order('date', { ascending: false }).order('created_at', { ascending: false })),
    must(sb.from('transaction_lines').select('*')),
  ]);
  Object.assign(state, { accounts, categories, settings, allowance, rules, txns, lines, loadError: null });
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
  const list = [...siblings].sort(bySort);
  const i = list.findIndex((x) => x.id === id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await Promise.all(list.map((x, k) => must(sb.from(table).update({ sort_order: (k + 1) * 10 }).eq('id', x.id))));
}

// ---------- derived numbers (all from the tested logic modules) ----------
function rulesFromState(today) {
  const s = state.settings ?? {};
  const cap = (k) => (state.rules.filter((r) => r.budget_key === k && r.effective_from <= today).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]?.cap_cents
    ?? DEFAULT_RULES.budgets[k].capCents);
  return { startDay: s.period_start_day ?? 21, payDay: s.reimbursement_pay_day ?? 1, carryOverUnused: !!s.carry_over_unused,
    budgets: { communications: { label: 'Communications', capCents: cap('communications') }, fuel: { label: 'Car fuel', capCents: cap('fuel') },
      petty_cash: { label: 'Petty cash', capCents: null } } };
}
function expenseLines() {
  const txById = new Map(state.txns.map((t) => [t.id, t]));
  return state.lines.filter((l) => txById.get(l.transaction_id)?.kind === 'expense').map((l) => ({
    id: l.id, txnId: l.transaction_id, date: txById.get(l.transaction_id).date, amountCents: l.amount_cents, categoryId: l.category_id,
    budget: l.reimb_budget ?? undefined, eligible: !!l.reimb_eligible,
    exception: l.work_trip_exception ? { approved: true, reimbursableCents: l.exception_reimbursable_cents ?? 0, note: l.exception_note } : undefined,
  }));
}
const mapAccounts = () => state.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, openingBalanceCents: a.opening_balance_cents,
  archivedAt: a.archived_at, dueDay: a.due_day, minPaymentCents: a.min_payment_cents, remindDays: a.remind_days }));
const mapTxns = () => state.txns.map((t) => ({ id: t.id, accountId: t.account_id, date: t.date, amountCents: t.amount_cents, kind: t.kind,
  transferGroupId: t.transfer_group_id, incomeSource: t.income_source }));

function computeHome(today = todayLocal()) {
  const month = calendarMonthOf(today);
  const rules = rulesFromState(today);
  const lines = expenseLines();
  const rentIds = state.categories.filter((c) => c.kind === 'rent').map((c) => c.id);
  const spend = personalSpendByCategory(lines, month.key, rules, { earmarkedCategoryIds: rentIds });
  const inMonth = state.txns.filter((t) => monthKey(t.date) === month.key);
  const allowanceCents = sum(inMonth.filter((t) => t.kind === 'income' && t.income_source === 'allowance').map((t) => t.amount_cents));
  const leftCents = allowanceCents - spend.totalPersonalCents;

  const cur = summarizePeriod(lines, today, rules);
  const dayBefore = (() => { const { y, m, d } = parseDate(cur.period.start); const t = new Date(Date.UTC(y, m - 1, d - 1)); return t.toISOString().slice(0, 10); })();
  const prev = summarizePeriod(lines, dayBefore, rules);
  const awaiting = [];
  if (prev.totalReimbursableCents > 0 && prev.expectedReimbursementDate > today) awaiting.push(prev);
  if (cur.totalReimbursableCents > 0) awaiting.push(cur);

  const fundingReceived = sum(state.txns.filter((t) => t.kind === 'income' && t.income_source === 'rent_funding').map((t) => t.amount_cents));
  const rentCharged = sum(lines.filter((l) => rentIds.includes(l.categoryId)).map((l) => l.amountCents));
  const settled = sum(state.txns.filter((t) => t.kind === 'transfer' && t.is_rent_settlement && t.amount_cents > 0).map((t) => t.amount_cents));
  const rent = rentEarmark({ fundingReceivedCents: fundingReceived, rentChargedToCardCents: rentCharged, settledCents: settled });

  const balances = accountBalances(mapAccounts(), mapTxns());
  const reminders = dueReminders(mapAccounts(), mapTxns(), today);
  return { today, month, spend, allowanceCents, leftCents, awaiting, rent, fundingReceived, balances, reminders, rules };
}

// ---------- views ----------
function stat(label, value, caption, extra = '') {
  return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="small muted">${caption}</div>${extra}</div>`;
}

function viewHome() {
  const h = computeHome();
  const noAccounts = !activeAccounts().length;
  const noIncome = !state.txns.some((t) => t.kind === 'income');
  const noSpend = !state.txns.some((t) => t.kind === 'expense');
  const steps = `<div class="card"><h2>Let's get started</h2><ol class="steps">
      <li class="${noAccounts ? '' : 'done'}"><b>Add your accounts</b> (chequing, savings, credit cards). <a href="#accounts">Go to Accounts</a></li>
      <li class="${noIncome ? '' : 'done'}"><b>Tap “I got paid”</b> when your pay lands on the 1st.</li>
      <li class="${noSpend ? '' : 'done'}"><b>Tap “I spent”</b> each time you buy something.</li></ol></div>`;

  const banners = h.reminders.map((r) => `<div class="banner ${r.level === 'soon' ? 'warn' : 'bad'}" role="alert"><span aria-hidden="true">${r.level === 'soon' ? '◐' : '⚠'}</span>
    <div><b>${esc(r.account.name)}</b>: ${dueLabel(r)} (${esc(r.dueOn)})${r.minCents != null ? ` · minimum ${fmtCad(r.minCents)}` : ''}
    <div class="small">Record the payment with “Pay a card” and this reminder clears.</div></div></div>`).join('');

  const left = h.allowanceCents === 0 && h.spend.totalPersonalCents === 0
    ? stat('Left to spend', '—', 'Tap “I got paid” to start this month')
    : (() => { const st = categoryStatus(h.allowanceCents, h.spend.totalPersonalCents, { warnAt: (state.settings?.warn_at_percent ?? 90) / 100 });
        return stat('Left to spend', `<span class="${st.state}">${st.icon} ${fmtCad(h.leftCents)}</span>`, `${st.label} · allowance minus what you spent`); })();

  const awaitingHtml = h.awaiting.length ? h.awaiting.map((p) => `<div class="small" style="margin-top:.35rem"><b>${fmtCad(p.totalReimbursableCents)}</b> for ${esc(p.period.label)}, expected ${esc(p.expectedReimbursementDate)}</div>`).join('') : '';
  const rentHtml = h.fundingReceived > 0 || h.rent.heldForRentCents > 0
    ? stat('Held for rent', fmtCad(h.rent.heldForRentCents), 'Rent funding is not spendable. It is released when you pay the card that was charged rent.') : '';

  const groups = GROUP_ORDER.map((t) => [t, h.balances.filter((b) => b.type === t)]).filter(([, l]) => l.length);
  const accts = groups.length ? `<div class="card"><h2>Your accounts</h2><div class="small muted" style="margin-bottom:.5rem">Actual balances in each account. This is not the same as money left to spend.</div>
    ${groups.map(([t, l]) => `<h3 class="group-h2">${GROUP_LABELS[t]}</h3>${l.map((b) => `<div class="row line"><span>${esc(b.name)}</span><span class="amount">${b.type === 'credit_card' ? (b.owedCents ? `Owed ${fmtCad(b.owedCents)}` : fmtCad(b.balanceCents)) : fmtCad(b.balanceCents)}</span></div>`).join('')}`).join('')}</div>` : '';

  const recent = state.txns.slice(0, 5);
  const items = displayItems(recent);
  return `<div class="wrap"><div class="page-head"><div><h1>This month</h1><div class="small muted">${esc(h.month.label)}</div></div></div>
    <div class="big-actions">
      <button class="big primary" data-act="add-paid"><span aria-hidden="true">＋</span> I got paid</button>
      <button class="big" data-act="add-spent"><span aria-hidden="true">−</span> I spent</button>
      <button class="big" data-act="add-transfer"><span aria-hidden="true">⇄</span> Pay a card / move money</button></div>
    ${noAccounts || noIncome || noSpend ? steps : ''}
    ${banners}
    <div class="stats">
      ${stat('Allowance received', fmtCad(h.allowanceCents), 'Money you can budget this month')}
      ${stat('You spent', fmtCad(h.spend.totalPersonalCents), 'Your own cost. Reimbursable parts are not counted here.')}
      ${left}
      ${stat('Reimbursement coming', fmtCad(sum(h.awaiting.map((p) => p.totalReimbursableCents))), 'Not cash yet. Do not count it as available.', awaitingHtml)}
      ${rentHtml}</div>
    ${accts}
    <div class="card"><div class="row"><h2>Recent</h2><a href="#activity">See all</a></div>
      ${items.length ? renderItems(items) : '<p class="muted small">Nothing yet.</p>'}</div></div>`;
}

// merge two-row transfers into one display item
function displayItems(txns) {
  const seen = new Set();
  const items = [];
  for (const t of txns) {
    if (t.kind === 'transfer') {
      if (seen.has(t.transfer_group_id)) continue;
      seen.add(t.transfer_group_id);
      const legs = state.txns.filter((x) => x.transfer_group_id === t.transfer_group_id);
      items.push({ type: 'transfer', t: legs.find((l) => l.amount_cents < 0) ?? t, out: legs.find((l) => l.amount_cents < 0), inn: legs.find((l) => l.amount_cents > 0) });
    } else items.push({ type: t.kind, t });
  }
  return items;
}

function renderItems(items) {
  const reimb = reimbursableByLine(expenseLines(), rulesFromState(todayLocal()));
  const lineByTxn = new Map(state.lines.map((l) => [l.transaction_id, l]));
  const acct = (id) => esc(byId(state.accounts, id)?.name ?? 'Unknown account');
  const cat = (id) => esc(byId(state.categories, id)?.name ?? 'Uncategorized');
  let lastDate = '';
  return items.map((it) => {
    const t = it.t;
    let title, sub, amt, cls = '', extra = '';
    if (it.type === 'expense') {
      const l = lineByTxn.get(t.id);
      title = esc(t.payee || byId(state.categories, l?.category_id)?.name || 'Purchase');
      sub = `${cat(l?.category_id)} · ${acct(t.account_id)}`;
      amt = `−${fmtCad(-t.amount_cents)}`;
      const r = reimb[l?.id]?.reimbursableCents ?? 0;
      if (l?.reimb_budget) extra = `<div class="small"><span class="badge">Work: ${BUDGET_LABELS[l.reimb_budget]}</span> ${r > 0 ? `${fmtCad(r)} reimbursable · ${fmtCad(-t.amount_cents - r)} yours` : 'no reimbursement'}</div>`;
    } else if (it.type === 'income') {
      title = INCOME_LABELS[t.income_source] ?? 'Income'; sub = `Into ${acct(t.account_id)}`; amt = `+${fmtCad(t.amount_cents)}`; cls = 'pos';
      if (t.income_source === 'rent_funding') extra = '<div class="small muted">Held for rent, not spendable</div>';
      if (t.income_source === 'reimbursement') extra = '<div class="small muted">Settles a claim, not new spending money</div>';
    } else {
      title = 'Transfer'; sub = `${acct(it.out?.account_id)} → ${acct(it.inn?.account_id)}`; amt = fmtCad(Math.abs(t.amount_cents));
      extra = `<div class="small muted">Not spending${it.out?.is_rent_settlement ? ' · settles rent charge' : ''}</div>`;
    }
    const head = t.date !== lastDate ? `<div class="date-h">${esc(t.date)}</div>` : '';
    lastDate = t.date;
    return `${head}<div class="txn"><div class="grow"><div class="txn-title">${title}</div><div class="small muted">${sub}</div>${extra}</div>
      <div class="txn-side"><div class="amount ${cls}">${amt}</div>
      <div class="txn-actions">${it.type === 'expense' ? `<button class="small" data-act="edit-spent" data-id="${t.id}">Edit</button>` : ''}
      <button class="small danger" data-act="delete-txn" data-id="${t.id}" data-type="${it.type}">Delete</button></div></div></div>`;
  }).join('');
}

function viewActivity() {
  const key = state.month ?? monthKey(todayLocal());
  const list = state.txns.filter((t) => monthKey(t.date) === key);
  const label = calendarMonthOf(`${key}-01`).label;
  const items = displayItems(list);
  return `<div class="wrap"><div class="page-head"><h1>Activity</h1></div>
    <div class="month-nav"><button data-act="month" data-dir="-1" aria-label="Previous month">‹</button><div><b>${esc(label)}</b></div>
      <button data-act="month" data-dir="1" aria-label="Next month">›</button></div>
    <div class="card">${items.length ? renderItems(items) : '<p class="muted">Nothing recorded this month.</p>'}</div></div>`;
}

function dueText(a) {
  if (a.type !== 'credit_card' || !a.due_day) return '';
  return `<div class="small" style="margin-top:.3rem">Due the ${ordinal(a.due_day)}${a.min_payment_cents != null ? ` · minimum ${fmtCad(a.min_payment_cents)}` : ''} · reminds ${a.remind_days} day${a.remind_days === 1 ? '' : 's'} before</div>`;
}

function viewAccounts() {
  const active = activeAccounts();
  const archived = state.accounts.filter((a) => a.archived_at);
  const groups = GROUP_ORDER.map((t) => [t, active.filter((a) => a.type === t).sort(bySort)]).filter(([, l]) => l.length);
  const card = (a, i, list) => {
    const cc = a.type === 'credit_card';
    const bal = cc
      ? (a.opening_balance_cents <= 0 ? `Owed at start: ${fmtCad(-a.opening_balance_cents)}` : `Credit at start: ${fmtCad(a.opening_balance_cents)}`)
      : `Opening balance: ${fmtCad(a.opening_balance_cents)}`;
    return `<div class="card ${a.archived_at ? 'archived' : ''}">
      <div class="row"><div><h3>${esc(a.name)}${a.nickname ? ` <span class="muted">· ${esc(a.nickname)}</span>` : ''}${a.last4 ? ` <span class="muted">••${esc(a.last4)}</span>` : ''}</h3>
      <div class="small muted">${TYPES[a.type]} · ${bal} on ${esc(a.opening_date)}</div>${dueText(a)}</div>
      ${a.archived_at ? '<span class="badge">Archived</span>' : ''}</div>
      <div class="actions">
        <button class="small" data-act="edit-account" data-id="${a.id}">Edit</button>
        ${cc && a.due_day && !a.archived_at ? `<button class="small" data-act="card-calendar" data-id="${a.id}">Add to calendar</button>` : ''}
        ${a.archived_at
          ? `<button class="small" data-act="restore-account" data-id="${a.id}">Restore</button>`
          : `<button class="small" data-act="move-account" data-id="${a.id}" data-dir="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
             <button class="small" data-act="move-account" data-id="${a.id}" data-dir="down" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
             <button class="small danger" data-act="archive-account" data-id="${a.id}">Archive</button>`}
      </div></div>`;
  };
  return `<div class="wrap"><div class="page-head"><h1>Accounts</h1><button class="primary" data-act="add-account">+ Add account</button></div>
    <div class="note">Accounts group themselves by type. Use ↑ ↓ to put your most-used first. For each credit card, set its due day and minimum payment so Peach can remind you. Never enter full account numbers.</div>
    ${groups.length ? groups.map(([t, list]) => `<h2 class="group-h">${GROUP_LABELS[t]} <span class="muted small">(${list.length})</span></h2>${list.map((a, i) => card(a, i, list)).join('')}`).join('')
      : '<p class="muted">No accounts yet. Add your chequing, savings, cards and cash.</p>'}
    ${archived.length ? `<h2 class="group-h">Archived</h2>${archived.map((a) => card(a, 0, [a])).join('')}` : ''}</div>`;
}

function viewCategories() {
  const tops = state.categories.filter((c) => !c.parent_id && !c.archived_at);
  const kids = (id) => state.categories.filter((c) => c.parent_id === id && !c.archived_at);
  const archived = state.categories.filter((c) => c.archived_at);
  const item = (c, siblings, i, isChild) => `<div class="card">
    <div class="row"><h3>${esc(c.name)}</h3>${c.kind !== 'expense' ? `<span class="badge">${esc(KINDS[c.kind] ?? c.kind)}</span>` : ''}</div>
    <div class="actions">
      <button class="small" data-act="edit-category" data-id="${c.id}">Rename</button>
      ${isChild ? '' : `<button class="small" data-act="add-category" data-parent="${c.id}">+ Sub-category</button>`}
      <button class="small" data-act="move-category" data-id="${c.id}" data-dir="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="small" data-act="move-category" data-id="${c.id}" data-dir="down" ${i === siblings.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="small danger" data-act="archive-category" data-id="${c.id}">Archive</button></div></div>`;
  return `<div class="wrap"><div class="page-head"><h1>Categories</h1><button class="primary" data-act="add-category">+ Add category</button></div>
    <p><a href="#settings">← Back to Settings</a></p>
    <div class="note">Categories are what you spent on. Whether a purchase is reimbursed by work is a separate choice you make when you add it.</div>
    ${tops.map((c, i) => `${item(c, tops, i, false)}${kids(c.id).length ? `<div class="sub">${kids(c.id).map((k, j, arr) => item(k, arr, j, true)).join('')}</div>` : ''}`).join('')}
    ${archived.length ? `<h2 class="group-h">Archived</h2>${archived.map((c) => `<div class="card archived"><div class="row"><h3>${esc(c.name)}</h3>
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
    <div class="card"><h2>Categories</h2><p class="small muted">Add, rename, reorder or archive what you spend on.</p><a class="btn" href="#categories">Open categories</a></div>

    <div class="card"><h2>Pay amounts</h2>
      <p class="small muted">These pre-fill the “I got paid” screen. Allowance is effective-dated, so a change never rewrites earlier months.</p>
      ${state.allowance.map((a) => `<div class="row line"><div><span class="amount">${fmtCad(a.amount_cents)}</span> <span class="muted small">allowance per month, from ${esc(a.effective_from)}</span></div>
        <button class="small danger" data-act="delete-allowance" data-id="${a.id}">Delete</button></div>`).join('') || '<p class="muted">None yet.</p>'}
      <form data-form="allowance" class="stack" style="margin-top:.9rem"><div class="grid2">
        <div class="field"><label>New monthly allowance (CAD)</label><input name="amount" inputmode="decimal" placeholder="600.00" required></div>
        <div class="field"><label>Effective from</label><input type="date" name="effective_from" value="${todayLocal()}" required></div></div>
      <button class="primary" type="submit">Add allowance amount</button></form>
      <hr class="sep">
      <form data-form="rentfunding" class="stack"><div class="field"><label>Monthly rent funding (CAD)</label><input name="rent" inputmode="decimal" value="${centsToInput(s.rent_funding_cents ?? 191800)}" required></div>
      <button class="primary" type="submit">Save rent funding</button></form></div>

    <div class="card"><h2>Start date</h2>
      <p class="small muted">Tracking begins on this date. Opening balances are entered as of it.</p>
      <form data-form="tracking" class="stack"><div class="field"><label>Tracking start date</label><input type="date" name="tracking_start" value="${esc(s.tracking_start)}" required></div>
      <button class="primary" type="submit">Save start date</button></form></div>

    <div class="card"><h2>Reimbursement periods and caps</h2>
      <p class="small muted">Work expense period runs from the ${ordinal(sd)} to the day before, e.g. ${esc(periodExample)}. Personal budgets still use calendar months.</p>
      <form data-form="rules" class="stack"><div class="grid2">
        <div class="field"><label>Period starts on day (1–28)</label><input type="number" name="period_start_day" min="1" max="28" value="${sd}" required></div>
        <div class="field"><label>Reimbursed on day (1–28)</label><input type="number" name="reimbursement_pay_day" min="1" max="28" value="${s.reimbursement_pay_day}" required></div></div>
        <div class="field"><label>Warn when spending reaches (% of money)</label><input type="number" name="warn_at_percent" min="1" max="100" value="${s.warn_at_percent}" required></div>
        <label class="check"><input type="checkbox" name="carry_over_unused" ${s.carry_over_unused ? 'checked' : ''}> Carry unused reimbursement cap into the next period (off = it expires)</label>
        <button class="primary" type="submit">Save period rules</button></form>
      <hr class="sep">
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

const VIEWS = { home: viewHome, activity: viewActivity, accounts: viewAccounts, categories: viewCategories, settings: viewSettings };
const NAV = [['home', 'Home', '⌂'], ['activity', 'Activity', '☰'], ['accounts', 'Accounts', '◉'], ['settings', 'Settings', '⚙']];

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
  const view = VIEWS[state.view] ? state.view : 'home';
  const navKey = view === 'categories' ? 'settings' : view;
  app.innerHTML = `<div class="shell"><nav class="nav" aria-label="Main"><div class="brand">Peach</div>
    ${NAV.map(([k, label, ico]) => `<a href="#${k}" ${k === navKey ? 'aria-current="page"' : ''}><span class="ico" aria-hidden="true">${ico}</span>${label}</a>`).join('')}</nav>
    <main>${VIEWS[view]()}</main>
    <button class="fab" data-act="quick-add" aria-label="Add: I got paid, I spent, or move money">＋</button></div>`;
}

// ---------- forms ----------
function accountOptions(selectedId, { skipId = null, types = GROUP_ORDER } = {}) {
  return GROUP_ORDER.filter((t) => types.includes(t)).map((t) => {
    const list = activeAccounts().filter((a) => a.type === t && a.id !== skipId).sort(bySort);
    return list.length ? `<optgroup label="${GROUP_LABELS[t]}">${list.map((a) => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${esc(a.name)}${a.last4 ? ` ••${esc(a.last4)}` : ''}</option>`).join('')}</optgroup>` : '';
  }).join('');
}
function categoryOptions(selectedId) {
  const ok = (c) => !c.archived_at && c.kind !== 'savings' && c.kind !== 'income';
  const tops = state.categories.filter((c) => !c.parent_id && ok(c)).sort(bySort);
  return tops.map((p) => {
    const kids = state.categories.filter((c) => c.parent_id === p.id && ok(c)).sort(bySort);
    return `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}</option>${kids.map((k) => `<option value="${k.id}" ${k.id === selectedId ? 'selected' : ''}>${esc(p.name)} › ${esc(k.name)}</option>`).join('')}`;
  }).join('');
}
function needAccounts() {
  if (activeAccounts().length) return false;
  toast('Add an account first (Accounts tab).', true);
  location.hash = '#accounts';
  return true;
}

function spentForm(t) {
  const l = t ? state.lines.find((x) => x.transaction_id === t.id) : null;
  const lastAcct = t?.account_id ?? lsGet('peach.lastAccount');
  const lastCat = l?.category_id ?? lsGet('peach.lastCategory');
  const work = l?.reimb_budget ?? '';
  openForm({
    title: t ? 'Edit purchase' : 'I spent', submitLabel: t ? 'Save' : 'Add',
    body: `<div class="field"><label>Amount (CAD)</label><input name="amount" inputmode="decimal" placeholder="0.00" required autofocus value="${t ? centsToInput(-t.amount_cents) : ''}"></div>
      <div class="field"><label>What was it? (optional)</label><input name="payee" value="${esc(t?.payee)}" placeholder="e.g. Loblaws"></div>
      <div class="field"><label>Category</label><select name="category_id">${categoryOptions(lastCat)}</select></div>
      <div class="field"><label>Paid with</label><select name="account_id">${accountOptions(lastAcct, { types: GROUP_ORDER })}</select></div>
      <div class="field"><label>Date</label><input type="date" name="date" required value="${esc(t?.date ?? todayLocal())}"></div>
      <div class="field"><label>Will work reimburse this?</label><select name="work">
        <option value="" ${work === '' ? 'selected' : ''}>No</option>
        <option value="communications" ${work === 'communications' ? 'selected' : ''}>Yes: Communications</option>
        <option value="fuel" ${work === 'fuel' ? 'selected' : ''}>Yes: Car fuel</option>
        <option value="petty_cash" ${work === 'petty_cash' ? 'selected' : ''}>Yes: Petty cash (paid back in full)</option></select>
        <div class="small muted" style="margin-top:.3rem">Communications and fuel only reimburse up to their limit; the rest stays your own cost. Petty cash has no limit, so none of it is your cost.</div></div>`,
    onSubmit: async (f) => {
      const cents = positiveCents(f.amount, 'Amount');
      checkDate(f.date);
      if (!f.account_id) throw new Error('Choose an account');
      const lineRow = { category_id: f.category_id || null, amount_cents: cents, reimb_budget: f.work || null, reimb_eligible: !!f.work };
      const txnRow = { account_id: f.account_id, date: f.date, amount_cents: -cents, kind: 'expense', payee: (f.payee ?? '').trim() || null };
      if (t) {
        await must(sb.from('transactions').update(txnRow).eq('id', t.id));
        await must(sb.from('transaction_lines').update(lineRow).eq('transaction_id', t.id));
      } else {
        const created = await must(sb.from('transactions').insert(txnRow).select().single());
        try { await must(sb.from('transaction_lines').insert({ ...lineRow, transaction_id: created.id })); }
        catch (e) { await sb.from('transactions').delete().eq('id', created.id); throw e; }
      }
      lsSet('peach.lastAccount', f.account_id); lsSet('peach.lastCategory', f.category_id);
      await refresh(); toast(t ? 'Saved' : 'Added');
    },
  });
}

function paidForm() {
  const today = todayLocal();
  const allowance = allowanceOn(state.allowance.map((a) => ({ effectiveFrom: a.effective_from, cents: a.amount_cents })), today);
  const dep = accountOptions(lsGet('peach.lastDeposit'), { types: ['chequing', 'savings', 'cash'] });
  openForm({
    title: 'I got paid', submitLabel: 'Record pay',
    intro: 'Fill in what actually arrived. Leave a line at 0 if it did not.',
    body: `<div class="field"><label>Date received</label><input type="date" name="date" required value="${today}"></div>
      <div class="field"><label>Deposited into</label><select name="account_id">${dep}</select></div>
      <div class="field"><label>Allowance</label><input name="allowance" inputmode="decimal" value="${allowance != null ? centsToInput(allowance) : '0.00'}">
        <div class="small muted">This is your spending money for the month.</div></div>
      <div class="field"><label>Rent funding</label><input name="rent" inputmode="decimal" value="${centsToInput(state.settings?.rent_funding_cents ?? 191800)}">
        <div class="small muted">Held for rent. It will not show as spendable.</div></div>
      <div class="field"><label>Expense reimbursement received</label><input name="reimb" inputmode="decimal" value="0.00">
        <div class="small muted">Money back from work. Recorded as received, not as new spending money.</div></div>`,
    onSubmit: async (f) => {
      checkDate(f.date);
      if (!f.account_id) throw new Error('Choose an account (add a chequing account first)');
      const parts = [['allowance', f.allowance], ['rent_funding', f.rent], ['reimbursement', f.reimb]]
        .map(([src, v]) => [src, toCents(v || '0')]);
      if (parts.some(([, c]) => c < 0)) throw new Error('Amounts cannot be negative');
      const rows = parts.filter(([, c]) => c > 0).map(([src, c]) => ({ account_id: f.account_id, date: f.date, amount_cents: c, kind: 'income', income_source: src }));
      if (!rows.length) throw new Error('Enter at least one amount');
      await must(sb.from('transactions').insert(rows));
      lsSet('peach.lastDeposit', f.account_id);
      await refresh(); toast('Pay recorded');
    },
  });
}

function transferForm() {
  openForm({
    title: 'Pay a card / move money', submitLabel: 'Record',
    intro: 'Paying a card or moving money between your own accounts is a transfer. It is never counted as spending.',
    body: `<div class="field"><label>From</label><select name="from">${accountOptions(lsGet('peach.lastFrom'), { types: ['chequing', 'savings', 'cash'] })}</select></div>
      <div class="field"><label>To</label><select name="to">${accountOptions(null, { types: GROUP_ORDER })}</select></div>
      <div class="field"><label>Amount (CAD)</label><input name="amount" inputmode="decimal" placeholder="0.00" required></div>
      <div class="field"><label>Date</label><input type="date" name="date" required value="${todayLocal()}"></div>
      <label class="check"><input type="checkbox" name="rent"> This payment settles my rent charge on the card</label>`,
    onSubmit: async (f) => {
      const cents = positiveCents(f.amount, 'Amount');
      checkDate(f.date);
      if (!f.from || !f.to) throw new Error('Choose both accounts');
      if (f.from === f.to) throw new Error('Choose two different accounts');
      if (f.rent && byId(state.accounts, f.to)?.type !== 'credit_card') throw new Error('Rent settlement applies to a payment into a credit card');
      const gid = crypto.randomUUID();
      await must(sb.from('transactions').insert([
        { account_id: f.from, date: f.date, amount_cents: -cents, kind: 'transfer', transfer_group_id: gid, is_rent_settlement: !!f.rent },
        { account_id: f.to, date: f.date, amount_cents: cents, kind: 'transfer', transfer_group_id: gid, is_rent_settlement: !!f.rent },
      ]));
      lsSet('peach.lastFrom', f.from);
      await refresh(); toast('Recorded');
    },
  });
}

function quickAdd() {
  if (needAccounts()) return;
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<div class="stack"><h2>What do you want to record?</h2>
    <button class="big primary" data-go="paid"><span aria-hidden="true">＋</span> I got paid</button>
    <button class="big" data-go="spent"><span aria-hidden="true">−</span> I spent</button>
    <button class="big" data-go="transfer"><span aria-hidden="true">⇄</span> Pay a card / move money</button>
    <button data-go="close">Cancel</button></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]')?.dataset.go;
    if (!g) return;
    dlg.close();
    if (g === 'paid') paidForm(); else if (g === 'spent') spentForm(); else if (g === 'transfer') transferForm();
  });
  dlg.showModal();
}

function accountForm(a) {
  const types = Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${a?.type === k ? 'selected' : ''}>${v}</option>`).join('');
  const entered = a ? (a.type === 'credit_card' ? -a.opening_balance_cents : a.opening_balance_cents) : 0;
  return `<div class="field"><label>Name</label><input name="name" required value="${esc(a?.name)}" placeholder="e.g. RBC Visa"></div>
    <div class="grid2"><div class="field"><label>Type</label><select name="type">${types}</select></div>
    <div class="field"><label>Nickname (optional)</label><input name="nickname" value="${esc(a?.nickname)}"></div></div>
    <div class="grid2"><div class="field"><label>Last 4 digits (optional)</label><input name="last4" inputmode="numeric" maxlength="4" pattern="[0-9]{0,4}" value="${esc(a?.last4)}"></div>
    <div class="field"><label>Opening date</label><input type="date" name="opening_date" required value="${esc(a?.opening_date ?? state.settings?.tracking_start ?? todayLocal())}"></div></div>
    <div class="field"><label id="balLabel">Opening balance</label><input name="opening" inputmode="decimal" value="${centsToInput(entered)}"></div>
    <div id="cardFields" class="stack" hidden>
      <div class="grid2"><div class="field"><label>Payment due on day (1–28)</label><input type="number" name="due_day" min="1" max="28" value="${a?.due_day ?? ''}" placeholder="e.g. 15"></div>
      <div class="field"><label>Minimum payment (CAD)</label><input name="min_payment" inputmode="decimal" value="${a?.min_payment_cents != null ? centsToInput(a.min_payment_cents) : ''}" placeholder="e.g. 35.00"></div></div>
      <div class="field"><label>Remind me this many days before</label><input type="number" name="remind_days" min="0" max="30" value="${a?.remind_days ?? 3}"></div>
      <div class="small muted">If your card is due on the 29th–31st, enter 28 to be safe. Update the minimum each month if it changes.</div></div>`;
}
function wireAccountForm(dlg) {
  const sel = dlg.querySelector('[name=type]'), lab = dlg.querySelector('#balLabel'), cf = dlg.querySelector('#cardFields');
  const upd = () => { const cc = sel.value === 'credit_card';
    lab.textContent = cc ? 'Amount owed on this card at the opening date (positive number)' : 'Balance at the opening date'; cf.hidden = !cc; };
  sel.addEventListener('change', upd); upd();
}
function accountRow(f) {
  const name = f.name.trim();
  if (!name) throw new Error('Name is required');
  const last4 = (f.last4 ?? '').trim();
  if (last4 && !/^\d{1,4}$/.test(last4)) throw new Error('Last digits: numbers only, up to 4. Never enter a full account number.');
  let cents = toCents(f.opening || '0');
  const cc = f.type === 'credit_card';
  if (cc) cents = 0 - cents;
  let due = null, min = null, remind = 3;
  if (cc) {
    if ((f.due_day ?? '') !== '') { due = parseInt(f.due_day, 10); if (!(due >= 1 && due <= 28)) throw new Error('Due day must be between 1 and 28'); }
    if ((f.min_payment ?? '').trim() !== '') { min = toCents(f.min_payment); if (min < 0) throw new Error('Minimum payment cannot be negative'); }
    if ((f.remind_days ?? '') !== '') { remind = parseInt(f.remind_days, 10); if (!(remind >= 0 && remind <= 30)) throw new Error('Reminder days must be 0 to 30'); }
  }
  return { name, nickname: (f.nickname ?? '').trim() || null, last4: last4 || null, type: f.type, opening_balance_cents: cents,
    opening_date: f.opening_date, due_day: due, min_payment_cents: min, remind_days: remind };
}

// ---------- actions ----------
const handlers = {
  retry: () => refresh(),
  'sign-out': async () => { await sb.auth.signOut(); },
  'quick-add': quickAdd,
  'add-paid': () => { if (!needAccounts()) paidForm(); },
  'add-spent': () => { if (!needAccounts()) spentForm(); },
  'add-transfer': () => { if (!needAccounts()) transferForm(); },
  'edit-spent': ({ id }) => spentForm(byId(state.txns, id)),
  'delete-txn': async ({ id, type }) => {
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    try {
      const t = byId(state.txns, id);
      if (type === 'transfer' && t.transfer_group_id) await must(sb.from('transactions').delete().eq('transfer_group_id', t.transfer_group_id));
      else await must(sb.from('transactions').delete().eq('id', id));
      await refresh(); toast('Deleted');
    } catch (e) { toast(e.message, true); }
  },
  month: ({ dir }) => { state.month = addMonthsKey(state.month ?? monthKey(todayLocal()), parseInt(dir, 10)); render(); },

  'add-account': () => openForm({ title: 'Add account', body: accountForm(null), submitLabel: 'Add', onOpen: wireAccountForm,
    onSubmit: async (f) => { await must(sb.from('accounts').insert({ ...accountRow(f), sort_order: nextSort(state.accounts) })); await refresh(); toast('Account added'); } }),
  'edit-account': ({ id }) => { const a = byId(state.accounts, id); openForm({ title: 'Edit account', body: accountForm(a), onOpen: wireAccountForm,
    onSubmit: async (f) => { await must(sb.from('accounts').update(accountRow(f)).eq('id', id)); await refresh(); toast('Saved'); } }); },
  'archive-account': async ({ id }) => {
    if (!confirm('Archive this account? Its history is kept and you can restore it any time.')) return;
    try { await must(sb.from('accounts').update({ archived_at: new Date().toISOString() }).eq('id', id)); await refresh(); toast('Archived'); } catch (e) { toast(e.message, true); } },
  'restore-account': async ({ id }) => { try { await must(sb.from('accounts').update({ archived_at: null }).eq('id', id)); await refresh(); } catch (e) { toast(e.message, true); } },
  'move-account': async ({ id, dir }) => {
    const a = byId(state.accounts, id);
    try { await reorder('accounts', activeAccounts().filter((x) => x.type === a.type), id, dir); await refresh(); } catch (e) { toast(e.message, true); } },
  'card-calendar': ({ id }) => {
    const a = byId(state.accounts, id);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const ics = buildCardIcs({ id: a.id, name: a.name, dueDay: a.due_day, minPaymentCents: a.min_payment_cents, remindDays: a.remind_days }, todayLocal(), stamp);
    const blob = new Blob([ics], { type: 'text/calendar' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = `${a.name.replace(/[^\w-]+/g, '-')}-due.ics`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast('Open the downloaded file to add the repeating reminder to your calendar');
  },

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
      a.href = URL.createObjectURL(blob); a.download = `peach-export-${todayLocal()}.json`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Export downloaded');
    } catch (e) { toast(e.message, true); }
  },
};

const forms = {
  tracking: async (f) => { await must(sb.from('settings').update({ tracking_start: f.tracking_start, updated_at: new Date().toISOString() }).eq('user_id', state.session.user.id)); },
  rentfunding: async (f) => {
    const c = toCents(f.rent); if (c < 0) throw new Error('Amount cannot be negative');
    await must(sb.from('settings').update({ rent_funding_cents: c, updated_at: new Date().toISOString() }).eq('user_id', state.session.user.id)); },
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

function route() { state.view = (location.hash || '#home').slice(1); render(); window.scrollTo(0, 0); }
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
  state.view = (location.hash || '#home').slice(1);
  if (state.session) await refresh(); else render();
})();
