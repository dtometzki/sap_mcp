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

Server, Login-CLI und Diagnose-Skripte lesen beim Start selbst eine `.env`-Datei ein — kein
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

Die automatische Eingabe von Benutzer und Passwort ist ausschließlich auf
`https://accounts.sap.com` und `https://accounts.sap.cn` erlaubt (Standardport 443).
Andere SAP-Subdomains sind keine freigegebenen Login-Seiten. Verwendet die Anmeldung
einen anderen Identity Provider, ist der interaktive Login ohne hinterlegtes Passwort
erforderlich. Die Origin wird vor jeder Eingabe erneut geprüft.

Fehlerausgaben enthalten nur explizite Anwendungsmeldungen oder feste Fehlerkategorien.
Interne Playwright-Aufrufprotokolle und Login-Banner werden nicht ausgegeben, da sie
Tokens, Cookies oder Passworteingaben enthalten können. Details zur Ablehnung einer
Anmeldung lassen sich im interaktiven Browser ansehen.

Sicherheitshinweise: Das Passwort steht im Klartext in der `.env` (bereits in
`.gitignore`) — daher `chmod 600` und auf Multi-User-Hosts besser bei
`npm run login` + gespeicherter Session bleiben. MFA lässt sich prinzipbedingt nicht
automatisieren; ein MFA-pflichtiger S-User braucht weiterhin den interaktiven Login.

Ohne `SAPPASSWORD` verhält sich alles exakt wie bisher (`SAPUSER` bzw. das ältere
`SAP_USERNAME` dient dann nur dem Vorbefüllen des Benutzerfelds).

## Lokale Web-App

Die Web-App ergänzt den MCP um eine deutsche Oberfläche für Suche, vollständige
Note-Ansicht, verschlüsselte SAP-Zugangsdaten und einen durchsuchbaren Suchverlauf.
Sie läuft für **eine Person mit einem SAP-Konto auf demselben Rechner**.

```bash
npm install
npx playwright install chromium
npm run web:start     # im Hintergrund, Terminal bleibt frei
# http://127.0.0.1:3210 im Browser öffnen
npm run web:status    # läuft? PID und Adresse
npm run web:stop      # beenden, Tresor wird gesperrt
```

`npm run web` startet den Server stattdessen im Vordergrund (Strg+C beendet ihn).
Der Hintergrundstart schreibt die Ausgabe nach `web.log` im Datenverzeichnis und
meldet erst Erfolg, wenn der Server auf dem Port antwortet. Er überlebt das Schließen
des Terminals, nicht aber Abmelden oder Neustart des Rechners – danach erneut
`npm run web:start`. `web:stop` und `web:status` nutzen dieselben Variablen
`SAP_WEB_PORT`/`SAP_WEB_DATA_DIR` wie der Start (aus `.env` oder der Umgebung).

1. Beim ersten Aufruf ein **Master-Passwort mit mindestens 12 Zeichen** festlegen.
2. Unter **Einstellungen** SAP-Benutzer und SAP-Passwort verschlüsselt speichern.
3. Die App prüft die Session und meldet sich automatisch an. Bei MFA auf
   **SAP-Anmeldung abschließen** klicken, im sichtbaren SAP-Browserfenster anmelden
   und anschließend in der App **Anmeldung prüfen** wählen. Abbrechen oder fünf
   Minuten Zeitüberschreitung schließen das Anmeldefenster.
4. Nach Fehlermeldung, Produkt oder Problem suchen (2–500 Zeichen; 1–25 Treffer,
   Standard 10), oder eine Note direkt über ihre 4–10-stellige Nummer öffnen.
   **Als PDF sichern** in der Note-Ansicht öffnet den Druckdialog des Browsers
   (macOS: „Als PDF sichern“); gedruckt wird nur die Note mit Quelle und
   Abrufzeitpunkt, der vorgeschlagene Dateiname ist „SAP Note <Nr> – <Titel>“.
5. Im **Suchverlauf** erfolgreiche Suchen einschließlich null Treffern erneut
   ausführen, filtern oder löschen. Gespeichert werden Suchtext, Zeitpunkt,
   Trefferlimit und Trefferzahl. Fehler und direkt geöffnete Notes erscheinen
   nicht im Suchverlauf; vollständige Note-Inhalte werden nicht dauerhaft gespeichert.
   Der Verlauf behält die 500 neuesten Einträge.

Auf Desktop-Fenstern ab 900 × 650 Pixeln bleiben Kopfzeile, Suche und Footer mit
**About** gemeinsam sichtbar. Lange Trefferlisten und Notes scrollen innerhalb
ihrer Bereiche. Technische Bezeichner, Code und Tabellen passen sich der Breite an;
kleinere Fenster verwenden eine vertikal scrollbare Ansicht.

