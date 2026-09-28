const express = require('express');
const session = require('cookie-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { firebaseEnabled, loadPersistentState, savePersistentState } = require('./firestore');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const runtimeDataDir = isVercel ? '/tmp' : __dirname;
const runtimeDataFile = path.join(runtimeDataDir, 'data.json');
const sourceDataFile = path.join(__dirname, 'data.json');
const dataFile = process.env.DATA_FILE_PATH || runtimeDataFile;

// Config: default daily interest rate (fraction). Example: 0.001 = 0.1% daily
const DAILY_INTEREST_RATE = Number(process.env.DAILY_INTEREST_RATE) || 0.001;

let state = { users: [], transactions: [], messages: [] };
let pendingPersistence = Promise.resolve();

function loadLocalState() {
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
    return { users: [], transactions: [], messages: [] };
  }

  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (err) {
    console.error('Failed to read data file:', err.message);
    return { users: [], transactions: [], messages: [] };
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save state file:', err.message);
  }

  if (firebaseEnabled) {
    pendingPersistence = pendingPersistence
      .catch(() => {})
      .then(() => savePersistentState(state));
  }

  return pendingPersistence;
}

function waitForPersistence() {
  return pendingPersistence;
}

async function initDb() {
  state = await loadPersistentState(loadLocalState);

  state.users = state.users || [];
  state.transactions = state.transactions || [];
  state.messages = state.messages || [];

  let stateChanged = false;
  state.users.forEach((u) => {
    if (!u.last_interest_at) {
      u.last_interest_at = u.created_at || new Date().toISOString();
      stateChanged = true;
    }
    // Existing accounts keep the current site-wide rate as their starting rate.
    if (!Number.isFinite(Number(u.interest_rate))) {
      u.interest_rate = DAILY_INTEREST_RATE;
      stateChanged = true;
    }
    // Interest is credited once every 24 hours. Existing accounts continue
    // from their previous interest timestamp without requiring a time setting.
    if (!u.next_interest_at) {
      const last = new Date(u.last_interest_at || u.created_at || Date.now());
      u.next_interest_at = new Date(last.getTime() + 24 * 60 * 60 * 1000).toISOString();
      stateChanged = true;
    }
  });

  if (!state.users.some((user) => user.email === 'admin@smartbank.com')) {
    const adminPassword = bcrypt.hashSync('Admin@1234', 10);
    const adminUser = {
      id: state.users.length ? Math.max(...state.users.map((u) => Number(u.id) || 0)) + 1 : 1,
      full_name: 'Smart Bank Admin',
      email: 'admin@smartbank.com',
      phone: '08000000000',
      password: adminPassword,
      account_number: '1000000000',
      balance: 1000000,
      interest_rate: DAILY_INTEREST_RATE,
      last_interest_at: new Date().toISOString(),
      is_admin: 1,
      created_at: new Date().toISOString()
    };

    state.users.push(adminUser);
    state.transactions.push({
      id: state.transactions.length ? Math.max(...state.transactions.map((tx) => Number(tx.id) || 0)) + 1 : 1,
      user_id: adminUser.id,
      type: 'welcome',
      amount: 1000000,
      note: 'Admin account created',
      created_at: new Date().toISOString()
    });
    stateChanged = true;
  }

  if (stateChanged) {
    saveState();
  }

  await waitForPersistence();
  console.log(firebaseEnabled ? 'Smart Bank persistence: Firestore' : 'Smart Bank persistence: local file');
}

function getInterestRate(user) {
  const rate = Number(user?.interest_rate);
  return Number.isFinite(rate) && rate >= 0 ? rate : DAILY_INTEREST_RATE;
}

const INTEREST_INTERVAL_MS = 24 * 60 * 60 * 1000;

function processDueInterestForUser(user, nowMs = Date.now()) {
  if (!user) return 0;

  const userRate = getInterestRate(user);
  let next = new Date(user.next_interest_at || (
    new Date(user.last_interest_at || user.created_at || nowMs).getTime() + INTEREST_INTERVAL_MS
  ));

  if (!Number.isFinite(next.getTime())) {
    next = new Date(nowMs + INTEREST_INTERVAL_MS);
  }

  let totalInterest = 0;
  let credits = 0;
  let changed = false;

  // Catch up missed daily credits while preserving the original 24-hour schedule.
  // The guard prevents a corrupt timestamp from creating an unbounded loop.
  let safety = 0;
  while (next.getTime() <= nowMs && safety < 3660) {
    const oldBalance = Number(user.balance) || 0;
    const interestAmount = Number((oldBalance * userRate).toFixed(6));

    if (interestAmount > 0) {
      user.balance = Number((oldBalance + interestAmount).toFixed(6));
      totalInterest += interestAmount;
      credits += 1;
      addTransaction(
        user.id,
        'interest',
        interestAmount,
        `Daily interest credited at ${(userRate * 100).toFixed(3)}%`,
        {
          interest_rate: userRate,
          scheduled_for: next.toISOString(),
          balance_after: user.balance
        }
      );
    }

    user.last_interest_at = new Date(nowMs).toISOString();
    next = new Date(next.getTime() + INTEREST_INTERVAL_MS);
    user.next_interest_at = next.toISOString();
    changed = true;
    safety += 1;
  }

  if (changed) {
    saveState();
  }

  return { totalInterest: Number(totalInterest.toFixed(6)), credits };
}

