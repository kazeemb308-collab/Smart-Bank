const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const runtimeDataDir = isVercel ? '/tmp' : __dirname;
const runtimeDataFile = path.join(runtimeDataDir, 'data.json');
const sourceDataFile = path.join(__dirname, 'data.json');
const dataFile = process.env.DATA_FILE_PATH || runtimeDataFile;

// Config: daily interest rate (fraction). Example: 0.001 = 0.1% daily
const DAILY_INTEREST_RATE = Number(process.env.DAILY_INTEREST_RATE) || 0.001;

let state = { users: [], transactions: [], messages: [] };

function loadState() {
  if (isVercel) {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    if (!fs.existsSync(dataFile) && fs.existsSync(sourceDataFile)) {
      try {
        fs.copyFileSync(sourceDataFile, dataFile);
      } catch (err) {
        console.error('Failed to copy source data into /tmp:', err.message);
      }
    }
  }

  if (!fs.existsSync(dataFile)) {
    state = { users: [], transactions: [], messages: [] };
    saveState();
    return state;
  }

  try {
    state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (err) {
    console.error('Failed to read data file:', err.message);
    state = { users: [], transactions: [] };
  }
  return state;
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save state file:', err.message);
  }
}

function initDb() {
  loadState();
  // Ensure existing users have `last_interest_at` set
  state.users.forEach((u) => {
    if (!u.last_interest_at) u.last_interest_at = u.created_at || new Date().toISOString();
  });

  state.messages = state.messages || [];

  if (!state.users.some((user) => user.email === 'admin@smartbank.com')) {
    const adminPassword = bcrypt.hashSync('Admin@1234', 10);
    const adminUser = {
      id: 1,
      full_name: 'Smart Bank Admin',
      email: 'admin@smartbank.com',
      phone: '08000000000',
      password: adminPassword,
      account_number: '1000000000',
      balance: 1000000,
      last_interest_at: new Date().toISOString(),
      is_admin: 1,
      created_at: new Date().toISOString()
    };

    state.users.push(adminUser);
    state.transactions.push({
      id: 1,
      user_id: adminUser.id,
      type: 'welcome',
      amount: 1000000,
      note: 'Admin account created',
      created_at: new Date().toISOString()
    });
    saveState();
  }
}

function daysBetween(a, b) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const da = new Date(a);
  const db = new Date(b);
  return Math.floor((db - da) / msPerDay);
}

function applyInterestToUser(user) {
  if (!user) return null;
  const now = new Date().toISOString();
  const last = user.last_interest_at || user.created_at || now;
  const days = daysBetween(last, now);
  if (days <= 0) return null;

  const oldBalance = Number(user.balance);
  const multiplier = Math.pow(1 + DAILY_INTEREST_RATE, days);
  const newBalance = Number((oldBalance * multiplier).toFixed(6));
  const interestAmount = Number((newBalance - oldBalance).toFixed(6));
  if (interestAmount > 0) {
    user.balance = newBalance;
    user.last_interest_at = now;
    saveState();
    addTransaction(user.id, 'interest', interestAmount, `Daily interest for ${days} day(s) at ${ (DAILY_INTEREST_RATE*100).toFixed(3) }%`);
    return interestAmount;
  }
  user.last_interest_at = now;
  saveState();
  return null;
}

function normalizeUserId(id) {
  const parsed = Number(id);
  return Number.isFinite(parsed) ? parsed : null;
}

function getUserById(id) {
  const normalizedId = normalizeUserId(id);
  return state.users.find((user) => user.id === normalizedId) || null;
}

function getUserByEmail(email) {
  return state.users.find((user) => user.email === email) || null;
}

function getUserByAccountNumber(accountNumber) {
  return state.users.find((user) => user.account_number === accountNumber) || null;
}

function getUserTransactions(userId) {
  return state.transactions
    .filter((tx) => tx.user_id === userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);
}