**Sperren** beendet die SAP-Browser, verwirft entschlüsselte Daten und meldet alle
App-Browser-Sitzungen ab. Nach einem Serverneustart ist der Tresor ebenfalls gesperrt.
Das Schließen eines Tabs sperrt den Server nicht; stattdessen sperrt der Server nach
30 Minuten ohne Suche, Note-Aufruf oder Einstellungsänderung automatisch
(`SAP_WEB_IDLE_LOCK_MS`). Das reine Offenhalten der Seite zählt nicht als Aktivität.
Weitere Browser benötigen das Master-Passwort zum Entsperren ihrer eigenen Sitzung.
Ändern des Master-Passworts meldet die anderen Browser-Sitzungen ab.

Über **About** im Footer sind App-Name, Version sowie Hash, Nachricht und Datum
des letzten Commits sichtbar – auch bei gesperrtem Tresor. Die Angaben entsprechen
dem Projektstand beim Serverstart. Nach einem Update die App neu starten; bei einer
Installation ohne Git-Metadaten steht beim Commit „Nicht verfügbar“.

### Web-Konfiguration und Speicherung

| Variable | Default | Zweck |
|---|---|---|
| `SAP_WEB_PORT` | `3210` | Lokaler HTTP-Port, 1–65535. Ist der Port belegt, bricht der Start mit einer entsprechenden Meldung ab |
| `SAP_WEB_DATA_DIR` | `~/.sap-notes-web` | Datenverzeichnis mit `vault.enc`, Prozess-Sperrdatei `server.lock` und `web.log` des Hintergrundstarts |
| `SAP_WEB_IDLE_LOCK_MS` | `1800000` | Tresor nach Inaktivität sperren, alle Browser-Sitzungen abmelden (0 = deaktiviert) |

Nur die exakte Adresse `http://127.0.0.1:<Port>` wird akzeptiert, kein Netzwerkzugriff,
kein Reverse-Proxy und kein öffentliches Hosting. Das lokale HTTP-Cookie hat
`HttpOnly` und `SameSite=Strict`; Host-/Origin-Prüfung, JSON-Anfragen und eine
restriktive Content Security Policy schützen die lokale Oberfläche. Es gibt keine
CORS-Freigabe. Maximal fünf Entsperr-/Passwortprüfungen pro Minute sind erlaubt.

Der Tresor verschlüsselt **SAP-Zugangsdaten, Cookies/localStorage und Suchverlauf**
mit AES-256-GCM. Aus dem Master-Passwort wird mit scrypt (`N=131072`, `r=8`, `p=1`)
ein Schlüssel abgeleitet. Jeder Schreibvorgang verwendet eine neue 12-Byte-Nonce und
einen 16-Byte-Authentifizierungstag. Die Datei wird atomar mit Rechten `0600` ersetzt;
das Datenverzeichnis erhält `0700`. Der Schlüssel bleibt nur während der Entsperrung
im Arbeitsspeicher. Entschlüsselte Session-Dateien werden nicht angelegt.

Die Web-App verwendet die bestehenden SAP-Endpunkte, Timeouts und Origin-Prüfungen,
aber **importiert keine Zugangsdaten aus `.env`/Umgebungsvariablen und keine
MCP-Session-Datei**. Ihr automatischer Login wird durch die im Tresor gespeicherten
Zugangsdaten aktiviert. `SAP_AUTO_LOGIN` ist eine Einstellung des MCP; die Web-App
verwaltet ihren Zugang unabhängig davon. Ein Kontowechsel oder das Löschen der
Zugangsdaten entfernt die Web-SAP-Session. MCP und Login-CLI funktionieren wie bisher.

HTML aus Notes wird als Text behandelt, externe Bilder werden nicht geladen und
Links auf sichere Protokolle begrenzt. Anhänge sind weiterhin über den MCP verfügbar;
die Web-App unterstützt in dieser Version keine Anhang-Downloads.

Browser mit WebMCP-Unterstützung können die sichtbaren Aktionen
`search_sap_notes` und `open_sap_note` nutzen. Diese benötigen dieselbe entsperrte
App-Sitzung und dieselben Prüfungen wie die Oberfläche. Es gibt keine Werkzeuge für
Passwörter oder das Entsperren. Ohne WebMCP funktioniert die Oberfläche vollständig.

### Master-Passwort vergessen / Sicherung

Es gibt **keine Passwortwiederherstellung**. Für eine Sicherung die App beenden und
`vault.enc` aus dem Datenverzeichnis kopieren; zum Wiederherstellen sind die Datei
und das zugehörige Master-Passwort nötig. Bestehende Daten nicht überschreiben.

