# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung an [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

## [1.4.2] – 2026-08-01

### Behoben

- Das 100-MB-Limit für Anhänge wird jetzt beim Streamen anhand der tatsächlich
  empfangenen Bytes durchgesetzt. Chunked Responses, fehlende oder falsche
  `Content-Length`-Header können den Prozess nicht mehr durch einen vollständig
  gepufferten, unbegrenzten Response-Body in einen Speicher-DoS zwingen.
- Redirects beim Anhang-Download werden manuell verfolgt und jeder Zielhost wird
  vor dem nächsten Request gegen die HTTPS-`*.sap.com`-Allowlist geprüft. Cookies
  werden für jeden Hop nach den Domain-/Path-Regeln des Browserkontexts neu
  ausgewählt; Redirects auf fremde Hosts werden vor dem Request abgelehnt.

### Geändert

- Anhänge werden zuerst mit Modus `0600` in eine eindeutige temporäre Datei
  gestreamt und erst nach erfolgreichem Abschluss atomar an den Zielpfad verschoben.
  Fehlgeschlagene oder zu große Downloads hinterlassen keine Teildatei.

## [1.4.1] – 2026-07-31

### Geändert

- Ungenutzte Abhängigkeit `@openai/codex-security` entfernt (wurde nirgends
  importiert, zog aber einen großen Paketbaum inkl. `@openai/codex` nach sich —
  unnötige Supply-Chain-Angriffsfläche und ein Node-≥22-Requirement im Konflikt
  mit `engines.node >=20`).
- `npm audit fix`: bekannte Schwachstellen in transitiven Abhängigkeiten behoben
  (`brace-expansion` DoS, Path Traversal in `@hono/node-server` via
  `@modelcontextprotocol/sdk`). `npm audit` meldet 0 Schwachstellen.

## [1.4.0] – 2026-07-31

### Geändert

- Direkte API-Aufrufe (Coveo-Token, Coveo-Suche, Note-Detail-API, Anhang-Download)
  haben jetzt ein explizites Timeout (`SAP_API_TIMEOUT_MS`, Default 60 s). Diese Calls
  laufen serialisiert in der Tool-Queue — ein hängender Request blockierte bisher
  jeden anderen MCP-Client.
- Die Queue-/Recovery-/Persistenz-/Idle-Logik des Servers ist aus `server.ts` in
  `toolRunner.ts` extrahiert und dadurch offline unit-testbar (Serialisierung,
  State-Throttling, Idle-Shutdown, Session-Recovery).

### Behoben

- `intFromEnv` akzeptierte stillschweigend Müll wie `SAP_NAV_TIMEOUT_MS=60000ms`
  (parseInt truncat das zu 60). Ungültige ENV-Werte führen jetzt zu einem klaren
  Fehler beim Start.
- Note-Nummern-Schema wird in `sap_note_get` wiederverwendet statt doppelt definiert;
  Seitenzugriffe laufen über den neuen `withOpenPage`-Helper, sodass ein Fehler im
  Tool-Callback keine offene Seite (und deren Browser-Ressourcen) hinterlassen kann.

### Hinzugefügt

- Unit-Tests für `intFromEnv` und den `ToolRunner` (Reihenfolge, Fehler-Isolation,
  Persist-Throttling, Idle-Shutdown, Recovery bei Session-Ablauf vs. fehlender
  Berechtigung).

## [1.3.1] – 2026-07-25

### Behoben

- `fetchCoveoToken` nutzte noch die alte Login-Erkennung (`/logon|signin|saml2/` auf
  die gesamte URL, 403 = Session-Ablauf) — dieselben zwei Fehler, die in 1.3.1 für
  `attachments.ts` und `session.ts` behoben wurden. Ein 403 am Coveo-Token-Endpoint
  führte in eine Login-Schleife; ein „logon" im Query-String riss die Session ab.
  Jetzt: `assertNotLoggedOut` (gemeinsame Funktion in `session.ts`) und
  `looksLikeLoginPage` statt Substring-Match.
- `sap_session_status` überschrieb bei abgelaufener Session die gespeicherte
  `session.json` mit dem toten Cookie-Jar: Die Prüfung meldet Ablauf per Rückgabewert
  statt per Fehler, galt damit als erfolgreicher Aufruf und löste das periodische
  Zurückschreiben aus. Wer nach `npm run login` „nur mal eben“ den Status prüfte,
  zerstörte damit genau die frisch erzeugte Session. Der Status-Check schreibt jetzt
  keinen State mehr und verwirft bei negativem Ergebnis den toten Browser-Kontext.
- Falscher „Session abgelaufen“-Alarm bei den SAP-Vokabeln *logon* und *signin*:
  Die Erkennung prüfte diese Substrings über die gesamte URL. Eine Suche nach
  „SAP Logon“ (DOM-Fallback) und der Download einer Datei wie `saplogon.ini` galten
  dadurch als Logout — inklusive Abbau des intakten Browsers und Aufforderung zum
  Neu-Login. Geprüft wird jetzt Host und Pfad, nie der Query-String; beim Download
  zusätzlich erst der HTTP-Status, dann die Heuristik (bisher schlug sie sogar bei
  HTTP 200 zu).
- HTTP 403 wird nicht mehr als Session-Ablauf behandelt. Fehlt dem S-User die
  Berechtigung für eine Note, führte die alte Zuordnung in eine Login-Schleife, die
  daran nichts ändern konnte. Neu: eigener `AccessDeniedError` mit klarer Meldung,
  ohne Session-Abbau und ohne den sinnlosen DOM-Fallback. HTTP 401 bleibt Session-Ablauf.
