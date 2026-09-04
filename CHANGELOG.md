# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung an [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

## [1.8.0] – 2026-09-04

### Hinzugefügt
- About-Link im Footer mit App-Name, Version und letztem Git-Commit inklusive
  Nachricht und Datum. Auch bei gesperrtem Tresor verfügbar; ohne Git-Metadaten
  werden Name und Version weiterhin angezeigt.

## [1.7.1] – 2026-09-04

### Behoben
- Note-Inhalte werden anhand ihrer fachlichen Abschnitte statt des größten
  Seitencontainers extrahiert. SAP-Navigation, Werkzeugleisten, Sprachauswahl
  und Logo-Datenlinks erscheinen nicht mehr im Note-Text.
- Die Extraktion wartet auf den asynchron geladenen Note-Inhalt und behandelt
  eine reine Portal-Oberfläche nicht mehr als erfolgreiche Note-Antwort.
- Tabellen bleiben als Markdown-Tabellen erhalten; relative Referenzlinks werden
  zu vollständigen URLs aufgelöst und doppelte Note-Nummern im Titel entfernt.

## [1.7.0] – 2026-09-04

### Hinzugefügt
- Lokale deutsche SAP-Notes-Web-App (`npm run web`) mit Suche, Note-Ansicht,
  verschlüsselter Zugangsdatenverwaltung und filterbarem, löschbarem Suchverlauf.
- Master-Passwort-Tresor für Zugangsdaten, SAP-Session und Verlauf mit AES-256-GCM,
  scrypt und atomarer Speicherung; getrennt von bestehenden MCP-Dateien.
- Automatischer SAP-Login und sichtbarer MFA-Login aus der App; manuelles Sperren,
  Passwortwechsel, Loopback-Zugriffsschutz und begrenzte Entsperrversuche.
- Optionale WebMCP-Aktionen für Suche und Note-Ansicht, sowie Offline-Tests für
  Verschlüsselung, HTTP-Sicherheit, Session-Isolation und den Browser-Ablauf.

### Geändert
- Gemeinsame SAP-Session unterstützt austauschbare Speicherung; ToolRunner bietet
  typisierte Ergebnisse für den HTTP-Transport bei unverändertem MCP-Verhalten.

## [1.6.2] – 2026-09-04

### Behoben
- MCP-Antworten und Fehlerprotokolle geben keine internen Playwright-Diagnosen mehr
  aus, die Authorization-Header, Session-Cookies, URLs oder Passworteingaben enthalten
  können. Nur explizite Anwendungsmeldungen bleiben erhalten; Login-Banner werden
  nicht in Fehlermeldungen übernommen.
- Automatische Eingabe von Zugangsdaten ist auf die exakten HTTPS-Origins
  `accounts.sap.com` und `accounts.sap.cn` beschränkt, auch zwischen Login-Schritten.
- Coveo-Token, Coveo-Suche und Note-Detail-API folgen keinen HTTP-Weiterleitungen mehr.
  Redirects zum freigegebenen Identity Provider lösen weiterhin die Session-Recovery aus.
- Indirekte Abhängigkeit `qs` auf 6.16.0 aktualisiert (GHSA-4mjr-xmp4-gh2g und
  GHSA-x5fp-wj9c-mxmx).

### Geändert
- Regressionstests für Geheimnisse in Fehlerausgaben, Redirects an allen drei APIs
  und Login-Formulare auf nicht freigegebenen SAP-Subdomains; CI führt die Browser-Tests
  mit installiertem Chromium aus.

## [1.6.1] – 2026-09-04

### Sicherheit
- Portal-gelieferte Anhangsnamen bleiben auch in Download- und Auswahlfehlern innerhalb
  einer festen Untrusted-Markierung; ein Dateiname kann das Begrenzungslabel nicht mehr
  verändern.

### Behoben
- Anhang-Downloads erkennen eine Login-Seite auch bei HTTP 200 und lösen dadurch den
  vorhandenen automatischen Re-Login aus, statt nur einen generischen HTML-Fehler zu melden.
- Gestreamte Anhang-Chunks werden vollständig geschrieben, auch wenn ein einzelner
  Dateisystemaufruf nur einen Teil des Buffers übernimmt.
- Formal gültige, aber strukturell defekte Playwright-Session-Dateien werden wie eine
  fehlende/abgelaufene Session behandelt und liefern wieder die ausführbare Login-Hilfe.
- Ein temporär fehlgeschlagener Session-State-Save wird beim nächsten Tool-Aufruf erneut
  versucht, statt für das gesamte Drosselintervall unterdrückt zu werden.
- Diagnose-Skripte laden nun dieselbe optionale `.env` wie Server und Login-CLI, sodass
  insbesondere ein angepasstes `SAP_STATE_PATH` berücksichtigt wird.
- Zu große Millisekundenwerte werden beim Start abgelehnt, bevor Node sie auf einen
  praktisch sofortigen Timer verkürzt.

### Geändert
- `diagnose-search` begrenzt Anzahl und Größe der im Speicher behaltenen XHR-Antworten
  und dokumentiert Kürzungen im Diagnosebericht.