async function processDueInterestForAllUsers() {
  let totalCredits = 0;
  let totalInterest = 0;

  for (const user of state.users) {
    if (user.is_admin) continue;
    const result = processDueInterestForUser(user);
    totalCredits += result.credits;
    totalInterest += result.totalInterest;
  }

  if (totalCredits > 0) {
    await waitForPersistence();
  }

  return {
    usersProcessed: state.users.filter((user) => !user.is_admin).length,
    credits: totalCredits,
    totalInterest: Number(totalInterest.toFixed(6))
  };
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

function getUserInterestTransactions(userId) {
  return state.transactions
    .filter((tx) => tx.user_id === userId && tx.type === 'interest')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getInterestSummary(userId) {
  const interestTransactions = getUserInterestTransactions(userId);
  const totalInterest = interestTransactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  return {
    transactions: interestTransactions,
    totalInterest: Number(totalInterest.toFixed(6)),
    credits: interestTransactions.length
  };
}

function getUserMessages(userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    return [];
  }

  return state.messages
    .filter((msg) => normalizeUserId(msg.user_id) === normalizedUserId)
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
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    return null;
  }

  const user = getUserById(normalizedUserId);
  const msg = {
    id: state.messages.length ? state.messages[state.messages.length - 1].id + 1 : 1,
    user_id: normalizedUserId,
    sender,
    message,
    account_number: user?.account_number || null,
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

// Basic security headers. Keep the app simple while reducing common browser-side risks.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const sessionSecret = process.env.SESSION_SECRET || 'smart-bank-session-secret-key';
if (isVercel && !process.env.SESSION_SECRET) {
  console.warn('SECURITY WARNING: Set a strong SESSION_SECRET in Vercel environment variables.');
}

app.use(session({
  name: 'smartbank_session',
  keys: [sessionSecret],
  maxAge: 1000 * 60 * 60 * 8,
  httpOnly: true,
  sameSite: 'lax',
  secure: isVercel
}));

const dbReady = initDb();

app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    res.status(503).send('Smart Bank is temporarily unavailable.');
  }
});

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

app.post('/register', async (req, res) => {
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
    interest_rate: DAILY_INTEREST_RATE,
    is_admin: 0,
    created_at: new Date().toISOString()
  };

  state.users.push(newUser);
  saveState();
  addTransaction(newUser.id, 'welcome', 0, 'Account created successfully');

  await waitForPersistence();
  req.session.userId = newUser.id;
  return res.redirect('/dashboard?message=Account created successfully');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null, success: req.query.message || null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = getUserByEmail(email);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('login', { error: 'Invalid email or password.', success: null });
  }

  req.session.userId = Number(user.id);
  return res.redirect('/dashboard');
});