- `session.json` wird atomar geschrieben (Temp-Datei + `rename`, Modus 0600 ab Anlage).
  Bisher konnte ein Prozessende während des 5-Minuten-Speicherns eine abgeschnittene
  Datei hinterlassen; der Folgefehler war kein `SessionExpiredError`, der
  Recovery-Pfad griff also nicht und jeder Aufruf schlug fehl, bis die Datei von Hand
  gelöscht wurde. Eine unlesbare State-Datei gilt jetzt zusätzlich als „keine Session“
  und führt zur normalen `npm run login`-Meldung.
- Ein literales `%` im Dateinamen eines Anhangs (`100%_report.csv`) ließ
  `decodeURIComponent` im DOM-Fallback werfen und brachte die komplette Anhangsliste
  zum Scheitern. Der Dateiname wird jetzt aus dem Pfad gelesen (Query vorher entfernt)
  und fällt bei nicht dekodierbaren Namen auf die Rohform zurück.

### Hinzugefügt

- Download-Schutz: Anhänge über 100 MB (`Content-Length`-Prüfung) werden abgelehnt,
  bevor `response.body()` den gesamten Puffer in den RAM lädt.
- Regressionstests: `assertNotLoggedOut` (401/403/IdP-URL/ok-Pfad),
  `looksLikeLoginPage` gegen Suchanfragen und Anhang-URLs mit
  „logon“/„signin“, sowie `fileNameFromHref` gegen fehlerhafte Prozent-Escapes.

## [1.3.0] – 2026-07-20

### Hinzugefügt

- `sap_note_attachments`-Tool: listet die Datei-Anhänge einer Note/KBA
  (Dateiname, Größe, Download-URL) — primär über die Note-Detail-JSON-API
  (`backend/raw/sapnotes/Detail`), mit DOM-Scrape der Note-Seite als Fallback
  (gleiche Zwei-Stufen-Strategie wie die Suche)
- `sap_note_attachment_get`-Tool: lädt einen Anhang nach `SAP_ATTACHMENT_DIR`
  (Default `~/Downloads/sap-notes/<Note-Nummer>/`); Text-Anhänge
  (.txt, .sql, .csv, …) werden zusätzlich inline zurückgegeben
  (gekappt bei 200 000 Zeichen, die vollständige Datei liegt auf der Platte)
- Neue ENV-Variablen `SAP_NOTE_API_URL` und `SAP_ATTACHMENT_DIR` (mit `~`-Expansion)
- Sicherheit: Downloads nur per HTTPS von `*.sap.com`-Hosts (die URL stammt aus
  Portaldaten); Dateinamen werden vor dem Speichern sanitisiert (kein Path-Traversal)
- Leere Anhangsliste erklärt den „A new version is in preparation“-Modus,
  in dem das Portal Anhänge ausblendet (KBA 3453681)

## [1.2.0] – 2026-07-20

### Hinzugefügt

- `sap_session_status`-Tool für proaktive Session-Prüfung
- Coveo-Token wird 4 min gecacht (ein Roundtrip weniger pro Suche)
- Retry bei transienten Coveo-Fehlern (1 s Verzögerung)

### Behoben

- Coveo-Token-Cache wird bei Session-Neustart invalidiert
  (verhinderte Auth-Fehler nach Idle-Timeout oder Session-Ablauf)

### Geändert

- Retry nur noch bei transienten Fehlern (5xx, Netzwerk) —
  4xx und Logikfehler schlagen sofort fehl
- `fetchNote` nutzt ebenfalls Retry (konsistent mit `searchNotes`)
- Tool-Handler über gemeinsamen `executeTool`-Wrapper dedupliziert
- Server-Version wird aus `package.json` gelesen statt hartcodiert
- `waitForSelector` statt blindem `waitForTimeout` → schnellere Seitenladezeiten
- Graceful Shutdown über `server.close()` statt `process.exit(0)`
- README: `--env-file`-Nutzung dokumentiert
- `coerceField` exportiert und getestet

## [1.1.0] – 2026-07-19

### Hinzugefügt

- ESLint (typescript-eslint, type-aware) mit `npm run lint`
- GitHub-Actions-CI (`.github/workflows/ci-workflow.yml`): Typecheck, Lint und
  Offline-Unit-Tests bei jedem Push auf `main` und bei jedem Pull Request —
  ohne SAP-Session und ohne Browser
- `SAP_IDLE_TIMEOUT_MS`: Der headless Browser wird nach Inaktivität
  (Default 10 min) beendet, um RAM zu sparen, und beim nächsten Tool-Aufruf
  automatisch neu gestartet (0 = deaktiviert)
- Erweiterte Offline-Unit-Tests

### Geändert

- Nach abgelaufener Session genügt `npm run login` + Wiederholen der Anfrage —
  der Server liest die neue Session ohne Neustart ein
- README: Lint-/CI-Dokumentation, korrigierter Workflow-Dateiname

## [1.0.1] – 2026-07-15

### Geändert

- Zuverlässigkeit gehärtet: robustere Suche/Abruf (`notes.ts`),
  Session-Handling verbessert, Diagnose-Skript überarbeitet
  (entfernt Zugangstoken und Cookie-Header, Dateimodus `0600`)
- Zusätzliche Unit-Tests

## [1.0.0] – 2026-07-15

### Hinzugefügt

- Erste Version des MCP-Servers für die Suche und den Abruf von
  SAP Notes / KBAs aus dem geschützten SAP-Support-Bereich
- Interaktiver Login (`npm run login`) inkl. MFA; Session wird nach
  `~/.sap-notes-mcp/session.json` (mode 0600) gespeichert
- Headless-Betrieb über die gespeicherte Session (Playwright)
