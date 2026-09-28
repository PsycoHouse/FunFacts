import test from "node:test";
import assert from "node:assert/strict";
import worker, { RateLimiter } from "../worker/src/index.js";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

globalThis.crypto ||= webcrypto;
const origin = "https://example.github.io";
const encoder = new TextEncoder();

class MemoryStorage {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

function limiterNamespace() {
  const object = new RateLimiter({ storage: new MemoryStorage() });
  return { idFromName: (name) => name, get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) };
}

function b64url(bytes) { return Buffer.from(bytes).toString("base64url"); }
async function signedToken(payload, secret) {
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))))}`;
}
function request(path, body = {}, token = "") {
  return new Request(`https://worker.test${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}

test("frontend sends the documented JSON login fields and content type", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /headers:\s*\{\s*"Content-Type":\s*"application\/json"/);
  assert.match(source, /api\("\/login",\s*\{\s*body:\s*\{\s*username:[^,]+,\s*password:/);
});

test("login distinguishes malformed input from authentication configuration errors", async () => {
  const validEnv = { ALLOWED_ORIGIN: origin, APP_USER_ID: "AJT", APP_PASSWORD: "password", APP_AUTH_SECRET: "secret", RATE_LIMITER: limiterNamespace() };
  const malformed = new Request("https://worker.test/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{" });
  assert.equal((await worker.fetch(malformed, validEnv)).status, 401);
  assert.equal((await worker.fetch(request("/login", { username: "AJT", password: "password", extra: true }), validEnv)).status, 401);

  const missingUser = { ...validEnv, APP_USER_ID: undefined };
  const response = await worker.fetch(request("/login", { username: "AJT", password: "password" }), missingUser);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Authentication configuration error" });

  const wrongContentType = new Request("https://worker.test/login", { method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal((await worker.fetch(wrongContentType, validEnv)).status, 415);
});

test("CORS accepts GitHub origins regardless of hostname casing", async () => {
  const response = await worker.fetch(new Request("https://worker.test/login", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" }
  }), { ALLOWED_ORIGIN: "https://Example.github.io" });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type, Authorization");
  assert.equal(response.headers.get("Access-Control-Max-Age"), "86400");
  assert.equal(response.headers.get("Vary"), "Origin");
});

test("CORS defaults to the production Pages origin and is present on errors", async () => {
  const productionOrigin = "https://psycohouse.github.io";
  const preflight = await worker.fetch(new Request("https://worker.test/login", {
    method: "OPTIONS",
    headers: {
      Origin: productionOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization"
    }
  }), {});

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), productionOrigin);

  const cases = [
    new Request("https://worker.test/fact", { method: "POST", headers: { Origin: productionOrigin, "Content-Type": "application/json" }, body: "{" }),
    new Request("https://worker.test/fact", { method: "POST", headers: { Origin: productionOrigin, "Content-Type": "application/json" }, body: "{}" }),
    new Request("https://worker.test/login", { method: "POST", headers: { Origin: productionOrigin, "Content-Type": "application/json" }, body: "{}" }),
    new Request("https://worker.test/login", { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" })
  ];
  const expectedStatuses = [500, 500, 500, 403];

  for (const [index, apiRequest] of cases.entries()) {
    const response = await worker.fetch(apiRequest, {});
    assert.equal(response.status, expectedStatuses[index]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), productionOrigin);
    assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), "*");
  }
});

test("authentication, token validation, daily limit and protected OpenAI call", async () => {
  const env = { ALLOWED_ORIGIN: origin, APP_USER_ID: "AJT", APP_PASSWORD: "correct horse", APP_AUTH_SECRET: "a-long-test-secret", OPENAI_API_KEY: "server-only", RATE_LIMITER: limiterNamespace() };
  assert.equal((await worker.fetch(request("/fact"), env)).status, 401);
  assert.equal((await worker.fetch(request("/login", { username: "AJT", password: "wrong" }), env)).status, 401);

  const login = await worker.fetch(request("/login", { username: "AJT", password: "correct horse" }), env);
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);
  assert.equal((await worker.fetch(request("/fact", {}, `${token}x`), env)).status, 401);
  const expired = await signedToken({ user: "AJT", exp: Math.floor(Date.now() / 1000) - 1 }, env.APP_AUTH_SECRET);
  assert.equal((await worker.fetch(request("/fact", {}, expired), env)).status, 401);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    return new Response(JSON.stringify({ output_text: JSON.stringify({ id: "octopus_three_hearts", fact: "Oktopusse besitzen drei Herzen.", category: "Tiere" }) }), { status: 200 });
  };
  const originalRandom = Math.random;
  Math.random = () => 0.1; // Tiere
  try {
    for (let used = 1; used <= 20; used += 1) {
      const response = await worker.fetch(request("/fact", {}, token), env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).remaining, 20 - used);
    }
    const limited = await worker.fetch(request("/fact", {}, token), env);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "Tageslimit erreicht", remaining: 0 });
  } finally { globalThis.fetch = originalFetch; Math.random = originalRandom; }
});

