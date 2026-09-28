const CATEGORIES = ["Weltraum", "Tiere", "Biologie", "Mensch", "Geschichte", "Wissenschaft", "Technik", "Erde", "Kultur", "Kurioses"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FACT_LIMIT = 20;
const LOGIN_LIMIT = 10;
const SESSION_SECONDS = 24 * 60 * 60;
const DEFAULT_ALLOWED_ORIGIN = "https://psycohouse.github.io";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = new URL(env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN).origin;
    const headers = corsHeaders(allowedOrigin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (!originAllowed(origin, allowedOrigin)) return json({ error: "Origin nicht erlaubt" }, 403, headers);

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok" }, 200, headers);
    if (request.method !== "POST" || !["/login", "/fact"].includes(url.pathname)) return json({ error: "Nicht gefunden" }, 404, headers);
    if (!request.headers.get("Content-Type")?.includes("application/json")) return json({ error: "JSON erwartet" }, 415, headers);
    if (Number(request.headers.get("Content-Length") || 0) > 2048) return json({ error: "Anfrage zu groß" }, 413, headers);

    try {
      return url.pathname === "/login" ? await login(request, env, headers) : await fact(request, env, headers);
    } catch (error) {
      console.error("Request failed", error instanceof Error ? error.message : "unknown");
      return json({ error: "Interner Serverfehler" }, 500, headers);
    }
  }
};

