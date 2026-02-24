/**
 * Often AI – Multi-LLM Proxy with balance billing
 *
 * Routes to: OpenAI, Anthropic, Google, Mistral, Together
 * Agents authenticate with Firebase ID tokens.
 * Usage billed in USD microdollars from agent balance.
 *
 * ENV:
 *   GCP_PROJECT – GCP project ID (Secret Manager)
 *   PORT        – server port (default 8080)
 */

const express = require("express");
const {SecretManagerServiceClient} = require("@google-cloud/secret-manager");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();
const sm = new SecretManagerServiceClient();

/* ═══════════ Provider config ═══════════ */

const PROVIDERS = {
  openai: {
    baseUrl: "https://api.openai.com/v1/chat/completions",
    secret: "OPENAI_API_KEY",
    headers: (k) => ({Authorization: `Bearer ${k}`}),
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1/messages",
    secret: "ANTHROPIC_API_KEY",
    headers: (k) => ({
      "x-api-key": k,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    }),
    translate: true,
  },
  google: {
    baseUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    secret: "GOOGLE_API_KEY",
    headers: (k) => ({Authorization: `Bearer ${k}`}),
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    secret: "MISTRAL_API_KEY",
    headers: (k) => ({Authorization: `Bearer ${k}`}),
  },
  together: {
    baseUrl: "https://api.together.xyz/v1/chat/completions",
    secret: "TOGETHER_API_KEY",
    headers: (k) => ({Authorization: `Bearer ${k}`}),
  },
};

function detectProvider(model) {
  if (/^(gpt-|o1|o3|o4)/.test(model)) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("mistral-")) return "mistral";
  return "together";
}

/* ═══════════ Pricing (microdollars per 1M tokens) ═══════════ */

const PRICING = {
  // OpenAI
  "gpt-4o": {input: 2_500_000, output: 10_000_000},
  "gpt-4o-mini": {input: 150_000, output: 600_000},
  "gpt-4-turbo": {input: 10_000_000, output: 30_000_000},
  "gpt-3.5-turbo": {input: 500_000, output: 1_500_000},
  "o1": {input: 15_000_000, output: 60_000_000},
  "o1-mini": {input: 3_000_000, output: 12_000_000},
  "o3-mini": {input: 1_100_000, output: 4_400_000},
  // Anthropic
  "claude-sonnet-4-20250514": {input: 3_000_000, output: 15_000_000},
  "claude-opus-4-20250514": {input: 15_000_000, output: 75_000_000},
  "claude-haiku-4-20250414": {input: 800_000, output: 4_000_000},
  "claude-3-5-sonnet-20241022": {input: 3_000_000, output: 15_000_000},
  "claude-3-5-haiku-20241022": {input: 800_000, output: 4_000_000},
  // Google
  "gemini-2.5-pro": {input: 1_250_000, output: 10_000_000},
  "gemini-2.5-flash": {input: 150_000, output: 600_000},
  "gemini-2.0-flash": {input: 100_000, output: 400_000},
  // Mistral
  "mistral-large-latest": {input: 2_000_000, output: 6_000_000},
  "mistral-small-latest": {input: 200_000, output: 600_000},
  // Together (open source)
  "meta-llama/Llama-3.1-70B-Instruct-Turbo": {input: 880_000, output: 880_000},
  "meta-llama/Llama-3.1-8B-Instruct-Turbo": {input: 180_000, output: 180_000},
  "deepseek-ai/DeepSeek-V3": {input: 900_000, output: 900_000},
};
const DEFAULT_PRICING = {input: 2_500_000, output: 10_000_000};
const MIN_BALANCE_MICROS = 1000; // $0.001

function calculateCostMicros(model, promptTokens, completionTokens) {
  const p = PRICING[model] || DEFAULT_PRICING;
  const cost = (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
  return Math.ceil(cost);
}

/* ═══════════ Secret Manager cache ═══════════ */

const keyCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function getApiKey(secretName) {
  const cached = keyCache.get(secretName);
  if (cached && Date.now() < cached.expiry) return cached.key;
  const [version] = await sm.accessSecretVersion({
    name: `projects/${process.env.GCP_PROJECT}/secrets/${secretName}/versions/latest`,
  });
  const key = version.payload.data.toString("utf8");
  keyCache.set(secretName, {key, expiry: Date.now() + CACHE_TTL});
  return key;
}

/* ═══════════ Anthropic translation ═══════════ */

const ANTHROPIC_MAX_TOKENS = {
  "claude-sonnet-4-20250514": 8192,
  "claude-opus-4-20250514": 8192,
  "claude-haiku-4-20250414": 8192,
  "claude-3-5-sonnet-20241022": 8192,
  "claude-3-5-haiku-20241022": 8192,
};

function toAnthropicRequest(body) {
  const {messages, model, max_tokens, temperature, top_p, stop} = body;

  // Extract system messages
  let system;
  const filtered = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? system + "\n" + m.content : m.content;
    } else {
      // Merge consecutive same-role messages
      const last = filtered[filtered.length - 1];
      if (last && last.role === m.role) {
        last.content += "\n" + m.content;
      } else {
        filtered.push({role: m.role, content: m.content});
      }
    }
  }

  const req = {
    model,
    messages: filtered,
    max_tokens: max_tokens || ANTHROPIC_MAX_TOKENS[model] || 4096,
  };
  if (system) req.system = system;
  if (temperature !== undefined) req.temperature = temperature;
  if (top_p !== undefined) req.top_p = top_p;
  if (stop) {
    req.stop_sequences = Array.isArray(stop) ? stop : [stop];
  }
  return req;
}

