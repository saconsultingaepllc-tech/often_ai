/**
 * Often AI – Bank for Agents
 * Firebase Cloud Functions: auth, accounts, deposits,
 * transfers, currency conversion.
 *
 * ENV (must set before deploy):
 *   FIREBASE_WEB_API_KEY – project Web API Key
 *   ADMIN_API_KEY        – secret for admin operations
 */

const {setGlobalOptions} = require("firebase-functions");
const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

admin.initializeApp();
setGlobalOptions({maxInstances: 10});
const db = admin.firestore();

const API_KEY = process.env.FIREBASE_WEB_API_KEY;
if (!API_KEY) {
  throw new Error("Missing env var FIREBASE_WEB_API_KEY");
}

const CORS = {cors: true};

const SUPPORTED = ["USD", "USDC", "ETH", "BTC", "SOL"];
const UNITS = {
  USD: 1_000_000,
  USDC: 1_000_000,
  ETH: 1_000_000_000,
  BTC: 100_000_000,
  SOL: 1_000_000_000,
};

const EMPTY_BALANCES = Object.fromEntries(
    SUPPORTED.map((c) => [c, 0]),
);

/* ───────── exchange rate cache ───────── */

let rateCache = null;
let rateCacheExp = 0;
const RATE_TTL = 60_000;

/**
 * Fetch USD exchange rates for supported currencies.
 * @return {object} Map of currency → USD price
 */
async function getExchangeRates() {
  if (rateCache && Date.now() < rateCacheExp) {
    return rateCache;
  }
  const url =
    "https://api.coingecko.com/api/v3/simple/price" +
    "?ids=ethereum,bitcoin,solana,usd-coin" +
    "&vs_currencies=usd";
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (!d.ethereum) throw new Error("Bad CoinGecko resp");
    rateCache = {
      USD: 1,
      USDC: d["usd-coin"].usd,
      ETH: d.ethereum.usd,
      BTC: d.bitcoin.usd,
      SOL: d.solana.usd,
    };
    rateCacheExp = Date.now() + RATE_TTL;
    return rateCache;
  } catch (err) {
    if (rateCache) return rateCache; // stale fallback
    throw err;
  }
}

/* ───────── currency conversion (BigInt) ───────── */

/**
 * Convert an amount between two currencies using BigInt
 * to avoid overflow on intermediate products.
 * @param {string} from - Source currency
 * @param {string} to - Target currency
 * @param {number} amount - Amount in source smallest unit
 * @param {object} rates - USD prices per whole unit
 * @return {number} Amount in target smallest unit
 */
function convertCurrency(from, to, amount, rates) {
  if (from === to) return amount;
  // price in cents to keep integers
  const fromCents = BigInt(Math.round(rates[from] * 100));
  const toCents = BigInt(Math.round(rates[to] * 100));
  const a = BigInt(amount);
  const fromU = BigInt(UNITS[from]);
  const toU = BigInt(UNITS[to]);
  // a * (fromPrice / fromUnits) = USD value
  // USD value * (toUnits / toPrice) = target amount
  const result = (a * fromCents * toU) / (fromU * toCents);
  return Number(result);
}

/* ───────── auth helpers ───────── */

/**
 * Verify Firebase ID token from Authorization header.
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @return {object|null} Decoded token or null
 */
async function verifyIdToken(req, res) {
  const hdr = req.headers.authorization || "";
  if (!hdr.startsWith("Bearer ")) {
    res.status(401).json({error: "Unauthorized"});
    return null;
  }
  try {
    const decoded = await admin.auth()
        .verifyIdToken(hdr.substring(7));
    req.user = decoded;
    return decoded;
  } catch (err) {
    logger.error("Token verify failed", err);
    res.status(401).json({error: "Invalid token"});
    return null;
  }
}

/**
 * Check admin API key from X-Admin-Key header.
 * @param {object} req - Express request
 * @return {boolean} True if admin
 */
function isAdmin(req) {
  const key = process.env.ADMIN_API_KEY;
  return key && req.headers["x-admin-key"] === key;
}

/**
 * Sign in via Identity Toolkit and return tokens.
 * @param {string} email - User email
 * @param {string} password - User password
 * @return {object} Token payload
 */