async function login(request, env, headers) {
  const configuredUser = typeof env.APP_USER_ID === "string" ? env.APP_USER_ID : "";
  const configuredPassword = typeof env.APP_PASSWORD === "string" ? env.APP_PASSWORD : "";
  const authSecret = typeof env.APP_AUTH_SECRET === "string" ? env.APP_AUTH_SECRET : "";

  let body;
  let bodyParsed = false;
  try {
    body = await request.json();
    bodyParsed = Boolean(body) && typeof body === "object" && !Array.isArray(body);
  } catch { body = null; }
  const usernamePresent = bodyParsed && typeof body.username === "string";
  const passwordPresent = bodyParsed && typeof body.password === "string";
  const exactFields = bodyParsed && Object.keys(body).sort().join(",") === "password,username";
  const username = usernamePresent ? body.username : "";
  const password = passwordPresent ? body.password : "";

  const configurationValid = configuredUser.length > 0
    && configuredPassword.length > 0
    && authSecret.length > 0
    && Boolean(env.RATE_LIMITER);
  if (!configurationValid) {
    return json({ error: "Authentication configuration error" }, 500, headers);
  }
  if (!bodyParsed || !exactFields || !usernamePresent || !passwordPresent) {
    return json({ error: "Ungültige Zugangsdaten" }, 401, headers);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const window = Math.floor(Date.now() / (15 * 60 * 1000));
  const key = `login:${ip}:${window}`;
  const current = await limit(env, "peek", key, LOGIN_LIMIT, 16 * 60);
  if (!current.allowed) return json({ error: "Zu viele Login-Versuche. Bitte später erneut versuchen" }, 429, headers);

  const usernameMatches = await constantTimeEqual(username, configuredUser);
  const passwordMatches = await constantTimeEqual(password, configuredPassword);
  if (!usernameMatches || !passwordMatches) {
    const result = await limit(env, "increment", key, LOGIN_LIMIT, 16 * 60);
    return result.allowed ? json({ error: "Ungültige Zugangsdaten" }, 401, headers) : json({ error: "Zu viele Login-Versuche. Bitte später erneut versuchen" }, 429, headers);
  }
  await limit(env, "delete", key, LOGIN_LIMIT, 1);
  const token = await signToken({ user: configuredUser, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }, authSecret);
  return json({ token, expiresIn: SESSION_SECONDS }, 200, headers);
}

async function fact(request, env, headers) {
  console.log(`OPENAI_API_KEY configured: ${typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0}`);
  if (!env.OPENAI_API_KEY || !env.APP_AUTH_SECRET || !env.RATE_LIMITER) return json({ error: "Server ist nicht konfiguriert" }, 500, headers);
  const auth = request.headers.get("Authorization") || "";
  const payload = auth.startsWith("Bearer ") ? await verifyToken(auth.slice(7), env.APP_AUTH_SECRET) : null;
  if (!payload || payload.user !== env.APP_USER_ID) return json({ error: "Nicht autorisiert" }, 401, headers);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage" }, 400, headers); }
  if (!validFactBody(body)) return json({ error: "Ungültige Anfrage" }, 400, headers);

  const day = new Date().toISOString().slice(0, 10);
  const key = `fact:${payload.user}:${day}`;
  const reservation = await limit(env, "increment", key, FACT_LIMIT, 2 * 86400);
  if (!reservation.allowed) return json({ error: "Tageslimit erreicht", remaining: 0 }, 429, headers);
  try {
    const result = await createFact(env, body.location);
    return json({ ...result, remaining: FACT_LIMIT - reservation.count }, 200, headers);
  } catch (error) {
    await limit(env, "decrement", key, FACT_LIMIT, 2 * 86400);
    const status = error instanceof OpenAIError && [400, 401, 404, 429].includes(error.status) ? error.status : 502;
    console.error("Fact generation failed", safeLogValue(error instanceof Error ? error.message : "unknown"));
    return json({ error: "Fact konnte nicht erzeugt werden" }, status, headers);
  }
}

async function createFact(env, location) {
  const category = location ? "Vor Ort" : CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
  const locationPrompt = location
    ? `Der Fact muss einen konkreten, interessanten Bezug zur Umgebung der Koordinaten ${location.latitude}, ${location.longitude} haben. Nenne nach Möglichkeit den betreffenden Ort oder die Region, aber niemals die Koordinaten.`
    : "";
  console.log("OpenAI request started");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5-mini",
      instructions: "Antworte ausschließlich mit dem verlangten JSON. Erfinde keine Behauptungen.",
      input: `Erzeuge einen überraschenden, sachlichen und möglichst korrekten deutschen Fakt der Kategorie ${category}. ${locationPrompt} Maximal zwei kurze Sätze, keine Meinung oder Allgemeinplätze. Die id ist eine beschreibende englische snake_case-ID. category muss exakt ${category} sein.`,
      text: { format: { type: "json_schema", name: "random_fact", strict: true, schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", pattern: "^[a-z0-9_]{3,80}$" }, fact: { type: "string", minLength: 10, maxLength: 500 }, category: { type: "string", enum: [category] } }, required: ["id", "fact", "category"] } } }
    })
  });
  console.log(`OpenAI response status: ${response.status}`);
  console.log(`OpenAI response ok: ${response.ok}`);

  const responseBody = await response.text();
  let data;
  try {
    data = JSON.parse(responseBody);
    console.log("OpenAI response parsed: true");
  } catch {
    console.log("OpenAI response parsed: false");
    if (!response.ok) logOpenAIError(response.status, {});
    throw new OpenAIError(response.status, "OpenAI returned invalid JSON");
  }

  if (!response.ok) {
    const apiError = data && typeof data.error === "object" && data.error ? data.error : {};
    logOpenAIError(response.status, apiError);
    throw new OpenAIError(response.status, safeLogValue(apiError.message || "OpenAI request failed"));
  }

  const text = extractOutputText(data);
  let value;
  try {
    value = JSON.parse(text);
    console.log("Fact JSON parsed: true");
  } catch {
    console.log("Fact JSON parsed: false");
    throw new OpenAIError(502, data?.status === "incomplete" ? "OpenAI response was incomplete" : "OpenAI output was not valid JSON");
  }
  if (!value || !/^[a-z0-9_]{3,80}$/.test(value.id) || typeof value.fact !== "string" || value.fact.length < 10 || value.fact.length > 500 || value.category !== category) throw new Error("Invalid OpenAI response");
  return value;
}

class OpenAIError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "OpenAIError";
    this.status = status;
  }
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.length > 0) return data.output_text;
  if (!Array.isArray(data?.output)) return "";
  for (const output of data.output) {
    if (!Array.isArray(output?.content)) continue;
    for (const content of output.content) {
      if (content?.type === "output_text" && typeof content.text === "string" && content.text.length > 0) return content.text;
    }
  }
  return "";
}