Für einen neuen, leeren Tresor die App beenden und `vault.enc` umbenennen oder
bewusst löschen. Beim nächsten Start kann ein neuer Tresor angelegt werden. Ohne
das alte Passwort sind die bisherigen Zugangsdaten und der Suchverlauf nicht mehr
zugänglich. Eine verwaiste `server.lock` nach einem Absturz wird automatisch erkannt;
eine beschädigte Sperrdatei erst entfernen, nachdem alle Web-App-Prozesse beendet sind.

### Web-Tests

`npm run build`, `npm run lint` und `npm test` prüfen auch Verschlüsselung,
HTTP-Zugriffsschutz, Session-Isolation, Suchverlauf, Sperr-Rennen und die
Browser-Bedienung gegen lokale SAP-Fixtures. Der WebMCP-Vertrag wird mit einer
Test-Registry geprüft; das ersetzt keine Prüfung einer nativen Browser-Implementierung.
Die Tests verwenden keine echten SAP-Zugangsdaten und senden keine SAP-Anfragen.

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
| `sap_note_attachments` | `number` (4–10 Ziffern) | Datei-Anhänge der Note (Name, Größe; ohne Download-URL) |
| `sap_note_attachment_get` | `number`, optional `fileName` | Lädt einen Anhang nach `SAP_ATTACHMENT_DIR` herunter; Text-Anhänge (.txt, .sql, .csv, …) zusätzlich inline |
| `sap_session_status` | – | Ob die gespeicherte Session noch gültig ist |

Hinweis zu Anhängen: Solange eine Note den Banner „A new version is in preparation“
zeigt, blendet das Portal Anhänge portalweit aus (KBA 3453681) — die Liste ist dann
leer, bis SAP die neue Version freigibt. `fileName` darf entfallen, wenn die Note genau
einen Anhang hat; sonst genügt ein eindeutiger Teilstring (case-insensitive).
Downloads sind auf 100 MB begrenzt; das Limit wird auch bei chunked Responses anhand
der tatsächlich empfangenen Bytes durchgesetzt. Redirects werden nur zu HTTPS-Hosts
unter `sap.com` verfolgt. Die Liste enthält absichtlich keine Download-URLs (die
können signierte Token tragen). Dateien landen in einem Note-Unterordner mit
Rechten `0700`, die Datei selbst mit `0600`. `SAP_API_TIMEOUT_MS` begrenzt beim Download
die Wartezeit zwischen zwei Datenblöcken, nicht die Gesamtdauer — große Anhänge auf
langsamen Leitungen laufen durch, ein hängender Transfer bricht trotzdem ab.

Hinweis zu Proxys: Coveo-Token/-Suche und die Note-Detail-API laufen über den
HTTP-Client des Playwright-Browsers, der Anhang-Download über Nodes eingebautes `fetch`
(undici). Hinter einem Corporate-Proxy kann daher das eine funktionieren und das andere
nicht: Für den Browser gilt die Proxy-Konfiguration des Systems bzw. Playwrights, `fetch`
beachtet `HTTPS_PROXY` nur, wenn Node mit `NODE_USE_ENV_PROXY=1` (Node ≥ 24) gestartet
wird. Bei einem hängenden Download also zuerst prüfen, ob der Proxy für `fetch` gesetzt ist.

Die drei direkten API-Aufrufe folgen keinen HTTP-Weiterleitungen. Ein Redirect zu
einem freigegebenen Login-Origin wird als abgelaufene Session behandelt; andere
Redirects führen zu einem Fehler beziehungsweise dem bestehenden DOM-Fallback.
Bei dauerhaft geänderten API-Adressen muss die konfigurierte URL direkt auf den
neuen Endpunkt zeigen. Für Anhang-Downloads bleibt die Prüfung jedes Redirect-Ziels
vor dem nächsten HTTP-Aufruf bestehen.

Schlägt die Coveo-Suche bzw. die Note-Detail-API fehl und liefert auch der DOM-Fallback
nichts, melden `sap_notes_search` und `sap_note_attachments` den ursprünglichen Fehler
statt „keine Treffer“ / „keine Anhänge“ — eine leere Antwort ist damit immer eine echte
Antwort des Portals.

## Konfiguration (ENV, alles optional)