async function signInWithPassword(email, password) {
  const url =
    "https://identitytoolkit.googleapis.com/v1/" +
    `accounts:signInWithPassword?key=${API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      email, password, returnSecureToken: true,
    }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
  };
}

/**
 * Basic email format check.
 * @param {string} v - Value to test
 * @return {boolean} Whether it looks like an email
 */
function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/* ═════════════════ AUTH ═════════════════ */

exports.signup = onRequest(CORS, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({error: "Use POST"});
  }
  const {email, password} = req.body || {};
  if (!email || !password) {
    return res.status(400).json({
      error: "email & password required",
    });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({
      error: "Invalid email format",
    });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({
      error: "Password must be >= 8 characters",
    });
  }

  try {
    const user = await admin.auth()
        .createUser({email, password});
    await db.doc(`accounts/${user.uid}`).set({
      balances: {...EMPTY_BALANCES},
      status: "active",
      email,
      createdAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });
    const tokens = await signInWithPassword(
        email, password,
    );
    return res.status(201).json({...tokens, uid: user.uid});
  } catch (err) {
    logger.error("Signup error", err);
    return res.status(400).json({error: err.message});
  }
});

exports.login = onRequest(CORS, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({error: "Use POST"});
  }
  const {email, password} = req.body || {};
  if (!email || !password) {
    return res.status(400).json({
      error: "email & password required",
    });
  }
  try {
    return res.json(
        await signInWithPassword(email, password),
    );
  } catch (err) {
    logger.error("Login error", err);
    return res.status(401).json({
      error: "Invalid email or password",
    });
  }
});

exports.refresh = onRequest(CORS, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({error: "Use POST"});
  }
  const {refreshToken} = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({
      error: "refreshToken required",
    });
  }
  try {
    const url =
      "https://securetoken.googleapis.com/v1/token" +
      `?key=${API_KEY}`;
    const r = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const d = await r.json();
    if (d.error) {
      return res.status(401).json({
        error: d.error.message,
      });
    }
    return res.json({
      idToken: d.id_token,
      refreshToken: d.refresh_token,
      expiresIn: d.expires_in,
    });
  } catch (err) {
    logger.error("Refresh error", err);
    return res.status(500).json({
      error: "Token refresh failed",
    });
  }
});

/* ═════════════════ ACCOUNT ═════════════════ */

exports.getAccount = onRequest(CORS, async (req, res) => {
  const user = await verifyIdToken(req, res);
  if (!user) return;

  const snap = await db.doc(`accounts/${user.uid}`).get();
  if (!snap.exists) {
    return res.status(404).json({
      error: "Account not found",
    });
  }
  const d = snap.data();
  return res.json({
    uid: user.uid,
    balances: d.balances,
    status: d.status,
    supportedCurrencies: SUPPORTED,
  });
});

exports.getTransactions = onRequest(
    CORS, async (req, res) => {
      const user = await verifyIdToken(req, res);
      if (!user) return;

      const limit = Math.min(
          parseInt(req.query.limit, 10) || 50, 100,
      );
      let q = db.collection("transactions")
          .where("accountId", "==", user.uid)
          .orderBy("createdAt", "desc")
          .limit(limit);

      if (req.query.startAfter) {
        const cur = await db.doc(
            `transactions/${req.query.startAfter}`,
        ).get();
        if (cur.exists) q = q.startAfter(cur);
      }

      const snaps = await q.get();
      const txs = snaps.docs.map((d) => ({
        id: d.id, ...d.data(),
      }));
      return res.json({transactions: txs});
    },
);

/* ═════════════════ DEPOSIT (admin) ═════════════════ */

exports.deposit = onRequest(CORS, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({error: "Use POST"});
  }
  if (!isAdmin(req)) {
    return res.status(403).json({error: "Forbidden"});
  }
  const {accountId, amount, currency} = req.body || {};
  if (
    !accountId ||
    typeof amount !== "number" ||
    amount <= 0
  ) {
    return res.status(400).json({
      error: "accountId and positive amount required",
    });
  }
  if (!SUPPORTED.includes(currency)) {
    return res.status(400).json({
      error: `Unsupported currency. Use: ${SUPPORTED}`,
    });
  }

  try {
    let balAfter;
    await db.runTransaction(async (tx) => {
      const ref = db.doc(`accounts/${accountId}`);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error("ACCOUNT_NOT_FOUND");
      }
      const bal = snap.data().balances || {};
      const cur = bal[currency] || 0;
      balAfter = cur + amount;

      tx.update(ref, {
        [`balances.${currency}`]: balAfter,
      });
      tx.create(db.collection("transactions").doc(), {
        accountId,
        type: "deposit",
        currency,
        amount,
        balanceBefore: cur,
        balanceAfter: balAfter,
        description: `${currency} deposit`,
        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.json({currency, balance: balAfter});
  } catch (err) {
    if (err.message === "ACCOUNT_NOT_FOUND") {
      return res.status(404).json({
        error: "Account not found",
      });
    }
    logger.error("Deposit error", err);
    return res.status(500).json({error: "Deposit failed"});
  }
});

/* ═════════════════ TRANSFER ═════════════════ */

exports.transfer = onRequest(CORS, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({error: "Use POST"});
  }
  const user = await verifyIdToken(req, res);
  if (!user) return;

  const {toAccountId, amount, currency, description} =
    req.body || {};
  if (
    !toAccountId ||
    typeof amount !== "number" ||
    amount <= 0
  ) {
    return res.status(400).json({
      error: "toAccountId and positive amount required",
    });
  }
  if (!SUPPORTED.includes(currency)) {
    return res.status(400).json({
      error: `Unsupported currency. Use: ${SUPPORTED}`,
    });
  }
  if (toAccountId === user.uid) {
    return res.status(400).json({
      error: "Cannot transfer to yourself",
    });
  }

  try {
    let senderAfter;
    await db.runTransaction(async (tx) => {
      const sRef = db.doc(`accounts/${user.uid}`);
      const rRef = db.doc(`accounts/${toAccountId}`);
      const [sSnap, rSnap] = await Promise.all([
        tx.get(sRef), tx.get(rRef),
      ]);
      if (!sSnap.exists) {
        throw new Error("SENDER_NOT_FOUND");
      }
      if (!rSnap.exists) {
        throw new Error("RECIPIENT_NOT_FOUND");
      }

      const sBal =
        (sSnap.data().balances || {})[currency] || 0;
      if (sBal < amount) {
        throw new Error("INSUFFICIENT_FUNDS");
      }
      const rBal =
        (rSnap.data().balances || {})[currency] || 0;
      senderAfter = sBal - amount;

      tx.update(sRef, {
        [`balances.${currency}`]: senderAfter,
      });
      tx.update(rRef, {
        [`balances.${currency}`]: rBal + amount,
      });

      const desc = description || "Transfer";
      tx.create(db.collection("transactions").doc(), {
        accountId: user.uid,
        type: "transfer_out",
        currency,
        amount,
        balanceBefore: sBal,
        balanceAfter: senderAfter,
        description: desc,
        metadata: {counterparty: toAccountId},
        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.create(db.collection("transactions").doc(), {
        accountId: toAccountId,
        type: "transfer_in",
        currency,
        amount,
        balanceBefore: rBal,
        balanceAfter: rBal + amount,
        description: desc,
        metadata: {counterparty: user.uid},
        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.json({currency, balance: senderAfter});
  } catch (err) {
    if (err.message === "INSUFFICIENT_FUNDS") {
      return res.status(402).json({
        error: "Insufficient funds",
      });
    }
    if (err.message === "RECIPIENT_NOT_FOUND") {
      return res.status(404).json({
        error: "Recipient account not found",
      });
    }
    logger.error("Transfer error", err);
    return res.status(500).json({
      error: "Transfer failed",
    });
  }
});

/* ═════════════════ CONVERT ═════════════════ */

exports.convert = onRequest(CORS, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({error: "Use POST"});
  }
  const user = await verifyIdToken(req, res);
  if (!user) return;

  const {from, to, amount} = req.body || {};
  if (
    !from || !to ||
    typeof amount !== "number" ||
    amount <= 0
  ) {
    return res.status(400).json({
      error: "from, to, and positive amount required",
    });
  }
  if (from === to) {
    return res.status(400).json({
      error: "Cannot convert to same currency",
    });
  }
  if (
    !SUPPORTED.includes(from) ||
    !SUPPORTED.includes(to)
  ) {
    return res.status(400).json({
      error: `Unsupported. Use: ${SUPPORTED}`,
    });
  }

  // Fetch rate OUTSIDE the transaction
  const rates = await getExchangeRates();
  const converted = convertCurrency(
      from, to, amount, rates,
  );
  if (converted <= 0) {
    return res.status(400).json({
      error: "Amount too small to convert",
    });
  }

  try {
    let balances;
    await db.runTransaction(async (tx) => {
      const ref = db.doc(`accounts/${user.uid}`);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error("ACCOUNT_NOT_FOUND");
      }
      const bals = snap.data().balances || {};
      const fromBal = bals[from] || 0;
      if (fromBal < amount) {
        throw new Error("INSUFFICIENT_FUNDS");
      }
      const toBal = bals[to] || 0;

      balances = {
        ...bals,
        [from]: fromBal - amount,
        [to]: toBal + converted,
      };
      tx.update(ref, {
        [`balances.${from}`]: fromBal - amount,
        [`balances.${to}`]: toBal + converted,
      });
      tx.create(db.collection("transactions").doc(), {
        accountId: user.uid,
        type: "conversion",
        currency: from,
        amount,
        balanceBefore: fromBal,
        balanceAfter: fromBal - amount,
        description: `Convert ${from} → ${to}`,
        metadata: {
          fromCurrency: from,
          toCurrency: to,
          fromAmount: amount,
          toAmount: converted,
          rateUsed: rates[from] / rates[to],
        },
        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.json({
      converted: {
        from: {currency: from, amount},
        to: {currency: to, amount: converted},
      },
      balances,
    });
  } catch (err) {
    if (err.message === "INSUFFICIENT_FUNDS") {
      return res.status(402).json({
        error: "Insufficient funds",
      });
    }
    logger.error("Convert error", err);
    return res.status(500).json({
      error: "Conversion failed",
    });
  }
});

/* ═══════════ Expose internals for testing ═══════════ */

exports._test = {
  isValidEmail,
  convertCurrency,
  isAdmin,
  UNITS,
  SUPPORTED,
  EMPTY_BALANCES,
};