- Neue Offline-Tests für Loginseiten bei Anhang-Downloads, Session-State-Struktur,
  Timer-Grenzen, Untrusted-Anhangsnamen und fehlgeschlagene State-Saves.

## [1.6.0] – 2026-09-02

### Behoben
- Suche und Anhangsliste: Schlägt der Primärpfad (Coveo bzw. Note-Detail-API) fehl und
  liefert auch der DOM-Fallback nichts, wird jetzt der ursprüngliche Fehler gemeldet.
  Bisher kam in diesem Fall ein irreführendes „No notes found“ / „lists no attachments“
  zurück, sodass ein defektes Backend wie eine leere Trefferliste aussah.
- `SAP_STATE_PATH`: Ein führendes `~` wird jetzt wie bei `SAP_ATTACHMENT_DIR` expandiert
  statt als Verzeichnisname `~` im Arbeitsverzeichnis des MCP-Clients zu landen.
- Anhang-Download: `SAP_API_TIMEOUT_MS` begrenzt die Wartezeit zwischen zwei Datenblöcken
  statt die Gesamtdauer. Große Anhänge auf langsamen Leitungen brachen bisher nach
  60 s ab, obwohl Daten flossen; ein hängender Transfer wird weiterhin erkannt.
- HTTP 429 (Coveo-Rate-Limit) gilt jetzt als transient und wird wie 5xx einmal wiederholt.

### Geändert
- `sap_notes_search` und `sap_note_attachments` markieren ihre Ausgabe (Titel bzw.
  Dateinamen aus dem Portal) wie `sap_note_get` als nicht vertrauenswürdigen Portalinhalt.
- README: Hinweise zu Proxys (Playwright-Client vs. Node-`fetch`) und zum Fehlerverhalten
  der Fallbacks; `.env.example` zeigt `SAP_STATE_PATH` mit `~`.
- Neue Offline-Tests für die Fallback-Fehler, das Inaktivitäts-Timeout, `~`-Expansion und 429.

## [1.5.3] – 2026-08-26

### Behoben
- Coveo-Suche: Lehnt Coveo den gecachten Such-Token mit HTTP 401/403 ab (z. B. nach einem
  Re-Login oder bei vorzeitig ungültigem Token), wird der Token-Cache verworfen und die
  Suche einmal mit frischem Token wiederholt. Bisher fiel die Suche sofort auf den
  DOM-Scrape zurück und alle weiteren Aufrufe scheiterten bis zum Ablauf des Token-TTL
  mit demselben toten Token.
- Auto-Login: Nur noch die eigentliche Logon-Fehlermeldung des Identity Providers
  (`#logonMessageText`) markiert einen Login als endgültig abgelehnt. Generische Banner
  (`[role='alert']`, `.sapMMessageStrip`, …) — Cookie-Hinweise, Wartungsmeldungen,
  „Passwort läuft bald ab" — brechen den Login nicht mehr ab und schalten den
  automatischen Login nicht mehr für die gesamte Prozesslaufzeit ab; ihr Text wird
  stattdessen in die Timeout-Meldung aufgenommen.
- `.env`-Parser: Ein Inline-Kommentar nach einem Wert in Anführungszeichen
  (`SAPPASSWORD="ab#cd" # Kommentar`) wird jetzt wie bei dotenv erkannt. Bisher blieben
  die Anführungszeichen Teil des Werts.

### Geändert
- Neue Offline-Tests für die Token-Erneuerung der Coveo-Suche (`coveoSearch.test.ts`),
  den Kommentar-Fall des `.env`-Parsers und die Banner-Fälle des Auto-Logins.

## [1.5.2] – 2026-08-26

### Sicherheit
- Das S-User-Passwort wird nach dem Einlesen der Konfiguration wieder aus `process.env`
  entfernt (`scrubPasswordFromEnv`), bevor Playwright den Chromium-Prozess startet.
  Bisher erbte der Browser-Kindprozess das Passwort in seiner Umgebung (sichtbar z. B.
  in Crash-Reports oder `ps eww`). Gilt für Server, `npm run login` und die Diagnose-Skripte.
- Transitive Abhängigkeiten aktualisiert (`npm audit fix`): `ip-address` (2× high, SSRF /
  Trust-Boundary-Bypass, GHSA-mwp4-54f8-5fhr u. a.) und `hono` (moderate). `npm audit --omit=dev`
  meldet 0 Schwachstellen.
- Portal-, Login- und API-URLs werden gegen eine HTTPS-Allowlist geprüft
  (`*.sap.com` / `*.sap.cn`, Coveo-Suche zusätzlich `*.coveo.com`). `file:`, `http:`
  und fremde Hosts werden beim Start und vor jeder Navigation bzw. jedem API-Call
  abgelehnt — verhindert SSRF und das Öffnen lokaler Dateien über `SAP_NOTE_URL`.
