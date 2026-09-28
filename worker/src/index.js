const CATEGORIES = ["Weltraum", "Tiere", "Biologie", "Mensch", "Geschichte", "Wissenschaft", "Technik", "Erde", "Kultur", "Kurioses"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FACT_LIMIT = 20;
const LOGIN_LIMIT = 10;
const SESSION_SECONDS = 24 * 60 * 60;
const DEFAULT_ALLOWED_ORIGIN = "https://psycohouse.github.io";
const EXPECTED_USER_ID = "AJT";

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
  const rawConfiguredUser = typeof env.APP_USER_ID === "string" ? env.APP_USER_ID : "";
  const configuredUser = rawConfiguredUser.trim();
  const configuredPasswordHash = normalizedSecret(env.APP_PASSWORD_HASH);
  const authSecret = normalizedSecret(env.APP_AUTH_SECRET);
  const userConfigured = rawConfiguredUser.length > 0;
  const passwordHashConfigured = configuredPasswordHash.length > 0;
  const passwordHashFormatValid = validPasswordHashFormat(configuredPasswordHash);

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
  const usernameMatches = usernamePresent && await constantTimeEqual(username, configuredUser);
  let passwordVerified = false;

  // Only non-sensitive booleans and lengths are logged. In particular, never
  // log the request fields, configured identifiers, hashes, or passwords.
  const logDiagnostics = () => console.log("Login diagnostics", {
    "request body parsed": bodyParsed,
    "username field present": usernamePresent,
    "password field present": passwordPresent,
    "username received length": username.length,
    "expected username length": configuredUser.length,
    "username matches": usernameMatches,
    "APP_USER_ID configured": userConfigured,
    "APP_USER_ID has surrounding whitespace": rawConfiguredUser !== configuredUser,
    "APP_PASSWORD_HASH configured": passwordHashConfigured,
    "password hash format valid": passwordHashFormatValid,
    "password verification result": passwordVerified
  });

  // A missing, whitespace-padded, or unexpected user id is a deployment error,
  // not a failed login. This application intentionally has exactly one user.
  const configurationValid = userConfigured
    && rawConfiguredUser === configuredUser
    && configuredUser === EXPECTED_USER_ID
    && passwordHashConfigured
    && passwordHashFormatValid
    && authSecret.length > 0
    && Boolean(env.RATE_LIMITER);
  if (!configurationValid) {
    logDiagnostics();
    return json({ error: "Authentication configuration error" }, 500, headers);
  }
  if (!bodyParsed || !exactFields || !usernamePresent || !passwordPresent) {
    logDiagnostics();
    return json({ error: "Ungültige Zugangsdaten" }, 401, headers);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const window = Math.floor(Date.now() / (15 * 60 * 1000));
  const key = `login:${ip}:${window}`;
  const current = await limit(env, "peek", key, LOGIN_LIMIT, 16 * 60);
  if (!current.allowed) return json({ error: "Zu viele Login-Versuche. Bitte später erneut versuchen" }, 429, headers);

  passwordVerified = await verifyPassword(body.password, configuredPasswordHash);
  logDiagnostics();
  if (!usernameMatches || !passwordVerified) {
    const result = await limit(env, "increment", key, LOGIN_LIMIT, 16 * 60);
    return result.allowed ? json({ error: "Ungültige Zugangsdaten" }, 401, headers) : json({ error: "Zu viele Login-Versuche. Bitte später erneut versuchen" }, 429, headers);
  }
  await limit(env, "delete", key, LOGIN_LIMIT, 1);
  const token = await signToken({ user: configuredUser, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }, authSecret);
  return json({ token, expiresIn: SESSION_SECONDS }, 200, headers);
}

async function fact(request, env, headers) {
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
    console.error("Fact generation failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "Fact konnte nicht erzeugt werden" }, 502, headers);
  }
}

async function createFact(env, location) {
  const category = location ? "Vor Ort" : CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
  const locationPrompt = location
    ? `Der Fact muss einen konkreten, interessanten Bezug zur Umgebung der Koordinaten ${location.latitude}, ${location.longitude} haben. Nenne nach Möglichkeit den betreffenden Ort oder die Region, aber niemals die Koordinaten.`
    : "";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5-mini",
      instructions: "Antworte ausschließlich mit dem verlangten JSON. Erfinde keine Behauptungen.",
      input: `Erzeuge einen überraschenden, sachlichen und möglichst korrekten deutschen Fakt der Kategorie ${category}. ${locationPrompt} Maximal zwei kurze Sätze, keine Meinung oder Allgemeinplätze. Die id ist eine beschreibende englische snake_case-ID. category muss exakt ${category} sein.`,
      max_output_tokens: 180,
      text: { format: { type: "json_schema", name: "random_fact", strict: true, schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", pattern: "^[a-z0-9_]{3,80}$" }, fact: { type: "string", minLength: 10, maxLength: 500 }, category: { type: "string", enum: [category] } }, required: ["id", "fact", "category"] } } }
    })
  });
  if (!response.ok) throw new Error(`OpenAI status ${response.status}`);
  const data = await response.json();
  const text = data.output_text || data.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  const value = JSON.parse(text || "");
  if (!value || !/^[a-z0-9_]{3,80}$/.test(value.id) || typeof value.fact !== "string" || value.fact.length < 10 || value.fact.length > 500 || value.category !== category) throw new Error("Invalid OpenAI response");
  return value;
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

