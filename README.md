# Private Random Fact

Eine installierungsfreie Dark-Mode-Web-App mit serverseitigem Login. Das statische Frontend läuft auf GitHub Pages; Authentifizierung, Limits und der einzige OpenAI-Aufruf laufen in einem Cloudflare Worker.

## Architektur und Sicherheitsprinzip

```text
Browser → GitHub Pages → Cloudflare Worker → OpenAI Responses API
```

Ein Login in einer statischen GitHub-Pages-Seite **allein schützt keinen API-Key**: Alles, was an den Browser ausgeliefert wird, ist einsehbar. Die Sicherheit entsteht hier dadurch, dass `OPENAI_API_KEY`, Passwort-Hash und Signierschlüssel ausschließlich verschlüsselte Worker-Secrets sind. Das Frontend kennt nur die öffentliche Worker-URL. Es ruft niemals OpenAI direkt auf.

- Der Worker prüft Benutzername und PBKDF2-SHA-256-Hash serverseitig.
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
worker/src/index.js  worker/wrangler.toml
.github/workflows/deploy.yml
```

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

Für **jeden** Wert: **GitHub → Repository → Settings → Secrets and variables → Actions → Repository secrets → New repository secret**. Folgende Repository-Secrets anlegen:

| Name | Inhalt |
|---|---|
| `OPENAI_API_KEY` | OpenAI API-Key |
| `APP_USER_ID` | erlaubter Benutzername |
| `APP_PASSWORD_HASH` | Ergebnis aus Schritt 10, nie das Klartextpasswort |
| `APP_AUTH_SECRET` | Ergebnis aus Schritt 9 |
| `CLOUDFLARE_API_TOKEN` | Token aus Schritt 6 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare-Konto-ID |
| `CLOUDFLARE_WORKER_NAME` | optional; sonst `random-fact-api` |

Secrets niemals zusätzlich unter **Variables** anlegen. Der Workflow leitet die vier App-Secrets per Standardeingabe an `wrangler secret put`; sie werden weder in Argumenten noch per `echo` ausgegeben. `ALLOWED_ORIGIN` wird nicht geheim gespeichert, sondern beim Deploy automatisch zu `https://GITHUB-BENUTZER.github.io` gesetzt.

### 9. APP_AUTH_SECRET erzeugen

Lokal in einem Terminal erzeugen (OpenSSL ist auf macOS/Linux und in Git Bash üblich):

```bash
openssl rand -base64 48
```

Die komplette Ausgabe als `APP_AUTH_SECRET` speichern. Nicht wiederverwenden oder committen. Ein Wechsel meldet alle bestehenden Sitzungen ab.

### 10. Passwort-Hash erzeugen

Node.js 20+ lokal verwenden. Dieser Befehl fragt verdeckt nach dem Passwort, erzeugt ein zufälliges 16-Byte-Salt und 310.000 PBKDF2-SHA-256-Runden. Das Passwort wird nicht in die Shell-History geschrieben:

```bash
read -s -p "Passwort: " PASSWORD; echo
printf '%s' "$PASSWORD" | node -e 'const c=require("crypto"),fs=require("fs");const p=fs.readFileSync(0),s=c.randomBytes(16),i=310000,h=c.pbkdf2Sync(p,s,i,32,"sha256"),b=x=>x.toString("base64url");console.log(`pbkdf2_sha256$${i}$${b(s)}$${b(h)}`)'
unset PASSWORD
```

Nur die Ausgabe `pbkdf2_sha256$...` als `APP_PASSWORD_HASH` speichern. Salt und Rundenzahl dürfen Teil des Hashformats sein; das Klartextpasswort darf nirgends gespeichert werden.

Beim Kopieren versehentlich mit übernommene Leerzeichen oder Zeilenumbrüche vor beziehungsweise nach `APP_USER_ID`, `APP_PASSWORD_HASH` und `APP_AUTH_SECRET` werden vom Worker ignoriert. Leerzeichen im tatsächlich eingegebenen Passwort bleiben dagegen immer erhalten und müssen exakt dem Passwort entsprechen, aus dem der Hash erzeugt wurde.

Der Worker dekodiert Salt und abgeleiteten Schlüssel strikt als Base64url-Bytes und leitet immer einen 32-Byte-Schlüssel ab. Das Format ist daher exakt `pbkdf2_sha256$iterations$base64url(salt)$base64url(derivedKey)`; Text-Salts und normales Base64 werden nicht akzeptiert.

### 11. GitHub Action starten

Nach einem Push auf `main` startet `.github/workflows/deploy.yml`. Alternativ **Actions → Deploy GitHub Pages and Worker → Run workflow**. Der Job setzt Worker-Secrets, deployed Worker samt Durable Object und veröffentlicht ausschließlich `index.html`, `style.css`, `app.js` auf Pages.

### 12. Deployment prüfen

Beide Jobs müssen grün sein. Cloudflare **Workers & Pages → random-fact-api → Settings → Variables and Secrets** muss vier verschlüsselte Secrets sowie `ALLOWED_ORIGIN` zeigen. `GET /health` funktioniert nur mit der erlaubten Browser-Origin; `/fact` liefert ohne gültiges Bearer-Token `401`.

### 13. GitHub-Pages-Link öffnen

Die veröffentlichte Adresse steht unter **Settings → Pages**, typischerweise:

```text
https://MEINNAME.github.io/random-fact/
```

Diese URL an Freunde schicken – niemals die OpenAI-Zugangsdaten. Endnutzer installieren nichts.

### 14. Login testen

Mit `APP_USER_ID` und dem bei Schritt 10 verwendeten Passwort anmelden. Falsches Passwort muss abgewiesen werden. Nach Login einen Fact laden, kopieren, Verlauf zurücksetzen und abmelden. In DevTools darf unter Storage nur das Sitzungstoken in `sessionStorage` und die ID-Liste in `localStorage` erscheinen; kein API-Key oder Passwort. Im Netzwerk erscheinen nur Requests zum Worker, nie zu `api.openai.com`.

Antwortet `/login` trotz neu gesetzter Zugangsdaten noch mit `401`, unter **Actions** zuerst prüfen, ob nach der letzten Secret-Änderung der Workflow **Deploy GitHub Pages and Worker** erfolgreich ausgeführt wurde. Repository-Secrets lösen allein keinen neuen Deploy aus; deshalb den Workflow über **Run workflow** erneut starten. Anschließend wegen des Login-Limits bis zu 15 Minuten warten, falls zuvor zehn Fehlversuche erfolgt sind. Die Worker-Logs zeigen nur booleans wie `username matches` und `password verification result`, niemals die Zugangsdaten selbst.

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
