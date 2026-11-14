import { sum } from './money.js';

/*
 * Transaction (signed cents; negative = money leaves the account):
 * { id, accountId, date, amountCents, kind: 'expense'|'income'|'transfer', transferGroupId?, incomeSource? }
 * - Credit-card purchase: kind 'expense', negative on the card (balance goes more negative = owed).
 * - Card payment / own-account move / savings transfer: kind 'transfer', two rows sharing transferGroupId.
 * - Opening balances live on the account, never as transactions (so opening card debt is not an expense).
 */

export function accountBalances(accounts, txns, { includeArchived = false } = {}) {
  return accounts
    .filter((a) => includeArchived || !a.archivedAt)
    .map((a) => {
      const balanceCents = a.openingBalanceCents + sum(txns.filter((t) => t.accountId === a.id).map((t) => t.amountCents));
      return { id: a.id, name: a.name, type: a.type, archived: !!a.archivedAt, balanceCents,
        owedCents: a.type === 'credit_card' ? Math.max(0, -balanceCents) : 0 };
    });
}

/** Spending counts only real expenses; transfers and opening balances never count. */
export function spendingTotals(txns) {
  const expense = txns.filter((t) => t.kind === 'expense');
  const income = txns.filter((t) => t.kind === 'income');
  const incomeBySource = {};
  for (const t of income) incomeBySource[t.incomeSource ?? 'other'] = (incomeBySource[t.incomeSource ?? 'other'] ?? 0) + t.amountCents;
  return { expenseCents: 0 - sum(expense.map((t) => t.amountCents)), incomeBySource };
}

/** Each transfer group must be exactly two rows that net to zero. Returns list of problem group ids. */
export function validateTransfers(txns) {
  const groups = {};
  for (const t of txns.filter((t) => t.kind === 'transfer')) (groups[t.transferGroupId] ??= []).push(t);
  return Object.entries(groups)
    .filter(([, rows]) => rows.length !== 2 || sum(rows.map((r) => r.amountCents)) !== 0)
    .map(([id]) => id);
}