function logOpenAIError(status, error) {
  console.error("OpenAI error", {
    status,
    type: safeLogValue(error.type),
    code: safeLogValue(error.code),
    message: safeLogValue(error.message || "Unknown OpenAI error")
  });
}

function safeLogValue(value) {
  return typeof value === "string" ? value.replace(/[\r\n]/g, " ").slice(0, 500) : "unknown";
}

function validFactBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.length === 0) return true;
  if (keys.length !== 1 || keys[0] !== "location") return false;
  const location = body.location;
  if (!location || typeof location !== "object" || Array.isArray(location) || Object.keys(location).sort().join(",") !== "latitude,longitude") return false;
  return Number.isFinite(location.latitude) && location.latitude >= -90 && location.latitude <= 90
    && Number.isFinite(location.longitude) && location.longitude >= -180 && location.longitude <= 180;
}

async function signToken(payload, secret) {
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(encoded, secret);
  return `${encoded}.${base64url(signature)}`;
}

async function verifyToken(token, secret) {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    if (!constantTimeBytes(fromBase64url(signature), await hmac(payload, secret))) return null;
    const value = JSON.parse(decoder.decode(fromBase64url(payload)));
    return typeof value.user === "string" && Number.isInteger(value.exp) && value.exp > Math.floor(Date.now() / 1000) ? value : null;
  } catch { return null; }
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function constantTimeEqual(a, b) {
  const left = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(a)));
  const right = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(b)));
  return constantTimeBytes(left, right);
}
function constantTimeBytes(a, b) { let diff = a.length ^ b.length; const length = Math.max(a.length, b.length); for (let i = 0; i < length; i += 1) diff |= (a[i] || 0) ^ (b[i] || 0); return diff === 0; }
function base64url(bytes) { let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function fromBase64url(value) { return base64urlToBytes(value); }
export function base64urlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error("Invalid base64url");
  const unpadded = value.replace(/=+$/, "");
  const remainder = unpadded.length % 4;
  if (remainder === 1) throw new Error("Invalid base64url length");
  const requiredPadding = (4 - remainder) % 4;
  const suppliedPadding = value.length - unpadded.length;
  if (suppliedPadding !== 0 && suppliedPadding !== requiredPadding) throw new Error("Invalid base64url padding");
  const normalized = unpadded.replace(/-/g, "+").replace(/_/g, "/").padEnd(unpadded.length + requiredPadding, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function originAllowed(origin, allowed) {
  if (!origin || !allowed) return false;
  try {
    // URL normalizes host names to lower case. This matters when the GitHub owner
    // contains capital letters but browsers serialize the Origin in lower case.
    return new URL(origin).origin === new URL(allowed).origin;
  } catch { return false; }
}
function corsHeaders(allowedOrigin) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin"
  };
}
function json(value, status, headers) { return new Response(JSON.stringify(value), { status, headers }); }
async function limit(env, action, key, max, ttl) { const id = env.RATE_LIMITER.idFromName("global"); return (await env.RATE_LIMITER.get(id).fetch("https://limiter.internal/", { method: "POST", body: JSON.stringify({ action, key, max, ttl }) })).json(); }

export class RateLimiter {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const { action, key, max, ttl } = await request.json();
    const saved = await this.storage.get(key);
    let count = saved && saved.expiresAt > Date.now() ? Number(saved.count) : 0;
    if (action === "delete") { await this.storage.delete(key); return json({ allowed: true, count: 0 }, 200, {}); }
    if (action === "peek") return json({ allowed: count < max, count }, 200, {});
    if (action === "decrement") count = Math.max(0, count - 1);
    if (action === "increment") { if (count >= max) return json({ allowed: false, count }, 200, {}); count += 1; }
    await this.storage.put(key, { count, expiresAt: Date.now() + ttl * 1000 });
    return json({ allowed: count <= max, count }, 200, {});
  }
}
