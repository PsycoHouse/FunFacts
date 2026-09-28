# Random Fact

Eine kleine, responsive Dark-Mode-Web-App, die über einen Cloudflare Worker jeweils einen deutschen Random Fact erzeugt. Das statische Frontend liegt kostenlos auf GitHub Pages; der OpenAI-Schlüssel bleibt ausschließlich als Worker-Secret auf dem Server.

## Nutzung

Für Endnutzer ist **keine Installation und kein Konto erforderlich**. Sie öffnen ausschließlich die veröffentlichte GitHub-Pages-URL im Browser, zum Beispiel:

```text
https://DEIN-NAME.github.io/random-fact/
```

Node.js, npm und Wrangler werden zum Benutzen der App nicht benötigt. Die folgenden Schritte richten sich nur an die Person, die eine eigene Instanz der App veröffentlicht.

## Architektur

- `index.html`, `style.css`, `app.js`: statisches GitHub-Pages-Frontend ohne Build-Schritt
- `worker/worker.js`: Cloudflare Worker als abgesicherter API-Proxy zur OpenAI Responses API
- Der Browser speichert nur kompakte Fact-IDs unter `random-fact-seen-ids-v1` in `localStorage`.
- Bei einer bereits bekannten ID fordert die App automatisch erneut an (maximal drei Wiederholungsversuche).

## Veröffentlichung ohne lokale Installation (empfohlen)

Die komplette Einrichtung ist über die Weboberflächen von GitHub und Cloudflare möglich. Auf dem eigenen Rechner muss dafür keine Entwicklungssoftware installiert werden.

### 1. Repository auf GitHub anlegen

1. Auf GitHub **New repository** wählen, das Repository zum Beispiel `random-fact` nennen und erstellen.
2. Über **Add file → Upload files** alle Dateien und Ordner dieses Projekts hochladen und die Änderung in den Standard-Branch (`main`) übernehmen.
3. Niemals einen API-Key in eine Datei schreiben oder committen.

### 2. GitHub Pages aktivieren

1. Im Repository **Settings → Pages** öffnen.
2. Unter **Build and deployment** als Quelle **Deploy from a branch** wählen.
3. Branch **main** und Verzeichnis **/(root)** wählen und speichern.
4. Nach Abschluss des Deployments zeigt GitHub die öffentliche URL an, typischerweise `https://DEIN-NAME.github.io/random-fact/`.

Die Origin dieser Adresse lautet nur `https://DEIN-NAME.github.io` — ohne Repository-Pfad und ohne abschließenden Slash. Diese Origin wird im nächsten Schritt für CORS benötigt.

### 3. Worker direkt im Cloudflare-Dashboard erstellen

Voraussetzungen für die veröffentlichende Person sind lediglich ein Cloudflare-Konto und ein OpenAI-API-Key.

1. Im Cloudflare-Dashboard **Workers & Pages** öffnen und **Create** wählen.
2. Einen Worker erstellen, ihm zum Beispiel den Namen `random-fact-api` geben und zunächst deployen.
3. **Edit code** öffnen, den vorhandenen Beispielcode vollständig durch den Inhalt von [`worker/worker.js`](worker/worker.js) ersetzen und erneut **Deploy** wählen.
4. In den Worker-Einstellungen **Settings → Variables and Secrets** öffnen.
5. `ALLOWED_ORIGIN` als normale Textvariable mit der zuvor ermittelten GitHub-Pages-Origin anlegen, zum Beispiel `https://DEIN-NAME.github.io`.
6. `OPENAI_API_KEY` als **Secret** anlegen und den OpenAI-API-Key als Wert eintragen.
7. Optional `OPENAI_MODEL` als Textvariable anlegen, wenn statt des Standardmodells `gpt-5-mini` ein anderes Modell verwendet werden soll.

