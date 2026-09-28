# Private Random Fact

Eine installierungsfreie Dark-Mode-Web-App mit serverseitigem Login. Das statische Frontend läuft auf GitHub Pages; Authentifizierung, Limits und der einzige OpenAI-Aufruf laufen in einem Cloudflare Worker.

## Architektur und Sicherheitsprinzip

```text
Browser → GitHub Pages → Cloudflare Worker → OpenAI Responses API
```

Ein Login in einer statischen GitHub-Pages-Seite **allein schützt keinen API-Key**: Alles, was an den Browser ausgeliefert wird, ist einsehbar. Die Sicherheit entsteht hier dadurch, dass `OPENAI_API_KEY`, `APP_USER_ID`, `APP_PASSWORD` und der Signierschlüssel ausschließlich verschlüsselte Worker-Secrets sind. Das Frontend kennt nur die öffentliche Worker-URL. Es ruft niemals OpenAI direkt auf und erhält zu keiner Zeit das konfigurierte Passwort.

- Der Worker vergleicht Benutzername und Passwort ausschließlich serverseitig mit `APP_USER_ID` und `APP_PASSWORD`. Der Vergleich erfolgt über SHA-256-Digests mit einem konstantzeitähnlichen Bytevergleich.
- Ein HMAC-SHA-256-signiertes Token gilt 24 Stunden und liegt nur in `sessionStorage`.
- Nur Fact-IDs liegen als unkritische Historie in `localStorage`.
- Ein SQLite Durable Object limitiert atomar auf 20 erfolgreiche Facts je Benutzer/UTC-Tag und zehn fehlgeschlagene Logins je IP/15 Minuten. Schlägt OpenAI fehl, wird die Reservierung zurückgenommen.
- CORS erlaubt ausschließlich `ALLOWED_ORIGIN`; `/fact` verlangt trotzdem immer ein gültiges Token.
- Es werden weder Passwörter/Tokens noch OpenAI-Antworten protokolliert.
- Die optionale Standortfunktion wird erst nach ausdrücklicher Freigabe aktiv. Das Frontend rundet Koordinaten auf drei Nachkommastellen; sie werden nur für die aktuelle Sitzung im Arbeitsspeicher gehalten und beim Fact-Abruf an den Worker sowie zur Faktgenerierung an OpenAI übertragen.

## Einrichtung – Schritt für Schritt

### 1. GitHub Repository erstellen

Auf GitHub **New repository** wählen, zum Beispiel `random-fact` nennen und als Standard-Branch `main` verwenden. Keine geheimen Werte in Dateien eintragen.

### 2. Projekt hochladen

Alle Dateien inklusive der versteckten Ordner `.github` hochladen (**Add file → Upload files**) und nach `main` committen. Alternativ Git verwenden. Die gewünschte Struktur ist:

```text
index.html  style.css  app.js
assets/herbstblatt.png
worker/src/index.js  worker/wrangler.toml
.github/workflows/deploy.yml
```

Das Herbstblatt für die dekorativen Ecken der Login- und Fact-Box als **`assets/herbstblatt.png`** ablegen (Dateiname inklusive Groß-/Kleinschreibung exakt beibehalten). Am besten eignet sich ein freigestelltes PNG mit transparentem Hintergrund und ungefähr quadratischer Arbeitsfläche. Nach dem Hochladen genügt ein normaler Commit; der Pages-Workflow übernimmt den gesamten `assets`-Ordner automatisch. Fehlt die Datei noch, bleiben die Boxen ohne defektes Bildsymbol nutzbar.

### 3. GitHub Pages aktivieren

**Repository → Settings → Pages → Build and deployment → Source: GitHub Actions** wählen. Nicht „Deploy from a branch“ verwenden, weil der Workflow das Pages-Artefakt veröffentlicht.

### 4. Cloudflare Konto erstellen

Auf Cloudflare registrieren, E-Mail bestätigen und im Dashboard **Workers & Pages** einmal öffnen. Für Freunde ist kein Cloudflare-Konto nötig.

### 5. Worker erstellen

Der Workflow erstellt/deployt `random-fact-api` automatisch. Ein manuell angelegter Worker ist nicht nötig. Soll der Name anders sein, das optionale Repository-Secret `CLOUDFLARE_WORKER_NAME` anlegen. Nach dem ersten Deploy zeigt Cloudflare unter **Workers & Pages → Worker** die `workers.dev`-URL. In `app.js` bei `API_URL` einmalig `https://random-fact-api.YOUR-SUBDOMAIN.workers.dev` durch genau diese URL (ohne abschließenden Slash) ersetzen und committen.

### 6. Cloudflare API Token erstellen

Cloudflare: **My Profile → API Tokens → Create Token → Edit Cloudflare Workers**. Der Token benötigt für das eigene Konto Worker-Script-Schreibrechte und Durable-Objects-Schreibrechte. Konto-ID im Dashboard kopieren. Beide Werte werden gleich als GitHub-Secrets gespeichert.

### 7. OpenAI API Key erstellen

Im OpenAI-Platform-Konto einen API-Key erstellen, Abrechnung/Limits konfigurieren und den Wert sofort sicher kopieren. Er gehört ausschließlich in das Repository-Secret `OPENAI_API_KEY`, ausdrücklich **nicht** in eine GitHub Variable, `app.js`, `wrangler.toml` oder einen Commit.

