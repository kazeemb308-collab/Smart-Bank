const ejs = require('ejs');
const path = require('path');
const fs = require('fs');

const tpl = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
const user = data.users[0];
const transactions = data.transactions.filter(t => t.user_id === user.id);
const dailyRate = 0.001;
const displayBalance = Number(user.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const apy = ((Math.pow(1 + dailyRate, 365) - 1) * 100).toFixed(2);

console.log('Testing render...');

ejs.renderFile(tpl, { user, transactions, dailyRate, displayBalance, apy, error: null, success: null }, {}, (err, str) => {
  if (err) {
    console.error('Render error:');
    console.error(err);
    process.exit(2);
  }
  console.log('Rendered length:', str.length);
  console.log(str.slice(0,500));
});
