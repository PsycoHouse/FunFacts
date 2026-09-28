import test from "node:test";
import assert from "node:assert/strict";
import worker, { RateLimiter } from "../worker/src/index.js";
import { webcrypto } from "node:crypto";

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
async function passwordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return `pbkdf2_sha256$100000$${b64url(salt)}$${b64url(new Uint8Array(hash))}`;
}
async function signedToken(payload, secret) {
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))))}`;
}
function request(path, body = {}, token = "") {
  return new Request(`https://worker.test${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}

test("CORS accepts GitHub origins regardless of hostname casing", async () => {
  const response = await worker.fetch(new Request("https://worker.test/login", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" }
  }), { ALLOWED_ORIGIN: "https://Example.github.io" });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
});

test("authentication, token validation, daily limit and protected OpenAI call", async () => {
  const env = { ALLOWED_ORIGIN: origin, APP_USER_ID: "friend", APP_PASSWORD_HASH: await passwordHash("correct horse"), APP_AUTH_SECRET: "a-long-test-secret", OPENAI_API_KEY: "server-only", RATE_LIMITER: limiterNamespace() };
  assert.equal((await worker.fetch(request("/fact"), env)).status, 401);
  assert.equal((await worker.fetch(request("/login", { username: "friend", password: "wrong" }), env)).status, 401);

  const login = await worker.fetch(request("/login", { username: "friend", password: "correct horse" }), env);
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);
  assert.equal((await worker.fetch(request("/fact", {}, `${token}x`), env)).status, 401);
  const expired = await signedToken({ user: "friend", exp: Math.floor(Date.now() / 1000) - 1 }, env.APP_AUTH_SECRET);
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

test("location facts validate coordinates and add local context without exposing them in the result", async () => {
  const env = { ALLOWED_ORIGIN: origin, APP_USER_ID: "friend", APP_AUTH_SECRET: "secret", OPENAI_API_KEY: "server-only", RATE_LIMITER: limiterNamespace() };
  const token = await signedToken({ user: "friend", exp: Math.floor(Date.now() / 1000) + 60 }, env.APP_AUTH_SECRET);
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