### 8. GitHub Secrets eintragen

Für **jeden** Wert: **GitHub → Settings → Secrets and variables → Actions → Repository secrets → New repository secret**. Folgende Repository-Secrets anlegen:

| Name | Inhalt |
|---|---|
| `APP_USER_ID` | erlaubter Benutzername |
| `APP_PASSWORD` | starkes, nur hier und in Cloudflare gespeichertes Passwort |
| `APP_AUTH_SECRET` | Ergebnis aus Schritt 9 |
| `OPENAI_API_KEY` | OpenAI API-Key |
| `CLOUDFLARE_API_TOKEN` | Token aus Schritt 6 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare-Konto-ID |

Optional kann `CLOUDFLARE_WORKER_NAME` als weiteres Repository-Secret gesetzt werden; ohne dieses Secret heißt der Worker `random-fact-api`.

Secrets niemals zusätzlich unter **Variables** anlegen. Insbesondere darf `APP_PASSWORD` nie in eine Repository-Datei, das Frontend oder den GitHub-Pages-Build gelangen. Der Workflow leitet die vier App-Secrets per Standardeingabe an `wrangler secret put`; ihre Werte werden weder in Argumenten noch per `echo` ausgegeben. `ALLOWED_ORIGIN` wird nicht geheim gespeichert, sondern beim Deploy automatisch zu `https://GITHUB-BENUTZER.github.io` gesetzt.

### 9. APP_AUTH_SECRET erzeugen

Lokal in einem Terminal erzeugen (OpenSSL ist auf macOS/Linux und in Git Bash üblich):

```bash
openssl rand -base64 48
```

Die komplette Ausgabe als `APP_AUTH_SECRET` speichern. Nicht wiederverwenden oder committen. Ein Wechsel meldet alle bestehenden Sitzungen ab.

`APP_USER_ID` und `APP_PASSWORD` werden exakt verglichen. Führende oder nachgestellte Leerzeichen gehören daher zum jeweiligen Wert und müssen beim Login ebenfalls eingegeben werden.

### 10. GitHub Action starten

Nach einem Push auf `main` startet `.github/workflows/deploy.yml`. Alternativ **Actions → Deploy GitHub Pages and Worker → Run workflow**. Der Job setzt Worker-Secrets, deployed Worker samt Durable Object und veröffentlicht `index.html`, `style.css`, `app.js` sowie den `assets`-Ordner auf Pages.

### 11. Deployment prüfen

Beide Jobs müssen grün sein. Cloudflare **Workers & Pages → random-fact-api → Settings → Variables and Secrets** muss vier verschlüsselte Secrets sowie `ALLOWED_ORIGIN` zeigen. `GET /health` funktioniert nur mit der erlaubten Browser-Origin; `/fact` liefert ohne gültiges Bearer-Token `401`.

### 12. GitHub-Pages-Link öffnen

Die veröffentlichte Adresse steht unter **Settings → Pages**, typischerweise:

```text
https://MEINNAME.github.io/random-fact/
```

Diese URL an Freunde schicken – niemals die OpenAI-Zugangsdaten. Endnutzer installieren nichts.

### 13. Login testen

Mit `APP_USER_ID` und `APP_PASSWORD` anmelden. Falsches Passwort muss abgewiesen werden. Nach Login einen Fact laden, kopieren, Verlauf zurücksetzen und abmelden. In DevTools darf unter Storage nur das Sitzungstoken in `sessionStorage` und die ID-Liste in `localStorage` erscheinen; kein API-Key oder Passwort. Im Netzwerk wird das eingegebene Passwort ausschließlich im verschlüsselten HTTPS-Request an den Worker übertragen; das konfigurierte Worker-Secret wird nie an das Frontend ausgeliefert. OpenAI-Aufrufe erfolgen ausschließlich vom Worker.

Antwortet `/login` trotz neu gesetzter Zugangsdaten noch mit `401`, unter **Actions** zuerst prüfen, ob nach der letzten Secret-Änderung der Workflow **Deploy GitHub Pages and Worker** erfolgreich ausgeführt wurde. Repository-Secrets lösen allein keinen neuen Deploy aus; deshalb den Workflow über **Run workflow** erneut starten. Anschließend wegen des Login-Limits bis zu 15 Minuten warten, falls zuvor zehn Fehlversuche erfolgt sind. Zugangsdaten werden nicht protokolliert.

## Endpunkte

- `POST /login` mit `{ "username": "…", "password": "…" }`
- `POST /fact` mit `{}` oder optional `{ "location": { "latitude": 52.52, "longitude": 13.405 } }` und `Authorization: Bearer SESSION_TOKEN`
- `GET /health`

Fehler enthalten nur neutrale Meldungen. Nach dem Tageslimit antwortet der Worker mit HTTP 429 und `{ "error": "Tageslimit erreicht", "remaining": 0 }`.

## Lokale Prüfungen

```bash
npm test
node --check app.js
node --check worker/src/index.js
```

Die automatisierten Tests verwenden ausschließlich Mocks und keinen echten OpenAI-Key. `.gitignore` schließt lokale `.env`-/`.dev.vars`-Dateien und Wrangler-Zustand aus.
