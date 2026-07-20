# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung an [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

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
