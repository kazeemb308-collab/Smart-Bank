// Account cleanup helper for Smart-Bank.
// Run this from a scheduled job (for example, Vercel Cron) rather than on every request.
// Set ACCOUNT_RETENTION_DAYS to the number of days an account may remain inactive.

const RETENTION_DAYS = Number(process.env.ACCOUNT_RETENTION_DAYS || 365);

function getCutoffDate(now = new Date()) {
  return new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Return accounts that are eligible for deletion.
 * Pass an array of account objects with `createdAt` and/or `lastActiveAt`.
 * Admin accounts are always excluded.
 */
function getAccountsForDeletion(accounts, now = new Date()) {
  const cutoff = getCutoffDate(now);

  return accounts.filter((account) => {
    if (account.isAdmin || account.role === 'admin') return false;

    const activityValue = account.lastActiveAt || account.createdAt;
    if (!activityValue) return false;

    return new Date(activityValue) < cutoff;
  });
}

module.exports = { RETENTION_DAYS, getCutoffDate, getAccountsForDeletion };