export async function verifyPassword(password, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  const [algorithm, roundsText, saltBase64Url, hashBase64Url] = parts;
  const rounds = Number(roundsText);
  const algorithmRecognized = algorithm === "pbkdf2_sha256";
  // Accept hashes created by older documented versions of this project, which
  // used 100,000 rounds. New hashes use 310,000 rounds (see README), while the
  // upper bound prevents an accidentally malformed secret from tying up a
  // Worker request for an excessive amount of time.
  const iterationsValid = Number.isInteger(rounds) && rounds >= 100000 && rounds <= 2000000;
  let salt;
  let expected;
  try { salt = base64urlToBytes(saltBase64Url); } catch { salt = null; }
  try { expected = base64urlToBytes(hashBase64Url); } catch { expected = null; }
  const saltParsed = Boolean(salt?.length);
  const storedHashParsed = expected?.length === 32;
  const passwordIsString = typeof password === "string";
  const passwordBytes = passwordIsString ? new TextEncoder().encode(password) : new Uint8Array();
  const formatValid = passwordIsString && parts.length === 4 && algorithmRecognized && iterationsValid && saltParsed && storedHashParsed;

  let verified = false;
  let derived = null;
  if (formatValid) {
    try {
      derived = await derivePbkdf2Sha256(passwordBytes, salt, rounds);
      verified = constantTimeBytes(derived, expected);
    } catch { verified = false; }
  }

  // Never log credential contents. These lengths make encoding, base64url
  // decoding, and the bits-versus-bytes boundary observable in Worker logs.
  console.log("Password verification diagnostics", {
    "password length": passwordIsString ? password.length : 0,
    "password UTF-8 byte length": passwordBytes.length,
    "salt byte length": salt?.length ?? 0,
    "stored hash byte length": expected?.length ?? 0,
    "derived hash byte length": derived?.length ?? 0,
    "iterations": Number.isInteger(rounds) ? rounds : 0,
    "derived equals stored": verified
  });
  return verified;
}

export async function derivePbkdf2Sha256(passwordBytes, saltBytes, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

function validPasswordHashFormat(stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const rounds = Number(parts[1]);
  if (!Number.isInteger(rounds) || rounds < 100000 || rounds > 2000000) return false;
  try {
    return base64urlToBytes(parts[2]).length > 0 && base64urlToBytes(parts[3]).length === 32;
  } catch { return false; }
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
function normalizedSecret(value) { return typeof value === "string" ? value.trim() : ""; }
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
