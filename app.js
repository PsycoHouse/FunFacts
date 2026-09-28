// Öffentliche Worker-URL (kein Secret). Vor dem Deployment einmal anpassen.
const API_URL = "https://random-fact-api.gamer-33.workers.dev";
const SESSION_KEY = "random-fact-session-v1";
const HISTORY_KEY = "random-fact-seen-ids-v1";
const MAX_DUPLICATE_RETRIES = 3;

const $ = (selector) => document.querySelector(selector);
const loginView = $("#login-view");
const appView = $("#app-view");
const loginForm = $("#login-form");
const loginButton = $("#login-button");
const loginStatus = $("#login-status");
const factButton = $("#fact-button");
const statusElement = $("#status");
const factElement = $("#fact");
const categoryElement = $("#category");
const copyButton = $("#copy-button");
let token = sessionStorage.getItem(SESSION_KEY) || "";
let seenIds = loadSeenIds();
let currentFact = "";
let loading = false;
// `window.location` is already provided by browsers. A top-level binding with the
// same name can prevent this entire classic script from being parsed.
let userLocation = null;

showAuthenticated(Boolean(token));
updateHistoryCounter();

function loadSeenIds() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
  } catch { return new Set(); }
}

function showAuthenticated(authenticated) {
  loginView.hidden = authenticated;
  appView.hidden = !authenticated;
  if (!authenticated) $("#username").focus();
}

function configured() { return !API_URL.includes("YOUR-SUBDOMAIN"); }

async function api(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(options.body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Anfrage fehlgeschlagen (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured()) { loginStatus.textContent = "Bitte zuerst die Worker-URL in app.js eintragen."; return; }
  loginButton.disabled = true;
  loginButton.textContent = "WIRD ANGEMELDET …";
  loginStatus.textContent = "";
  try {
    const data = await api("/login", { body: { username: $("#username").value, password: $("#password").value } });
    token = data.token;
    sessionStorage.setItem(SESSION_KEY, token);
    loginForm.reset();
    showAuthenticated(true);
  } catch (error) { loginStatus.textContent = error.message; }
  finally { loginButton.disabled = false; loginButton.textContent = "ANMELDEN"; }
});

function setLoading(value) {
  loading = value;
  factButton.disabled = value;
  factButton.textContent = value ? "WIRD GELADEN …" : "NÄCHSTER FACT";
}

async function nextFact() {
  if (loading) return;
  setLoading(true); statusElement.textContent = "";
  try {
    for (let attempt = 0; attempt <= MAX_DUPLICATE_RETRIES; attempt += 1) {
      const data = await api("/fact", { body: userLocation ? { location: userLocation } : {} });
      updateDailyCounter(data.remaining);
      if (seenIds.has(data.id)) {
        if (attempt === MAX_DUPLICATE_RETRIES) throw new Error("Es wurden nur bekannte Facts gefunden. Versuche es später erneut.");
        continue;
      }
      seenIds.add(data.id);
      localStorage.setItem(HISTORY_KEY, JSON.stringify([...seenIds]));
      updateHistoryCounter();
      currentFact = data.fact.trim();
      categoryElement.textContent = data.category;
      categoryElement.hidden = false;
      copyButton.hidden = false;
      factElement.classList.remove("is-new"); void factElement.offsetWidth;
      factElement.textContent = currentFact;
      factElement.classList.add("is-new");
      break;
    }
  } catch (error) {
    if (error.status === 401) logout("Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.");
    else { statusElement.textContent = error.message; if (error.status === 429) updateDailyCounter(0); }
  } finally { setLoading(false); }
}

function updateLocationControl() {
  const enabled = Boolean(userLocation);
  const button = $("#location-button");
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? "Deaktivieren" : "Aktivieren";
  $("#location-description").textContent = enabled ? "Aktiv – der nächste Fact bezieht sich auf deine Umgebung" : "Standort ist ausgeschaltet";
}

function enableLocation() {
  if (!navigator.geolocation) {
    statusElement.textContent = "Dein Browser unterstützt keine Standortabfrage.";
    return;
  }
  const button = $("#location-button");
  button.disabled = true;
  button.textContent = "Wird ermittelt …";
  statusElement.textContent = "";
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    // Auf drei Nachkommastellen begrenzen, damit kein unnötig genauer Standort übertragen wird.
    userLocation = { latitude: Number(coords.latitude.toFixed(3)), longitude: Number(coords.longitude.toFixed(3)) };
    updateLocationControl();
    button.disabled = false;
    statusElement.textContent = "Standort aktiviert. Dein nächster Fact kommt aus deiner Nähe.";
  }, (error) => {
    userLocation = null;
    updateLocationControl();
    button.disabled = false;
    statusElement.textContent = error.code === error.PERMISSION_DENIED
      ? "Standortzugriff wurde abgelehnt. Du kannst ihn in den Browser-Einstellungen erlauben."
      : "Dein Standort konnte nicht ermittelt werden. Bitte versuche es erneut.";
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}

function updateDailyCounter(remaining) { if (Number.isInteger(remaining)) $("#daily-counter").textContent = `${20 - remaining} / 20 heute genutzt`; }
function updateHistoryCounter() { $("#counter").textContent = `${seenIds.size} Facts insgesamt gesehen`; }
function logout(message = "") {
  token = "";
  userLocation = null;
  sessionStorage.removeItem(SESSION_KEY);
  updateLocationControl();
  showAuthenticated(false);
  loginStatus.textContent = message;
}

factButton.addEventListener("click", nextFact);
$("#location-button").addEventListener("click", () => {
  if (userLocation) {
    userLocation = null;
    updateLocationControl();
    statusElement.textContent = "Standort deaktiviert.";
  } else enableLocation();
});
$("#logout-button").addEventListener("click", () => logout());
document.addEventListener("keydown", (event) => {
  if (!appView.hidden && (event.key === "Enter" || event.key === " ") && !["INPUT", "BUTTON", "TEXTAREA"].includes(document.activeElement.tagName)) { event.preventDefault(); nextFact(); }
});
copyButton.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(currentFact); copyButton.textContent = "Kopiert!"; setTimeout(() => { copyButton.textContent = "Fact kopieren"; }, 1300); }
  catch { statusElement.textContent = "Der Fact konnte nicht kopiert werden."; }
});
$("#reset-button").addEventListener("click", () => {
  if (!confirm("Möchtest du den Verlauf wirklich zurücksetzen?")) return;
  seenIds = new Set(); localStorage.removeItem(HISTORY_KEY); updateHistoryCounter();
  statusElement.textContent = "Verlauf wurde zurückgesetzt.";
});