function getUserMessages(userId) {
  return state.messages
    .filter((msg) => msg.user_id === userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function addTransaction(userId, type, amount, note) {
  const transaction = {
    id: state.transactions.length ? state.transactions[state.transactions.length - 1].id + 1 : 1,
    user_id: userId,
    type,
    amount,
    note,
    created_at: new Date().toISOString()
  };
  state.transactions.push(transaction);
  saveState();
  return transaction;
}

function addMessage(userId, sender, message) {
  const msg = {
    id: state.messages.length ? state.messages[state.messages.length - 1].id + 1 : 1,
    user_id: userId,
    sender,
    message,
    created_at: new Date().toISOString()
  };
  state.messages.push(msg);
  saveState();
  return msg;
}

function updateUserBalance(userId, delta) {
  const user = getUserById(userId);
  if (!user) return null;
  user.balance = Number(user.balance) + Number(delta);
  saveState();
  return user;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'smart-bank-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

initDb();

function requireLogin(req, res, next) {
  const userId = normalizeUserId(req.session.userId);
  if (!userId) {
    return res.redirect('/login');
  }

  req.session.userId = userId;
  const user = getUserById(userId);
  if (!user) {
    req.session.userId = null;
    return res.redirect('/login');
  }

  next();
}

function requireAdmin(req, res, next) {
  const userId = normalizeUserId(req.session.userId);
  if (!userId) {
    return res.redirect('/login');
  }

  req.session.userId = userId;
  const user = getUserById(userId);
  if (!user) {
    req.session.userId = null;
    return res.redirect('/login');
  }

  if (user.is_admin !== 1) {
    return res.redirect('/dashboard');
  }

  next();
}

app.get('/', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null, success: null });
});

app.get('/register', (req, res) => {
  res.render('register', { error: null, success: null });
});

app.post('/register', (req, res) => {
  const { full_name, email, phone, password, confirm_password } = req.body;

  if (!full_name || !email || !phone || !password || !confirm_password) {
    return res.render('register', { error: 'Please fill in all fields.', success: null });
  }

  if (password !== confirm_password) {
    return res.render('register', { error: 'Passwords do not match.', success: null });
  }

  const existing = getUserByEmail(email) || state.users.find((user) => user.phone === phone);
  if (existing) {
    return res.render('register', { error: 'Email or phone number already exists.', success: null });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const accountNumber = String(1000000000 + Math.floor(Math.random() * 900000000));
  const newUser = {
    id: state.users.length ? state.users[state.users.length - 1].id + 1 : 1,
    full_name,
    email,
    phone,
    password: hashed,
    account_number: accountNumber,
    balance: 0,
    is_admin: 0,
    created_at: new Date().toISOString()
  };

  state.users.push(newUser);
  saveState();
  addTransaction(newUser.id, 'welcome', 0, 'Account created successfully');

  req.session.userId = newUser.id;
  return res.redirect('/dashboard?message=Account created successfully');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null, success: req.query.message || null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = getUserByEmail(email);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('login', { error: 'Invalid email or password.', success: null });
  }

  req.session.userId = Number(user.id);
  return res.redirect('/dashboard');
});