const STOP_REASON_MAP = {
  "end_turn": "stop",
  "max_tokens": "length",
  "stop_sequence": "stop",
  "tool_use": "tool_calls",
};

function fromAnthropicResponse(data) {
  return {
    id: data.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: data.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(""),
      },
      finish_reason: STOP_REASON_MAP[data.stop_reason] || data.stop_reason,
    }],
    usage: {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    },
  };
}

/* ═══════════ Auth middleware ═══════════ */

async function authenticate(req, res, next) {
  const hdr = req.headers.authorization || "";
  if (!hdr.startsWith("Bearer ")) {
    return res.status(401).json({error: "Missing Authorization header"});
  }
  try {
    req.user = await admin.auth().verifyIdToken(hdr.substring(7));
    next();
  } catch (err) {
    return res.status(401).json({error: "Invalid or expired token"});
  }
}

/* ═══════════ Express app ═══════════ */

const app = express();
app.use(express.json({limit: "1mb"}));

// Health check
app.get("/health", (_req, res) => res.json({status: "ok"}));

// List available models with pricing
app.get("/v1/models", (_req, res) => {
  const models = Object.entries(PRICING).map(([id, p]) => ({
    id,
    provider: detectProvider(id),
    pricing: {
      input_per_million_tokens_usd: p.input / 1_000_000,
      output_per_million_tokens_usd: p.output / 1_000_000,
    },
  }));
  return res.json({models});
});

// Chat completions proxy
app.post("/v1/chat/completions", authenticate, async (req, res) => {
  const uid = req.user.uid;
  const model = req.body.model;

  if (!model) {
    return res.status(400).json({error: "model is required"});
  }

  // Reject tool_calls for Anthropic (not supported in translation layer)
  const providerName = detectProvider(model);
  if (providerName === "anthropic" && req.body.tools) {
    return res.status(400).json({
      error: "Tool use with Claude models is not yet supported through the proxy",
    });
  }

  const accountRef = db.doc(`accounts/${uid}`);

  // Pre-check USD balance
  const accountSnap = await accountRef.get();
  if (!accountSnap.exists) {
    return res.status(404).json({error: "Account not found"});
  }
  const balances = accountSnap.data().balances || {};
  if ((balances.USD || 0) < MIN_BALANCE_MICROS) {
    return res.status(402).json({
      error: "Insufficient USD balance. Convert or deposit USD first.",
    });
  }

  // Get provider API key
  const provider = PROVIDERS[providerName];
  let apiKey;
  try {
    apiKey = await getApiKey(provider.secret);
  } catch (err) {
    console.error(`No API key for ${providerName}:`, err.message);
    return res.status(503).json({error: `${providerName} is not configured`});
  }

  try {
    // Prepare request (translate for Anthropic)
    const requestBody = provider.translate ? toAnthropicRequest(req.body) : req.body;

    // Call provider
    const response = await axios.post(provider.baseUrl, requestBody, {
      headers: provider.headers(apiKey),
      timeout: 120_000,
    });

    // Translate response back if needed
    const result = provider.translate ? fromAnthropicResponse(response.data) : response.data;

    // Calculate cost from usage
    const usage = result.usage;
    const costMicros = calculateCostMicros(
      result.model,
      usage.prompt_tokens,
      usage.completion_tokens,
    );

    // Deduct from USD balance atomically
    let balanceAfter;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(accountRef);
      const current = (snap.data().balances || {}).USD || 0;
      if (current < costMicros) throw new Error("INSUFFICIENT_FUNDS");
      balanceAfter = current - costMicros;

      tx.update(accountRef, {"balances.USD": balanceAfter});
      tx.create(db.collection("transactions").doc(), {
        accountId: uid,
        type: "llm_usage",
        currency: "USD",
        amount: costMicros,
        balanceBefore: current,
        balanceAfter,
        description: `${result.model} completion`,
        metadata: {
          provider: providerName,
          model: result.model,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Billing in headers — response body stays provider-compatible
    res.set("X-Often-Cost-Micros", costMicros.toString());
    res.set("X-Often-Balance-Micros", balanceAfter.toString());
    res.set("X-Often-Provider", providerName);
    res.json(result);
  } catch (e) {
    if (e.message === "INSUFFICIENT_FUNDS") {
      return res.status(402).json({error: "Insufficient USD balance"});
    }
    // Forward provider errors with context
    if (e.response) {
      console.error(`${providerName} error:`, e.response.status, e.response.data);
      return res.status(e.response.status).json({
        error: `${providerName} API error`,
        detail: e.response.data?.error?.message || e.response.data,
      });
    }
    console.error("Proxy error:", e.message);
    res.status(500).json({error: "Internal error"});
  }
});

/* ═══════════ Exports for testing ═══════════ */

module.exports = {
  app,
  calculateCostMicros,
  detectProvider,
  toAnthropicRequest,
  fromAnthropicResponse,
  PRICING,
  DEFAULT_PRICING,
  MIN_BALANCE_MICROS,
};

if (require.main === module) {
  const PORT = parseInt(process.env.PORT, 10) || 8080;
  app.listen(PORT, () => console.log(`often-ai proxy listening on port ${PORT}`));
}