| Variable | Default | Zweck |
|---|---|---|
| `SAP_STATE_PATH` | `~/.sap-notes-mcp/session.json` | Ablage der Session (`~` wird expandiert) |
| `SAP_SEARCH_URL` | `https://me.sap.com/search?q={query}&tab=notes` | Such-URL (`{query}`) |
| `SAP_COVEO_ORG` | `sapamericaproductiontyfzmfz0` | Coveo-Organisation |
| `SAP_COVEO_TOKEN_URL` | SAP-for-Me-Token-Endpunkt | Endpunkt für kurzlebige Such-Token |
| `SAP_COVEO_SEARCH_URL` | Coveo REST Search v2 | Such-Endpunkt inkl. Organisation |
| `SAP_COVEO_SEARCH_HUB` | `SAP for Me` | Coveo Search Hub / Pipeline-Kontext |
| `SAP_NOTE_URL` | `https://me.sap.com/notes/{id}` | Detail-URL (`{id}`) |
| `SAP_NOTE_API_URL` | `https://me.sap.com/backend/raw/sapnotes/Detail?q={id}&t=E&isVTEnabled=false` | JSON-API hinter der Note-Seite; Quelle der Anhangsliste (`{id}`) |
| `SAP_ATTACHMENT_DIR` | `~/Downloads/sap-notes` | Zielordner für Anhänge (ein Unterordner je Note-Nummer mit `0700`, `~` wird expandiert) |
| `SAP_ATTACHMENT_COOKIE_HOSTS` | – | Zusätzliche Hosts, die beim Anhang-Download Session-Cookies erhalten dürfen (kommagetrennt; Default: `me.sap.com`, `*.support.sap.com`, `accounts.sap.com`) |
| `SAP_PROBE_URL` | `https://me.sap.com/notes/2170696` | Seite zur Session-Prüfung; muss `https://*.sap.com` oder `https://*.sap.cn` sein. Die Prüfung fragt zuerst `SAP_NOTE_API_URL` für dieselbe Note-Nummer ab und rendert die Seite nur bei mehrdeutiger Antwort |
| `SAP_NAV_TIMEOUT_MS` | `60000` | Navigations-Timeout |
| `SAP_API_TIMEOUT_MS` | `60000` | Timeout für direkte HTTP-API-Aufrufe (Coveo-Token/-Suche, Note-Detail-API); beim Anhang-Download maximale Wartezeit zwischen zwei Datenblöcken |
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

Alle Millisekunden-Werte müssen im von Node unterstützten Timer-Bereich von `0` bzw. `1`
bis `2147483647` liegen; `0` ist nur bei den ausdrücklich abschaltbaren Optionen erlaubt.

## Wenn SAP das Portal umbaut

Der Server benutzt bewusst **keine** hartkodierten CSS-Klassen:

* Suche = alle Links, deren `href` auf eine Note-Nummer zeigt (`/notes/<n>`, `/knowledge/en/<n>`, …).
* Detail = auf fachliche Note-Abschnitte (z. B. „Symptom“ / „Solution“) warten und
  deren Inhalt ohne Portal-Navigation, Werkzeugleisten oder Sprachauswahl übernehmen.
  Explizite Artikel ohne diese Abschnittsnamen benötigen einen passenden Note-Titel;
  eine reine Portal-Oberfläche wird nicht als Note akzeptiert. Tabellen und
  Referenzlinks bleiben in Markdown erhalten, Bilder werden ausgelassen.
* Anhänge = Note-Detail-JSON-API zuerst; schlägt sie fehl, werden Anhang-Links
  (`…attachment…`, `/documents/…`) aus der gerenderten Note-Seite gelesen.
  Heruntergeladen wird ausschliesslich per HTTPS von `*.sap.com`-Hosts.

Ändert SAP die Routen, genügt in der Regel ein Anpassen von `SAP_SEARCH_URL` / `SAP_NOTE_URL`
(URL im Browser kopieren, Suchbegriff durch `{query}`, Nummer durch `{id}` ersetzen).
Portal- und Login-URLs müssen HTTPS auf `*.sap.com` / `*.sap.cn` bleiben (die
Coveo-Suche zusätzlich `*.coveo.com`). Andere Werte — `http:`, `file:`, fremde
Hosts — lehnt der Server beim Start ab. Für die automatische Eingabe von Zugangsdaten
gilt die engere Origin-Liste `https://accounts.sap.com` / `https://accounts.sap.cn`.

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
`diagnose-coveo.json` mit Dateimodus `0600` ab. Es behält höchstens 200 XHR-Antworten,
512.000 Zeichen pro Antwort und insgesamt 5.000.000 Antwortzeichen im Speicher. Der
Mitschnitt kann dennoch geschützte SAP-Suchergebnisse enthalten und sollte nicht
weitergegeben oder committed werden.

Lint (typescript-eslint, type-aware) und die Tests laufen zusätzlich in der CI
(`.github/workflows/ci-workflow.yml`) bei jedem Push/PR. Die HTTP- und Browser-Fixtures
benötigen keine SAP-Session und senden keine Anfragen an SAP. CI installiert Chromium
und verlangt erfolgreiche Browser-Tests. Lokal werden Browser-Tests übersprungen,
wenn Chromium fehlt oder nicht gestartet werden darf; die übrigen Tests laufen weiter.