test("login compares APP_USER_ID and APP_PASSWORD exactly, including whitespace", async () => {
  const env = {
    ALLOWED_ORIGIN: origin,
    APP_USER_ID: "\n AJT \t",
    APP_PASSWORD: " correct horse ",
    APP_AUTH_SECRET: "a-long-test-secret",
    RATE_LIMITER: limiterNamespace()
  };

  assert.equal((await worker.fetch(request("/login", { username: "AJT", password: "correct horse" }), env)).status, 401);
  assert.equal((await worker.fetch(request("/login", { username: env.APP_USER_ID, password: env.APP_PASSWORD }), env)).status, 200);
});

test("location facts validate coordinates and add local context without exposing them in the result", async () => {
  const env = { ALLOWED_ORIGIN: origin, APP_USER_ID: "AJT", APP_AUTH_SECRET: "secret", OPENAI_API_KEY: "server-only", RATE_LIMITER: limiterNamespace() };
  const token = await signedToken({ user: "AJT", exp: Math.floor(Date.now() / 1000) + 60 }, env.APP_AUTH_SECRET);
  assert.equal((await worker.fetch(request("/fact", { location: { latitude: 91, longitude: 13 } }, token), env)).status, 400);
  assert.equal((await worker.fetch(request("/fact", { location: { latitude: 52, longitude: 13 }, extra: true }, token), env)).status, 400);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.match(payload.input, /52\.52, 13\.405/);
    assert.match(payload.input, /category muss exakt Vor Ort sein/);
    return new Response(JSON.stringify({ output_text: JSON.stringify({ id: "berlin_museum_island", fact: "Die Berliner Museumsinsel gehört zum UNESCO-Welterbe.", category: "Vor Ort" }) }), { status: 200 });
  };
  try {
    const response = await worker.fetch(request("/fact", { location: { latitude: 52.52, longitude: 13.405 } }, token), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).category, "Vor Ort");
  } finally { globalThis.fetch = originalFetch; }
});

test("fact uses the Responses API request shape and parses nested output text", async () => {
  const env = { ALLOWED_ORIGIN: origin, APP_USER_ID: "AJT", APP_AUTH_SECRET: "secret", OPENAI_API_KEY: "server-only", OPENAI_MODEL: "gpt-5-mini", RATE_LIMITER: limiterNamespace() };
  const token = await signedToken({ user: "AJT", exp: Math.floor(Date.now() / 1000) + 60 }, env.APP_AUTH_SECRET);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer server-only");
    assert.equal(init.headers["Content-Type"], "application/json");
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, "gpt-5-mini");
    assert.equal(payload.text.format.type, "json_schema");
    assert.equal(payload.text.format.strict, true);
    assert.equal("max_output_tokens" in payload, false);
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ id: "moon_dust", fact: "Mondstaub riecht nach Aussagen von Astronauten wie Schießpulver.", category: "Weltraum" }) }] }]
    }), { status: 200 });
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const response = await worker.fetch(request("/fact", {}, token), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, "moon_dust");
  } finally { globalThis.fetch = originalFetch; Math.random = originalRandom; }
});

test("fact safely logs and preserves actionable OpenAI error statuses", async () => {
  const env = { ALLOWED_ORIGIN: origin, APP_USER_ID: "AJT", APP_AUTH_SECRET: "secret", OPENAI_API_KEY: "do-not-log-this-key", RATE_LIMITER: limiterNamespace() };
  const token = await signedToken({ user: "AJT", exp: Math.floor(Date.now() / 1000) + 60 }, env.APP_AUTH_SECRET);
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  console.log = (...values) => logs.push(values);
  console.error = (...values) => logs.push(values);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "model_not_found", message: "The requested model does not exist" } }), { status: 404 });
  try {
    const response = await worker.fetch(request("/fact", {}, token), env);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Fact konnte nicht erzeugt werden" });
    const serializedLogs = JSON.stringify(logs);
    assert.match(serializedLogs, /OPENAI_API_KEY configured: true/);
    assert.match(serializedLogs, /OpenAI response status: 404/);
    assert.match(serializedLogs, /model_not_found/);
    assert.match(serializedLogs, /The requested model does not exist/);
    assert.doesNotMatch(serializedLogs, /do-not-log-this-key/);
    assert.doesNotMatch(serializedLogs, /Authorization/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
});
