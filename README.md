# Random Fact

Eine kleine, responsive Dark-Mode-Web-App, die über einen Cloudflare Worker jeweils einen deutschen Random Fact erzeugt. Das statische Frontend kann kostenlos auf GitHub Pages liegen; der OpenAI-Schlüssel bleibt ausschließlich als Worker-Secret auf dem Server.

## Architektur

- `index.html`, `style.css`, `app.js`: statisches GitHub-Pages-Frontend ohne Build-Schritt
- `worker/worker.js`: Cloudflare Worker als abgesicherter API-Proxy zur OpenAI Responses API
- Der Browser speichert nur kompakte Fact-IDs unter `random-fact-seen-ids-v1` in `localStorage`.
- Bei einer bereits bekannten ID fordert die App automatisch erneut an (maximal drei Wiederholungsversuche).

## Einrichtung Schritt für Schritt

### 1. GitHub-Repository erstellen

1. Auf GitHub **New repository** wählen, z. B. `random-fact` nennen und erstellen.
2. Das Repository lokal klonen oder die Dateien über die GitHub-Oberfläche hochladen.

### 2. Dateien hochladen

Alle Dateien dieses Projekts in den Standard-Branch (`main`) übernehmen. Niemals einen API-Key in eine Datei schreiben oder committen. `.env`, `.dev.vars` und `.wrangler/` sind bereits durch `.gitignore` ausgeschlossen.

### 3. GitHub Pages aktivieren

1. Im Repository **Settings → Pages** öffnen.
2. Unter **Build and deployment** die Quelle **Deploy from a branch** wählen.
3. Branch **main**, Verzeichnis **/(root)** wählen und speichern.
4. GitHub zeigt anschließend die URL an, typischerweise `https://DEIN-NAME.github.io/random-fact/`.

Die genaue Origin dieser Adresse ist nur `https://DEIN-NAME.github.io` (ohne Pfad und ohne abschließenden Slash). Sie wird gleich für CORS benötigt.

### 4. Cloudflare Worker einrichten

Voraussetzungen: kostenloses Cloudflare-Konto sowie eine aktuelle Node.js/npm-Installation.

```bash
npm install --global wrangler
wrangler login
cd worker
cp wrangler.toml.example wrangler.toml
```

In `worker/wrangler.toml` `ALLOWED_ORIGIN` auf die konkrete GitHub-Pages-Origin setzen:

```toml
ALLOWED_ORIGIN = "https://DEIN-NAME.github.io"
```

Damit beantwortet der Worker ausschließlich Browser-Anfragen von dieser Origin. Bei einer eigenen Domain muss stattdessen deren Origin eingetragen werden, etwa `https://facts.example.com`. Für lokale Tests kann vorübergehend `http://localhost:8000` verwendet werden. Kein `*` einsetzen, wenn der Zugriff auf die eigene Seite beschränkt bleiben soll.

### 5. `OPENAI_API_KEY` als Secret hinterlegen

Im Ordner `worker/` ausführen:

```bash
wrangler secret put OPENAI_API_KEY
```

Den Schlüssel in der verdeckten Eingabe einfügen. Wrangler speichert ihn bei Cloudflare; er landet weder in `wrangler.toml` noch im Git-Repository. Der optionale Modellname `OPENAI_MODEL` ist keine geheime Variable.

### 6. Worker deployen

```bash
wrangler deploy
```

Am Ende erscheint eine URL wie `https://random-fact-api.DEINE-SUBDOMAIN.workers.dev`.

### 7. Worker-URL in der App eintragen

In `app.js` nur den Platzhalter ersetzen:

```js
const API_URL = "https://random-fact-api.DEINE-SUBDOMAIN.workers.dev";
```

Änderung committen und zu GitHub pushen. **Hier niemals den OpenAI-API-Key eintragen.** Eine Worker-URL ist öffentlich und kein Secret.

### 8. App testen

GitHub-Pages-URL öffnen und **Random Fact** anklicken. Alternativ funktionieren Enter und Leertaste, sofern gerade kein anderes Bedienelement fokussiert ist. Prüfen:

- Fact und Kategorie erscheinen.
- Der lokale Counter steigt.
- Nach Neuladen bleibt der Counter erhalten.
- **Verlauf zurücksetzen** fragt vor dem Löschen nach.
- Im Browser-Netzwerk-Tab wird nur die Worker-URL aufgerufen; der API-Key ist nirgends sichtbar.

Für einen lokalen Frontend-Test (nachdem `ALLOWED_ORIGIN` passend auf `http://localhost:8000` gesetzt und der Worker erneut deployt wurde):

```bash
python3 -m http.server 8000
```

Dann `http://localhost:8000` öffnen. Die HTML-Datei nicht direkt über `file://` starten, weil dabei keine normale HTTP-Origin übertragen wird.

## Sicherheit und Datenschutz

- Der API-Key ist ausschließlich ein Cloudflare-Secret und wird nie an den Browser gesendet.
- Der Worker akzeptiert nur `POST`/`OPTIONS`, prüft Origin, Content-Type, Größe und Body und validiert die strukturierte KI-Antwort erneut.
- Die OpenAI-Ausgabe ist per JSON Schema eingeschränkt und bewusst kurz gehalten.
- Es werden keine Namen, Prompts oder sonstigen Nutzerdaten gespeichert. Lokal bleiben lediglich bereits gesehene Fact-IDs.
- CORS ist keine Benutzer-Authentifizierung und verhindert keinen direkten serverseitigen Missbrauch der öffentlichen Worker-URL. Für eine öffentliche App mit relevantem Traffic empfiehlt sich zusätzlich Cloudflare Rate Limiting bzw. eine WAF-Regel.

## Anpassungen

Das Standardmodell ist `gpt-5-mini`, ein schnelles, kostengünstiges Modell für kurze Textaufgaben. Es kann ohne Codeänderung über `OPENAI_MODEL` in `wrangler.toml` ersetzt werden. Nach Änderungen an Worker-Konfiguration oder Code immer erneut `wrangler deploy` ausführen.