app.get('/dashboard', requireLogin, async (req, res) => {
  const userId = normalizeUserId(req.session.userId);
  const user = getUserById(userId);
  processDueInterestForUser(user);
  await waitForPersistence();
  const transactions = getUserTransactions(req.session.userId);

  const displayBalance = Number(user.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const dailyRateNum = getInterestRate(user);
  const apy = ((Math.pow(1 + dailyRateNum, 365) - 1) * 100).toFixed(2);

  res.render('dashboard', {
    user,
    transactions,
    error: req.query.error || null,
    success: req.query.message || null,
    dailyRate: dailyRateNum,
    initialBalance: Number(user.balance),
    lastInterestAt: user.last_interest_at || user.created_at,
    nextInterestAt: user.next_interest_at,
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
  const dailyRateNum = getInterestRate(user);
  const apy = ((Math.pow(1 + dailyRateNum, 365) - 1) * 100).toFixed(2);

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
  processDueInterestForUser(user);
  const displayBalance = Number(user.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const dailyRateNum = getInterestRate(user);
  const apy = ((Math.pow(1 + dailyRateNum, 365) - 1) * 100).toFixed(2);

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
  processDueInterestForUser(user);
  const transactions = getUserTransactions(req.session.userId);
  const interestSummary = getInterestSummary(req.session.userId);
  const dailyRateNum = getInterestRate(user);
  const apy = ((Math.pow(1 + dailyRateNum, 365) - 1) * 100).toFixed(2);

  res.render('history', {
    user,
    transactions,
    interestTransactions: interestSummary.transactions,
    totalInterest: interestSummary.totalInterest,
    interestCredits: interestSummary.credits,
    error: req.query.error || null,
    success: req.query.success || null,
    dailyRate: dailyRateNum,
    apy
  });
});

app.post('/withdraw', requireLogin, (req, res) => {
  return res.redirect('/dashboard?error=You are currently ineligible to withdraw funds');
});

app.post('/transfer', requireLogin, async (req, res) => {
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
  await waitForPersistence();

  return res.redirect('/dashboard?message=Transfer completed successfully');
});

app.get('/admin', requireAdmin, (req, res) => {
  const users = [...state.users].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const transactions = [...state.transactions]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 20)
    .map((tx) => ({ ...tx, full_name: getUserById(tx.user_id)?.full_name || 'Unknown' }));

  const customers = users.filter((user) => !user.is_admin);
  const totalCustomerBalance = customers.reduce((sum, user) => sum + Number(user.balance || 0), 0);
  const totalInterestPaid = state.transactions
    .filter((tx) => tx.type === 'interest')
    .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const todayKey = new Date().toISOString().slice(0, 10);
  const transactionsToday = state.transactions.filter(
    (tx) => String(tx.created_at || '').slice(0, 10) === todayKey
  ).length;

  const adminStats = {
    customerCount: customers.length,
    totalCustomerBalance: Number(totalCustomerBalance.toFixed(6)),
    totalInterestPaid: Number(totalInterestPaid.toFixed(6)),
    transactionsToday
  };

  const messagesByUser = users.reduce((acc, user) => {
    acc[user.id] = getUserMessages(user.id);
    return acc;
  }, {});

  state.messages.forEach((msg) => {
    const userId = normalizeUserId(msg.user_id);
    if (!userId) return;
    if (!messagesByUser[userId]) {
      messagesByUser[userId] = [];
    }
    if (!messagesByUser[userId].some((existing) => existing.id === msg.id)) {
      messagesByUser[userId].push(msg);
    }
  });

  Object.keys(messagesByUser).forEach((userId) => {
    messagesByUser[userId].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  });

  res.render('admin', {
    users,
    transactions,
    messagesByUser,
    adminStats,
    error: req.query.error || null,
    success: req.query.message || null
  });
});

app.post('/admin/fund', requireAdmin, async (req, res) => {
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
  await waitForPersistence();

  return res.redirect('/admin?message=Funds added successfully');
});

app.post('/admin/interest-rate', requireAdmin, async (req, res) => {
  const { account_number, interest_rate } = req.body;
  const user = getUserByAccountNumber(account_number);
  const percentage = Number(interest_rate);

  if (!account_number || !Number.isFinite(percentage) || percentage < 0) {
    return res.redirect('/admin?error=Enter a valid account number and interest rate');
  }

  if (!user) {
    return res.redirect('/admin?error=Account not found');
  }

  // Settle any due interest under the old rate before changing it.
  processDueInterestForUser(user);
  user.interest_rate = percentage / 100;
  user.next_interest_at = new Date(Date.now() + INTEREST_INTERVAL_MS).toISOString();
  saveState();
  await waitForPersistence();

  return res.redirect('/admin?message=Interest rate updated successfully');
});

app.post('/admin/reply', requireAdmin, async (req, res) => {
  const { account_number, message } = req.body;
  const numericUser = getUserByAccountNumber(account_number);

  if (!account_number || !message || !message.trim()) {
    return res.redirect('/admin?error=Please provide an account number and reply message');
  }

  if (!numericUser) {
    return res.redirect('/admin?error=Account not found');
  }

  addMessage(numericUser.id, 'admin', message.trim());
  await waitForPersistence();
  return res.redirect('/admin?message=Reply sent successfully');
});

app.post('/account/update', requireLogin, async (req, res) => {
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
  await waitForPersistence();

  return res.redirect('/account?success=Account details updated');
});

app.post('/account/message', requireLogin, async (req, res) => {
  const { message } = req.body;
  const user = getUserById(req.session.userId);

  if (!message || !message.trim()) {
    return res.redirect('/account?error=Please enter a message');
  }

  const storedMessage = addMessage(user.id, 'customer', message.trim());
  if (!storedMessage) {
    return res.redirect('/account?error=Unable to send message right now');
  }

  await waitForPersistence();
  return res.redirect('/account?success=Message sent to customer care');
});

app.get('/api/cron/daily-interest', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await processDueInterestForAllUsers();
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Daily interest cron failed:', error);
    return res.status(500).json({ error: 'Daily interest processing failed' });
  }
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login?message=You have logged out');
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Smart Bank app is running on http://localhost:${port}`);
  });
}

module.exports = app;
