const API_URL = "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev";
const STORAGE_KEY = "random-fact-seen-ids-v1";
const MAX_DUPLICATE_RETRIES = 3;

const factElement = document.querySelector("#fact");
const categoryElement = document.querySelector("#category");
const factButton = document.querySelector("#fact-button");
const copyButton = document.querySelector("#copy-button");
const resetButton = document.querySelector("#reset-button");
const counterElement = document.querySelector("#counter");
const statusElement = document.querySelector("#status");

let seenIds = loadSeenIds();
let currentFact = "";
let isLoading = false;

updateCounter();

function loadSeenIds() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveSeenIds() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...seenIds]));
}

function updateCounter() {
  counterElement.textContent = `${seenIds.size} ${seenIds.size === 1 ? "Fact" : "Facts"} gesehen`;
}

function setLoading(loading) {
  isLoading = loading;
  factButton.disabled = loading;
  factButton.innerHTML = loading
    ? '<span aria-hidden="true">⏳</span> WIRD GELADEN …'
    : '<span aria-hidden="true">🎲</span> RANDOM FACT';
}

function isValidFact(value) {
  return value && typeof value.id === "string" && /^[a-z0-9_]{3,80}$/.test(value.id)
    && typeof value.fact === "string" && value.fact.trim().length >= 10 && value.fact.length <= 500
    && typeof value.category === "string" && value.category.length <= 40;
}

async function requestFact() {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Anfrage fehlgeschlagen (${response.status}).`);
  if (!isValidFact(data)) throw new Error("Die API hat eine ungültige Antwort geliefert.");
  return data;
}

async function showRandomFact() {
  if (isLoading) return;
  if (API_URL.includes("YOUR-WORKER")) {
    statusElement.textContent = "Bitte zuerst die Worker-URL in app.js eintragen.";
    return;
  }

  setLoading(true);
  statusElement.textContent = "";

  try {
    for (let attempt = 0; attempt <= MAX_DUPLICATE_RETRIES; attempt += 1) {
      const result = await requestFact();
      if (seenIds.has(result.id)) {
        if (attempt === MAX_DUPLICATE_RETRIES) {
          throw new Error("Diesmal gab es nur bekannte Facts. Versuch es bitte erneut.");
        }
        continue;
      }

      seenIds.add(result.id);
      saveSeenIds();
      updateCounter();
      currentFact = result.fact.trim();
      categoryElement.textContent = result.category;
      categoryElement.hidden = false;
      copyButton.hidden = false;
      factElement.classList.remove("is-new");
      void factElement.offsetWidth;
      factElement.textContent = currentFact;
      factElement.classList.add("is-new");
      return;
    }
  } catch (error) {
    statusElement.textContent = error instanceof Error ? error.message : "Etwas ist schiefgelaufen.";
  } finally {
    setLoading(false);
  }
}

factButton.addEventListener("click", showRandomFact);

document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target === document.body) {
    event.preventDefault();
    showRandomFact();
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentFact);
    copyButton.textContent = "Kopiert!";
    setTimeout(() => { copyButton.textContent = "Kopieren"; }, 1400);
  } catch {
    statusElement.textContent = "Der Fact konnte nicht kopiert werden.";
  }
});

resetButton.addEventListener("click", () => {
  if (!confirm("Möchtest du den Verlauf wirklich zurücksetzen?")) return;
  seenIds = new Set();
  localStorage.removeItem(STORAGE_KEY);
  updateCounter();
  statusElement.textContent = "Verlauf wurde zurückgesetzt.";
});
