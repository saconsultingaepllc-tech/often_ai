/**
 * Integration Tests – LLM Proxy
 *
 * Tests the full proxy behavior with mocked Firebase & LLM APIs.
 *
 * Covers:
 *  - Auth rejection (no token, expired, fabricated)
 *  - Balance pre-check & insufficient funds
 *  - Successful completion with billing headers
 *  - Race condition: 50 concurrent requests with $0.01 balance
 *  - Payload manipulation (billing based on response, not request)
 *  - Provider routing (OpenAI, Anthropic, Mistral, etc.)
 *  - Admin endpoint hardening
 */

const request = require("supertest");

/* ═══════════ Shared mutable "database" state ═══════════ */

let accountExists = true;
let accountBalance = 1_000_000; // $1 in micros
let transactionLog = [];
let txQueue = Promise.resolve(); // serializes mock Firestore transactions

/* ═══════════ Mock firebase-admin ═══════════ */

const mockVerifyIdToken = jest.fn();

const mockDb = {
  doc: jest.fn(() => ({
    get: jest.fn(async () => ({
      exists: accountExists,
      data: () => ({balances: {USD: accountBalance}}),
    })),
  })),
  collection: jest.fn(() => ({
    doc: jest.fn(() => ({id: `tx-${Date.now()}`})),
  })),
  runTransaction: jest.fn(async (fn) => {
    // Serialize transactions to mimic Firestore's row-level locking
    let release;
    const prev = txQueue;
    txQueue = new Promise((r) => (release = r));
    await prev;

    try {
      const snap = {
        exists: accountExists,
        data: () => ({balances: {USD: accountBalance}}),
      };
      const tx = {
        get: jest.fn().mockResolvedValue(snap),
        update: jest.fn((_, data) => {
          if (data["balances.USD"] !== undefined) {
            accountBalance = data["balances.USD"];
          }
        }),
        create: jest.fn((_, data) => transactionLog.push(data)),
      };
      await fn(tx);
    } finally {
      release();
    }
  }),
};

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  firestore: Object.assign(jest.fn(() => mockDb), {
    FieldValue: {serverTimestamp: jest.fn(() => new Date())},
  }),
  auth: jest.fn(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

/* ═══════════ Mock Secret Manager ═══════════ */

jest.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion: jest.fn().mockResolvedValue([{
      payload: {data: Buffer.from("sk-test-mock-key-12345")},
    }]),
  })),
}));

/* ═══════════ Mock axios (LLM API calls) ═══════════ */

const axios = require("axios");
jest.mock("axios");