app.get('/dashboard', requireLogin, (req, res) => {
  const userId = normalizeUserId(req.session.userId);
  const user = getUserById(userId);
  // Apply any accrued daily interest before showing dashboard
  applyInterestToUser(user);
  const transactions = getUserTransactions(req.session.userId);

  const displayBalance = Number(user.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const dailyRateNum = DAILY_INTEREST_RATE;
  const apy = ((Math.pow(1 + DAILY_INTEREST_RATE, 365) - 1) * 100).toFixed(2);

  res.render('dashboard', {
    user,
    transactions,
    error: req.query.error || null,
    success: req.query.message || null,
    dailyRate: dailyRateNum,
    initialBalance: Number(user.balance),
    lastInterestAt: user.last_interest_at || user.created_at,
    displayBalance,
    apy
  });
});

app.get('/account', requireLogin, (req, res) => {
  const userId = normalizeUserId(req.session.userId);
  const user = getUserById(userId);
  if (!user) {
    req.session.userId = null;
    return res.redirect('/login');
  }

  const messages = getUserMessages(user.id);
  const dailyRateNum = DAILY_INTEREST_RATE;
  const apy = ((Math.pow(1 + DAILY_INTEREST_RATE, 365) - 1) * 100).toFixed(2);

  res.render('account', {
    user,
    messages,
    error: req.query.error || null,
    success: req.query.success || null,
    dailyRate: dailyRateNum,
    apy
  });
});

app.get('/transfer', requireLogin, (req, res) => {
  const user = getUserById(req.session.userId);
  const displayBalance = Number(user.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const dailyRateNum = DAILY_INTEREST_RATE;
  const apy = ((Math.pow(1 + DAILY_INTEREST_RATE, 365) - 1) * 100).toFixed(2);

  res.render('transfer', {
    user,
    error: req.query.error || null,
    success: req.query.message || null,
    dailyRate: dailyRateNum,
    displayBalance,
    apy
  });
});

app.get('/history', requireLogin, (req, res) => {
  const user = getUserById(req.session.userId);
  const transactions = getUserTransactions(req.session.userId);
  const dailyRateNum = DAILY_INTEREST_RATE;
  const apy = ((Math.pow(1 + DAILY_INTEREST_RATE, 365) - 1) * 100).toFixed(2);

  res.render('history', {
    user,
    transactions,
    error: req.query.error || null,
    success: req.query.message || null,
    dailyRate: dailyRateNum,
    apy
  });
});

app.post('/withdraw', requireLogin, (req, res) => {
  // Withdrawals are disabled by policy for this investment product
  return res.redirect('/dashboard?error=You are currently ineligible to withdraw funds');
});

app.post('/transfer', requireLogin, (req, res) => {
  const { recipientAccount, amount } = req.body;
  const sender = getUserById(req.session.userId);
  const numericAmount = Number(amount);

  if (!recipientAccount || !numericAmount || numericAmount <= 0) {
    return res.redirect('/transfer?error=Please provide a valid recipient and amount');
  }

  if (sender.balance < numericAmount) {
    return res.redirect('/dashboard?error=Insufficient balance');
  }

  const recipient = getUserByAccountNumber(recipientAccount);
  if (!recipient || recipient.id === sender.id) {
    return res.redirect('/dashboard?error=Recipient account not found');
  }

  sender.balance = Number(sender.balance) - numericAmount;
  recipient.balance = Number(recipient.balance) + numericAmount;
  saveState();
  addTransaction(sender.id, 'transfer_out', numericAmount, `Transferred to ${recipient.account_number}`);
  addTransaction(recipient.id, 'transfer_in', numericAmount, `Received from ${sender.account_number}`);

  return res.redirect('/dashboard?message=Transfer completed successfully');
});

app.get('/admin', requireAdmin, (req, res) => {
  const users = [...state.users].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const transactions = [...state.transactions]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 20)
    .map((tx) => ({ ...tx, full_name: getUserById(tx.user_id)?.full_name || 'Unknown' }));
  const messagesByUser = users.reduce((acc, user) => {
    acc[user.id] = getUserMessages(user.id);
    return acc;
  }, {});

  res.render('admin', {
    users,
    transactions,
    messagesByUser,
    error: req.query.error || null,
    success: req.query.message || null
  });
});

app.post('/admin/fund', requireAdmin, (req, res) => {
  const { account_number, amount, note } = req.body;
  const numericAmount = Number(amount);

  if (!account_number || !numericAmount || numericAmount <= 0) {
    return res.redirect('/admin?error=Enter a valid account number, amount, and note');
  }

  const user = getUserByAccountNumber(account_number);
  if (!user) {
    return res.redirect('/admin?error=Account not found');
  }

  updateUserBalance(user.id, numericAmount);
  addTransaction(user.id, 'admin_credit', numericAmount, note || 'Funds added by administrator');

  return res.redirect('/admin?message=Funds added successfully');
});

app.post('/admin/reply', requireAdmin, (req, res) => {
  const { account_number, message } = req.body;
  const numericUser = getUserByAccountNumber(account_number);

  if (!account_number || !message || !message.trim()) {
    return res.redirect('/admin?error=Please provide an account number and reply message');
  }

  if (!numericUser) {
    return res.redirect('/admin?error=Account not found');
  }

  addMessage(numericUser.id, 'admin', message.trim());
  return res.redirect('/admin?message=Reply sent successfully');
});

app.post('/account/update', requireLogin, (req, res) => {
  const { email, phone } = req.body;
  const user = getUserById(req.session.userId);

  if (!user) {
    return res.redirect('/login');
  }

  const existingEmail = state.users.find((u) => u.email === email && u.id !== user.id);
  const existingPhone = state.users.find((u) => u.phone === phone && u.id !== user.id);

  if (!email || !phone) {
    return res.redirect('/account?error=Please provide both email and phone number');
  }

  if (existingEmail) {
    return res.redirect('/account?error=This email is already in use');
  }

  if (existingPhone) {
    return res.redirect('/account?error=This phone number is already in use');
  }

  user.email = email;
  user.phone = phone;
  saveState();

  return res.redirect('/account?success=Account details updated');
});

app.post('/account/message', requireLogin, (req, res) => {
  const { message } = req.body;
  const user = getUserById(req.session.userId);

  if (!message || !message.trim()) {
    return res.redirect('/account?error=Please enter a message');
  }

  addMessage(user.id, 'customer', message.trim());
  return res.redirect('/account?success=Message sent to customer care');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login?message=You have logged out'));
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Smart Bank app is running on http://localhost:${port}`);
  });
}

module.exports = app;
