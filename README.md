# sap-notes-mcp

MCP-Server für die Suche in SAP Notes / KBAs im **geschützten** SAP-Support-Bereich.

Da SAP keine offizielle Notes-API anbietet, arbeitet der Server mit einer
authentifizierten Browser-Session (Playwright):

1. **Einmalig** interaktiv einloggen (`npm run login`) — inkl. MFA, im sichtbaren Browser.
2. Session (Cookies + localStorage) wird nach `~/.sap-notes-mcp/session.json` (mode 0600) gespeichert.
3. Der MCP-Server läuft danach **headless** und nutzt diese Session.
4. Läuft die Session ab und sind `SAPUSER`/`SAPPASSWORD` hinterlegt (in der Umgebung oder in einer `.env`), meldet
   sich der Server **selbst** neu an und wiederholt den Tool-Aufruf (siehe
   [Automatischer Login](#automatischer-login-sapuser--sappassword)). Ohne Credentials —
   oder wenn SAP MFA verlangt — liefern die Tools eine klare Fehlermeldung → `npm run login`
   erneut ausführen und die Anfrage einfach wiederholen; der Server liest die neue Session
   ohne Neustart ein. Fehlt dem S-User dagegen nur die **Berechtigung** für eine bestimmte
   Note (HTTP 403), wird das als solches gemeldet; ein erneuter Login ändert daran nichts.
5. Nach längerer Inaktivität (Default 10 min) beendet der Server den headless Browser,
   um RAM zu sparen; der nächste Tool-Aufruf startet ihn automatisch neu.

## Setup

```bash
npm install
npx playwright install chromium
npm run build
npm test               # Offline-Unit-Tests, keine SAP-Session erforderlich
npm run login          # sichtbarer Browser: S-User + MFA, dann Enter im Terminal
npm start              # optionaler Smoke-Test (stdio, wartet auf MCP-Client)
```

### ENV-Variablen laden

Server und Login-CLI lesen beim Start selbst eine `.env`-Datei ein — kein
`--env-file`-Flag und kein `dotenv`-Dependency nötig:

```bash
cp .env.example .env   # Werte anpassen
chmod 600 .env         # enthält ggf. das Passwort
```

Eine `.env` ist **optional** — alle Variablen können genauso aus der Prozessumgebung
kommen (Shell-Export, `env`-Block in der MCP-Client-Config, systemd `Environment=`,
Container-Secrets). Regeln:

* **Echte Umgebungsvariablen haben Vorrang** vor Werten aus der Datei.
* Das gilt auch über Alt-Namen hinweg: ein in der Shell exportiertes `SAP_USERNAME`
  schlägt ein `SAPUSER`, das nur in der Datei steht. Stammen beide aus derselben
  Quelle, gewinnt der bevorzugte Name (`SAPUSER` vor `SAP_USERNAME`).
* Ohne `SAP_ENV_FILE` werden `<Repo-Root>/.env` und dann `$PWD/.env` probiert; die
  erste existierende Datei gewinnt.
* `SAP_ENV_FILE` ist **exklusiv**: gesetzt, wird ausschließlich dieser Pfad gelesen und
  nicht still auf eine andere `.env` zurückgefallen (sonst würde man sich mit dem
  falschen S-User anmelden). Ist die Datei nicht lesbar, kommt eine Warnung auf stderr
  und es geht mit der Prozessumgebung weiter.
* Ist die Datei für andere Benutzer lesbar, warnt der Server ebenfalls auf **stderr**.

### Automatischer Login (`SAPUSER` / `SAPPASSWORD`)

```dotenv
SAPUSER=S0001234567
SAPPASSWORD=…
```

oder, ganz ohne Datei:

```bash
export SAPUSER=S0001234567 SAPPASSWORD=…
npm start
```

Damit gilt:

* `npm run login` füllt das Logon-Formular automatisch aus. Das Browserfenster bleibt
  sichtbar — MFA, Passwortwechsel o. ä. lassen sich von Hand abschließen.
* Der **Server** meldet sich bei abgelaufener Session headless selbst an und wiederholt
  den fehlgeschlagenen Tool-Aufruf **einmal**. Der Ablauf ist serialisiert: parallele
  Tool-Aufrufe lösen nie mehrere gleichzeitige Logins aus.
* Schlägt der Auto-Login fehl, wird er für `SAP_AUTO_LOGIN_COOLDOWN_MS` (Default 5 min)
  nicht erneut versucht; bei MFA oder abgelehnten Credentials für die restliche Laufzeit
  des Prozesses. So kann kein Retry-Loop den S-User sperren. Die Ursache steht auf stderr,
  der Client bekommt die gewohnte Meldung mit dem Hinweis auf `npm run login`.
* `SAP_AUTO_LOGIN=0` schaltet die Automatik ab, ohne die Credentials zu entfernen.

Sicherheitshinweise: Das Passwort steht im Klartext in der `.env` (bereits in
`.gitignore`) — daher `chmod 600` und auf Multi-User-Hosts besser bei
`npm run login` + gespeicherter Session bleiben. MFA lässt sich prinzipbedingt nicht
automatisieren; ein MFA-pflichtiger S-User braucht weiterhin den interaktiven Login.

Ohne `SAPPASSWORD` verhält sich alles exakt wie bisher (`SAPUSER` bzw. das ältere
`SAP_USERNAME` dient dann nur dem Vorbefüllen des Benutzerfelds).

## Einbindung in Claude Desktop / Claude Code

`claude_desktop_config.json` bzw. `.mcp.json`:

```json
{
  "mcpServers": {
    "sap-notes": {
      "command": "node",
      "args": ["/absoluter/pfad/sap-notes-mcp/dist/server.js"]
    }
  }
}
```

Keine Credentials in der Config nötig — der Server nutzt ausschliesslich die gespeicherte Session.

## Tools

| Tool | Parameter | Rückgabe |
|---|---|---|
| `sap_notes_search` | `query` (string), `limit` (1–25, default 10) | Note-Nummer, Titel, URL je Treffer |
| `sap_note_get` | `number` (4–10 Ziffern) | Vollständiger Note-Inhalt als Markdown |
| `sap_note_attachments` | `number` (4–10 Ziffern) | Datei-Anhänge der Note (Name, Größe, Download-URL) |
| `sap_note_attachment_get` | `number`, optional `fileName` | Lädt einen Anhang nach `SAP_ATTACHMENT_DIR` herunter; Text-Anhänge (.txt, .sql, .csv, …) zusätzlich inline |
| `sap_session_status` | – | Ob die gespeicherte Session noch gültig ist |

Hinweis zu Anhängen: Solange eine Note den Banner „A new version is in preparation“
zeigt, blendet das Portal Anhänge portalweit aus (KBA 3453681) — die Liste ist dann
leer, bis SAP die neue Version freigibt. `fileName` darf entfallen, wenn die Note genau
einen Anhang hat; sonst genügt ein eindeutiger Teilstring (case-insensitive).
Downloads sind auf 100 MB begrenzt; das Limit wird auch bei chunked Responses anhand
der tatsächlich empfangenen Bytes durchgesetzt. Redirects werden nur zu HTTPS-Hosts
unter `sap.com` verfolgt.

## Konfiguration (ENV, alles optional)

| Variable | Default | Zweck |
|---|---|---|
| `SAP_STATE_PATH` | `~/.sap-notes-mcp/session.json` | Ablage der Session |
| `SAP_SEARCH_URL` | `https://me.sap.com/search?q={query}&tab=notes` | Such-URL (`{query}`) |
| `SAP_COVEO_ORG` | `sapamericaproductiontyfzmfz0` | Coveo-Organisation |
| `SAP_COVEO_TOKEN_URL` | SAP-for-Me-Token-Endpunkt | Endpunkt für kurzlebige Such-Token |
| `SAP_COVEO_SEARCH_URL` | Coveo REST Search v2 | Such-Endpunkt inkl. Organisation |
| `SAP_COVEO_SEARCH_HUB` | `SAP for Me` | Coveo Search Hub / Pipeline-Kontext |
| `SAP_NOTE_URL` | `https://me.sap.com/notes/{id}` | Detail-URL (`{id}`) |
| `SAP_NOTE_API_URL` | `https://me.sap.com/backend/raw/sapnotes/Detail?q={id}&t=E&isVTEnabled=false` | JSON-API hinter der Note-Seite; Quelle der Anhangsliste (`{id}`) |
| `SAP_ATTACHMENT_DIR` | `~/Downloads/sap-notes` | Zielordner für Anhänge (ein Unterordner je Note-Nummer, `~` wird expandiert) |
| `SAP_PROBE_URL` | `https://me.sap.com/notes/2170696` | Seite zur Session-Prüfung |
| `SAP_NAV_TIMEOUT_MS` | `60000` | Navigations-Timeout |
| `SAP_API_TIMEOUT_MS` | `60000` | Timeout für direkte HTTP-API-Aufrufe (Coveo-Token/-Suche, Note-Detail-API, Anhang-Download) |
| `SAP_NETWORK_IDLE_TIMEOUT_MS` | `4000` | Kurze Wartezeit auf Netzwerk-Ruhe |
| `SAP_RENDER_SETTLE_MS` | `2500` | Wartezeit für spätes SPA-Rendering |
| `SAP_IDLE_TIMEOUT_MS` | `600000` | Browser nach Inaktivität schließen (0 = deaktiviert) |
| `SAPUSER` | – | S-User für Login-CLI und automatischen Login (Alt-Name: `SAP_USERNAME`) |
| `SAPPASSWORD` | – | Passwort für den automatischen Login (Alt-Name: `SAP_PASSWORD`); nur zusammen mit `SAPUSER` wirksam |
| `SAP_AUTO_LOGIN` | `1` | Automatischen Re-Login des Servers abschalten (`0`), ohne Credentials zu entfernen |
| `SAP_AUTO_LOGIN_COOLDOWN_MS` | `300000` | Sperrzeit nach fehlgeschlagenem Auto-Login |
| `SAP_LOGIN_STEP_TIMEOUT_MS` | `30000` | Timeout je Login-Schritt |
| `SAP_ENV_FILE` | – | Alternativer Pfad zur `.env`; exklusiv — kein Rückfall auf eine andere Datei |
| `SAP_LOGIN_USER_SELECTOR` | `input#j_username, …` | Selektor des Benutzerfelds im Logon-Formular |
| `SAP_LOGIN_PASSWORD_SELECTOR` | `input#j_password, …` | Selektor des Passwortfelds |
| `SAP_LOGIN_SUBMIT_SELECTOR` | `#logOnFormSubmit, …` | Selektor des Submit-Buttons |
| `SAP_LOGIN_MFA_SELECTOR` | `input[autocomplete='one-time-code'], …` | Erkennung der MFA-Abfrage (bricht den Auto-Login ab) |

## Wenn SAP das Portal umbaut

Der Server benutzt bewusst **keine** hartkodierten CSS-Klassen:

* Suche = alle Links, deren `href` auf eine Note-Nummer zeigt (`/notes/<n>`, `/knowledge/en/<n>`, …).
* Detail = grösster Content-Container (`main`, `article`, `[role=main]`, …) → Markdown.
* Anhänge = Note-Detail-JSON-API zuerst; schlägt sie fehl, werden Anhang-Links
  (`…attachment…`, `/documents/…`) aus der gerenderten Note-Seite gelesen.
  Heruntergeladen wird ausschliesslich per HTTPS von `*.sap.com`-Hosts.

Ändert SAP die Routen, genügt in der Regel ein Anpassen von `SAP_SEARCH_URL` / `SAP_NOTE_URL`
(URL im Browser kopieren, Suchbegriff durch `{query}`, Nummer durch `{id}` ersetzen).

## Grenzen

* Nur für die **eigene** Nutzung mit dem **eigenen** S-User gedacht. Ein zentral gehosteter
  Server mit Technik-S-User verteilt faktisch lizenzierte Portalinhalte weiter — das ist
  vorab mit den SAP-Nutzungsbedingungen abzugleichen.
* Kein Bulk-Crawling: Tool-Aufrufe werden pro Serverprozess serialisiert. Die Suche liest
  höchstens drei Coveo-Ergebnisseiten, bis das angeforderte Trefferlimit erreicht ist.
* Korrekturanweisungen (ABAP) werden nicht ausgelesen; dafür wäre ein zusätzlicher
  OData-Call gegen den Note-Assistant-Service nötig.

## Entwicklung und Diagnose

```bash
npm run typecheck
npm run lint
npm test
node dist/test-search.js "HANA Revision"       # benötigt eine gültige Session
node dist/diagnose-search.js "HANA Revision"   # interaktiv
```

Das Diagnose-Skript entfernt Zugangstoken und Cookie-Header vor dem Schreiben und legt
`diagnose-coveo.json` mit Dateimodus `0600` ab. Der Mitschnitt kann dennoch geschützte
SAP-Suchergebnisse enthalten und sollte nicht weitergegeben oder committed werden.

Lint (typescript-eslint, type-aware) und die Offline-Tests laufen zusätzlich in der CI
(`.github/workflows/ci-workflow.yml`) bei jedem Push/PR — ohne SAP-Session und ohne Browser.