Die Bezeichnungen einzelner Schaltflächen können sich im Cloudflare-Dashboard leicht ändern. Entscheidend ist, dass der Code aus `worker/worker.js` deployed wird, `ALLOWED_ORIGIN` eine Textvariable und `OPENAI_API_KEY` ein verschlüsseltes Secret ist. Kein `*` als Origin verwenden, wenn der Browserzugriff auf die eigene Seite beschränkt bleiben soll. Bei einer eigenen Domain deren Origin eintragen, beispielsweise `https://facts.example.com`.

Cloudflare zeigt die öffentliche Worker-URL an, etwa:

```text
https://random-fact-api.DEINE-SUBDOMAIN.workers.dev
```

### 4. Worker-URL über GitHub eintragen

1. Im GitHub-Repository `app.js` öffnen und auf **Edit this file** (Stiftsymbol) klicken.
2. Ausschließlich den Platzhalter am Anfang der Datei ersetzen:

   ```js
   const API_URL = "https://random-fact-api.DEINE-SUBDOMAIN.workers.dev";
   ```

3. Die Änderung über **Commit changes** in `main` speichern.
4. Warten, bis GitHub Pages die Änderung veröffentlicht hat.

**Hier niemals den OpenAI-API-Key eintragen.** Die Worker-URL ist öffentlich und kein Secret.

### 5. Veröffentlichung testen und URL weitergeben

Die GitHub-Pages-URL öffnen und **Random Fact** anklicken. Prüfen:

- Fact und Kategorie erscheinen.
- Der lokale Counter steigt.
- Nach Neuladen bleibt der Counter erhalten.
- **Verlauf zurücksetzen** fragt vor dem Löschen nach.
- Im Browser-Netzwerk-Tab wird nur die Worker-URL aufgerufen; der API-Key ist nirgends sichtbar.

An Endnutzer wird danach **nur die GitHub-Pages-URL** weitergegeben. Sie müssen weder Dateien herunterladen noch Node.js, npm oder Wrangler installieren und benötigen auch keinen Cloudflare- oder OpenAI-Zugang.

## Optional: Deployment für Entwickler mit Wrangler

Wer den Worker lieber über eine lokale Entwicklungsumgebung verwaltet, kann optional Node.js/npm und Wrangler verwenden. Diese Methode ist weder für Endnutzer noch für das empfohlene Dashboard-Deployment erforderlich.

```bash
npm install --global wrangler
wrangler login
cd worker
cp wrangler.toml.example wrangler.toml
```

In `worker/wrangler.toml` `ALLOWED_ORIGIN` auf die konkrete GitHub-Pages-Origin setzen, anschließend das Secret hinterlegen und deployen:

```bash
wrangler secret put OPENAI_API_KEY
wrangler deploy
```

Nach Änderungen an Worker-Code oder -Konfiguration erneut `wrangler deploy` ausführen. Für einen optionalen lokalen Frontend-Test `ALLOWED_ORIGIN` vorübergehend auf `http://localhost:8000` setzen, den Worker erneut deployen und einen lokalen Webserver starten:

```bash
python3 -m http.server 8000
```

Dann `http://localhost:8000` öffnen. Die HTML-Datei nicht direkt über `file://` starten, weil dabei keine normale HTTP-Origin übertragen wird.

## Sicherheit und Datenschutz

- Der API-Key ist ausschließlich ein Cloudflare-Secret und wird nie an den Browser gesendet.
- Der Worker akzeptiert nur `POST`/`OPTIONS`, prüft Origin, Content-Type, Größe und Body und validiert die strukturierte KI-Antwort erneut.
- Die OpenAI-Ausgabe ist per JSON Schema eingeschränkt und bewusst kurz gehalten.
- Es werden keine Namen, Prompts oder sonstigen Nutzerdaten gespeichert. Lokal bleiben lediglich bereits gesehene Fact-IDs.
- CORS ist keine Benutzer-Authentifizierung und verhindert keinen direkten serverseitigen Missbrauch der öffentlichen Worker-URL. Für eine öffentliche App mit relevantem Traffic empfiehlt sich zusätzlich Cloudflare Rate Limiting beziehungsweise eine WAF-Regel.