function mockOpenAIResponse(model = "gpt-4o", promptTokens = 100, completionTokens = 50) {
  return {
    data: {
      id: "chatcmpl-abc123",
      object: "chat.completion",
      model,
      choices: [{
        index: 0,
        message: {role: "assistant", content: "Hello! How can I help?"},
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
  };
}

function mockAnthropicResponse(model = "claude-sonnet-4-20250514", inputTokens = 100, outputTokens = 50) {
  return {
    data: {
      id: "msg_123",
      type: "message",
      model,
      stop_reason: "end_turn",
      content: [{type: "text", text: "Hello from Claude!"}],
      usage: {input_tokens: inputTokens, output_tokens: outputTokens},
    },
  };
}

/* ═══════════ Load the app ═══════════ */

const {app, calculateCostMicros} = require("../index");

/* ═══════════ Setup ═══════════ */

beforeEach(() => {
  accountExists = true;
  accountBalance = 1_000_000; // $1
  transactionLog = [];
  txQueue = Promise.resolve();
  jest.clearAllMocks();

  mockVerifyIdToken.mockImplementation(async (token) => {
    if (token === "valid-token") return {uid: "agent-1"};
    if (token === "expired-token") throw new Error("Token expired");
    throw new Error("Invalid token");
  });

  axios.post.mockResolvedValue(mockOpenAIResponse());
});

/* ═══════════════════════════════════════════════
   1. Health Check
   ═══════════════════════════════════════════════ */

describe("GET /health", () => {
  test("returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

/* ═══════════════════════════════════════════════
   2. Models Endpoint
   ═══════════════════════════════════════════════ */

describe("GET /v1/models", () => {
  test("lists all supported models with pricing", async () => {
    const res = await request(app).get("/v1/models");
    expect(res.status).toBe(200);
    expect(res.body.models.length).toBeGreaterThan(0);

    const gpt4o = res.body.models.find((m) => m.id === "gpt-4o");
    expect(gpt4o).toBeDefined();
    expect(gpt4o.provider).toBe("openai");
    expect(gpt4o.pricing.input_per_million_tokens_usd).toBe(2.5);
    expect(gpt4o.pricing.output_per_million_tokens_usd).toBe(10);

    const claude = res.body.models.find((m) => m.id === "claude-sonnet-4-20250514");
    expect(claude).toBeDefined();
    expect(claude.provider).toBe("anthropic");
  });
});

/* ═══════════════════════════════════════════════
   3. Auth & Gateway Security (Ghost Token Tests)
   ═══════════════════════════════════════════════ */

describe("authentication", () => {
  test("rejects request with no Authorization header", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(401);
    // Must NOT have called the LLM API
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("rejects request with malformed Authorization header", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(401);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("rejects expired Firebase token", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer expired-token")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired|invalid/i);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("rejects fabricated JWT", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJoYWNrZXIifQ.fake")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(401);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("all auth failures happen BEFORE any LLM API call", async () => {
    // Fire multiple bad auth requests
    await Promise.all([
      request(app).post("/v1/chat/completions").send({model: "gpt-4o", messages: []}),
      request(app).post("/v1/chat/completions").set("Authorization", "Bearer expired-token").send({model: "gpt-4o", messages: []}),
      request(app).post("/v1/chat/completions").set("Authorization", "Bearer fabricated").send({model: "gpt-4o", messages: []}),
    ]);

    expect(axios.post).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════
   4. Balance Checks
   ═══════════════════════════════════════════════ */

describe("balance validation", () => {
  test("rejects when account not found (404)", async () => {
    accountExists = false;

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(404);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("rejects when USD balance below minimum (402)", async () => {
    accountBalance = 500; // $0.0005 — below MIN_BALANCE_MICROS ($0.001)

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/insufficient/i);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("rejects when balance is exactly zero", async () => {
    accountBalance = 0;

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(402);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("requires model field", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/i);
  });
});

/* ═══════════════════════════════════════════════
   5. Successful Completion (OpenAI)
   ═══════════════════════════════════════════════ */

describe("successful OpenAI completion", () => {
  test("returns LLM response with billing headers", async () => {
    axios.post.mockResolvedValueOnce(mockOpenAIResponse("gpt-4o", 100, 50));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gpt-4o", messages: [{role: "user", content: "Hello"}]});

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("Hello! How can I help?");
    expect(res.body.model).toBe("gpt-4o");

    // Billing headers
    const costMicros = calculateCostMicros("gpt-4o", 100, 50);
    expect(res.headers["x-often-cost-micros"]).toBe(costMicros.toString());
    expect(res.headers["x-often-balance-micros"]).toBe(
      (1_000_000 - costMicros).toString(),
    );
    expect(res.headers["x-often-provider"]).toBe("openai");

    // Verify balance was deducted
    expect(accountBalance).toBe(1_000_000 - costMicros);

    // Verify transaction record
    expect(transactionLog).toHaveLength(1);
    expect(transactionLog[0].type).toBe("llm_usage");
    expect(transactionLog[0].amount).toBe(costMicros);
    expect(transactionLog[0].metadata.model).toBe("gpt-4o");
    expect(transactionLog[0].metadata.provider).toBe("openai");
  });

  test("balance header matches database after deduction", async () => {
    accountBalance = 5_000_000; // $5
    axios.post.mockResolvedValueOnce(mockOpenAIResponse("gpt-4o", 200, 100));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gpt-4o", messages: [{role: "user", content: "test"}]});

    expect(res.status).toBe(200);
    const balanceFromHeader = parseInt(res.headers["x-often-balance-micros"], 10);
    expect(balanceFromHeader).toBe(accountBalance);
  });
});

/* ═══════════════════════════════════════════════
   6. Successful Completion (Anthropic routing)
   ═══════════════════════════════════════════════ */

describe("Anthropic model routing", () => {
  test("routes Claude model to Anthropic API and translates response", async () => {
    axios.post.mockResolvedValueOnce(
      mockAnthropicResponse("claude-sonnet-4-20250514", 100, 50),
    );

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({
        model: "claude-sonnet-4-20250514",
        messages: [{role: "user", content: "Hello"}],
      });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("Hello from Claude!");
    expect(res.headers["x-often-provider"]).toBe("anthropic");

    // Verify it called the Anthropic API URL (not OpenAI)
    const callUrl = axios.post.mock.calls[0][0];
    expect(callUrl).toContain("anthropic.com");

    // Verify billing uses Anthropic pricing
    const cost = calculateCostMicros("claude-sonnet-4-20250514", 100, 50);
    expect(res.headers["x-often-cost-micros"]).toBe(cost.toString());
  });

  test("rejects tool_calls for Anthropic models", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({
        model: "claude-sonnet-4-20250514",
        messages: [{role: "user", content: "Hello"}],
        tools: [{type: "function", function: {name: "test"}}],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tool use/i);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════
   7. Payload Manipulation (Billing Integrity)
   ═══════════════════════════════════════════════ */

describe("payload manipulation defense", () => {
  test("bills based on RESPONSE model, not request model", async () => {
    // Agent requests gpt-3.5-turbo (cheap) but somehow the response says gpt-4o
    axios.post.mockResolvedValueOnce(mockOpenAIResponse("gpt-4o", 100, 50));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gpt-3.5-turbo", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(200);
    // Should bill at gpt-4o rate (from response), not gpt-3.5-turbo rate
    const gpt4oCost = calculateCostMicros("gpt-4o", 100, 50);
    expect(res.headers["x-often-cost-micros"]).toBe(gpt4oCost.toString());
  });

  test("bills based on ACTUAL token usage from API response", async () => {
    // Agent sends a huge prompt but API reports small usage
    axios.post.mockResolvedValueOnce(mockOpenAIResponse("gpt-4o", 10, 5));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({
        model: "gpt-4o",
        messages: [{role: "user", content: "x".repeat(100000)}],
      });

    expect(res.status).toBe(200);
    const cost = calculateCostMicros("gpt-4o", 10, 5);
    expect(res.headers["x-often-cost-micros"]).toBe(cost.toString());
  });
});

/* ═══════════════════════════════════════════════
   8. Insufficient Funds DURING Transaction
   ═══════════════════════════════════════════════ */

describe("post-call insufficient funds", () => {
  test("returns 402 if balance drops between pre-check and deduction", async () => {
    // Balance passes pre-check but is drained by time of transaction
    accountBalance = 2000; // Just above MIN_BALANCE_MICROS

    // Override runTransaction to simulate concurrent drain
    mockDb.runTransaction.mockImplementationOnce(async (fn) => {
      const snap = {
        exists: true,
        data: () => ({balances: {USD: 0}}), // Balance already drained
      };
      const tx = {
        get: jest.fn().mockResolvedValue(snap),
        update: jest.fn(),
        create: jest.fn(),
      };
      await fn(tx); // Will throw INSUFFICIENT_FUNDS
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(402);
  });
});

/* ═══════════════════════════════════════════════
   9. THE RACE CONDITION – "Infinite Money" Exploit
   ═══════════════════════════════════════════════ */

describe("race condition: 50 concurrent requests", () => {
  test("exactly 1 succeeds, 49 fail, balance never negative", async () => {
    // Seed: agent has exactly $0.01 (10,000 micros)
    accountBalance = 10_000;

    // Each call costs ~750 micros at gpt-4o with 100 input + 50 output
    // But we make each call cost exactly 10,000 micros to simplify
    // 4000 input tokens at gpt-4o: (4000 * 2_500_000) / 1_000_000 = 10,000
    axios.post.mockImplementation(async () => mockOpenAIResponse("gpt-4o", 4000, 0));

    // Fire 50 concurrent requests
    const promises = Array.from({length: 50}, () =>
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer valid-token")
        .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]}),
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.status === 200);
    const failures = results.filter((r) => r.status === 402);

    // The Firestore transaction serialization ensures:
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(49);

    // Balance must be EXACTLY 0, never negative
    expect(accountBalance).toBe(0);

    // Only one transaction record should exist
    expect(transactionLog).toHaveLength(1);
    expect(transactionLog[0].type).toBe("llm_usage");
  }, 30000);

  test("balance never goes negative with varying costs", async () => {
    accountBalance = 5_000; // $0.005

    // Each call costs ~750 micros (100 prompt + 50 completion at gpt-4o)
    axios.post.mockImplementation(async () => mockOpenAIResponse("gpt-4o", 100, 50));

    const cost = calculateCostMicros("gpt-4o", 100, 50); // 750

    const promises = Array.from({length: 20}, () =>
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer valid-token")
        .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]}),
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.status === 200);

    // $0.005 / $0.00075 per call = 6.67 → at most 6 can succeed
    expect(successes.length).toBeLessThanOrEqual(Math.floor(5_000 / cost));
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Balance must never be negative
    expect(accountBalance).toBeGreaterThanOrEqual(0);

    // Verify total deducted matches transaction count
    const totalDeducted = transactionLog.reduce((sum, t) => sum + t.amount, 0);
    expect(totalDeducted).toBe(5_000 - accountBalance);
  }, 30000);
});

/* ═══════════════════════════════════════════════
   10. Provider Error Forwarding
   ═══════════════════════════════════════════════ */

describe("provider error handling", () => {
  test("forwards LLM API error status code", async () => {
    axios.post.mockRejectedValueOnce({
      response: {
        status: 429,
        data: {error: {message: "Rate limit exceeded"}},
      },
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/openai.*error/i);
  });

  test("returns 500 for unexpected proxy errors", async () => {
    axios.post.mockRejectedValueOnce(new Error("Network timeout"));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gpt-4o", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(500);
  });
});

/* ═══════════════════════════════════════════════
   11. Provider Routing Correctness
   ═══════════════════════════════════════════════ */

describe("multi-provider routing", () => {
  test("Gemini model routes to Google API", async () => {
    axios.post.mockResolvedValueOnce(mockOpenAIResponse("gemini-2.5-pro", 100, 50));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "gemini-2.5-pro", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(200);
    expect(res.headers["x-often-provider"]).toBe("google");
    const callUrl = axios.post.mock.calls[0][0];
    expect(callUrl).toContain("generativelanguage.googleapis.com");
  });

  test("Mistral model routes to Mistral API", async () => {
    axios.post.mockResolvedValueOnce(mockOpenAIResponse("mistral-large-latest", 100, 50));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({model: "mistral-large-latest", messages: [{role: "user", content: "hi"}]});

    expect(res.status).toBe(200);
    expect(res.headers["x-often-provider"]).toBe("mistral");
    const callUrl = axios.post.mock.calls[0][0];
    expect(callUrl).toContain("mistral.ai");
  });

  test("Together model routes to Together API", async () => {
    axios.post.mockResolvedValueOnce(
      mockOpenAIResponse("meta-llama/Llama-3.1-70B-Instruct-Turbo", 100, 50),
    );

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer valid-token")
      .send({
        model: "meta-llama/Llama-3.1-70B-Instruct-Turbo",
        messages: [{role: "user", content: "hi"}],
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-often-provider"]).toBe("together");
    const callUrl = axios.post.mock.calls[0][0];
    expect(callUrl).toContain("together.xyz");
  });
});