- Auto-Login und `npm run login` tippen Benutzer/Passwort nur, wenn die aktuelle
  Seite (nach Redirects) auf der Allowlist liegt. Ein umgeleiteter `SAP_PROBE_URL`
  kann die Credentials nicht mehr auf einer Phishing-Seite landen.
- `sap_note_attachments` gibt keine Download-URLs mehr an den Client; fremde Hosts
  in der Note-Detail-API werden verworfen.
- Anhang-Unterordner werden auf `0700` gesetzt, gespeicherte Dateien nach dem
  atomaren Rename auf `0600`.
- Session-Cookies beim Anhang-Download gehen nur noch an `me.sap.com`,
  `*.support.sap.com` und `accounts.sap.com` (erweiterbar über
  `SAP_ATTACHMENT_COOKIE_HOSTS`). Andere `*.sap.com`-Hosts bleiben downloadbar,
  aber ohne Cookie-Jar.
- Note-Inhalt und Inline-Anhänge werden als untrusted Portal-Daten geklammert;
  HTML/JavaScript-Anhänge werden nicht mehr inline zurückgegeben.
  `INLINE_TEXT_LIMIT` ist 50 000 Zeichen (Datei bleibt vollständig auf Disk).
- Such-`query` ist auf 500 Zeichen begrenzt, `fileName` auf 200.
- Playwright startet mit `acceptDownloads: false` (Downloads laufen über fetch).
- `.env`-Loader lädt nur reguläre Dateien (Verzeichnisse/Devices werden
  übersprungen); Symlinks werden mit Warnung aufgelöst.
- S-User-Id wird zusammen mit dem Passwort aus `process.env` entfernt.
  Diagnose-Mitschnitte redigieren Query-Strings in URLs.

## [1.5.1] – 2026-08-25

### Geändert

- Credentials und Konfiguration werden gleichberechtigt aus der Prozessumgebung
  gelesen; die `.env` ist ausdrücklich optional. Echte Umgebungsvariablen haben
  Vorrang — auch über Alt-Namen hinweg: ein exportiertes `SAP_USERNAME` schlägt
  jetzt ein `SAPUSER`, das nur in der Datei steht (vorher gewann der bevorzugte
  Name unabhängig von der Herkunft).
- `SAP_ENV_FILE` ist exklusiv: ist die Variable gesetzt, wird ausschließlich dieser
  Pfad gelesen. Bisher fiel der Loader still auf `<Repo-Root>/.env` zurück, was zu
  einer Anmeldung mit dem falschen S-User führen konnte. Ist die angegebene Datei
  nicht lesbar, warnt der Server auf stderr und arbeitet mit der Prozessumgebung
  weiter.
- `npm run login` benennt die tatsächliche Quelle der Credentials (Datei oder
  Prozessumgebung) statt pauschal `.env`.

## [1.5.0] – 2026-08-25

### Hinzugefügt

- **Automatischer Login über `.env`**: `SAPUSER` und `SAPPASSWORD` füllen das
  SAP-Logon-Formular selbständig aus. Der MCP-Server meldet sich damit bei
  abgelaufener Session headless neu an und wiederholt den fehlgeschlagenen
  Tool-Aufruf einmal, ohne dass ein Mensch `npm run login` ausführen muss.
- Eigener `.env`-Loader (`src/env.ts`, ohne neue Dependency): Server und Login-CLI
  lesen `$SAP_ENV_FILE` → `<Repo-Root>/.env` → `$PWD/.env` ein. Echte
  Umgebungsvariablen haben Vorrang; zu offene Dateirechte werden auf stderr gewarnt.
- `npm run login` füllt Benutzer und Passwort automatisch aus und fragt nur noch
  dann nach, wenn ein Mensch nötig ist (MFA, Passwortwechsel, Fehlermeldung).
- Neue Konfiguration: `SAP_AUTO_LOGIN`, `SAP_AUTO_LOGIN_COOLDOWN_MS`,
  `SAP_LOGIN_STEP_TIMEOUT_MS`, `SAP_ENV_FILE` sowie konfigurierbare Selektoren
  (`SAP_LOGIN_USER_SELECTOR`, `SAP_LOGIN_PASSWORD_SELECTOR`,
  `SAP_LOGIN_SUBMIT_SELECTOR`, `SAP_LOGIN_MFA_SELECTOR`).

### Sicherheit

- MFA wird erkannt und beendet den Auto-Login sofort mit einem klaren Hinweis,
  statt blind weiterzuklicken.
- Nach einem fehlgeschlagenen Auto-Login gilt eine Sperrzeit (Default 5 min); bei
  MFA oder abgelehnten Credentials wird für die restliche Prozesslaufzeit kein
  weiterer Versuch unternommen — ein Retry-Loop kann den S-User nicht sperren.
- Der Login läuft serialisiert in der bestehenden Tool-Queue: parallele
  MCP-Clients lösen nie mehrere gleichzeitige Anmeldungen aus.
- Das Passwort wird ausschließlich aus der `.env` bzw. der Prozessumgebung
  gelesen, nie geloggt; Diagnoseausgaben gehen auf stderr, nicht auf stdout.

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
