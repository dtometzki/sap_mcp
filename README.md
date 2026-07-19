# sap-notes-mcp

MCP-Server für die Suche in SAP Notes / KBAs im **geschützten** SAP-Support-Bereich.

Da SAP keine offizielle Notes-API anbietet, arbeitet der Server mit einer
authentifizierten Browser-Session (Playwright):

1. **Einmalig** interaktiv einloggen (`npm run login`) — inkl. MFA, im sichtbaren Browser.
2. Session (Cookies + localStorage) wird nach `~/.sap-notes-mcp/session.json` (mode 0600) gespeichert.
3. Der MCP-Server läuft danach **headless** und nutzt diese Session.
4. Läuft die Session ab, liefern die Tools eine klare Fehlermeldung → `npm run login` erneut
   ausführen und die Anfrage einfach wiederholen — der Server liest die neue Session ohne
   Neustart ein.
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
| `SAP_PROBE_URL` | `https://me.sap.com/notes/2170696` | Seite zur Session-Prüfung |
| `SAP_NAV_TIMEOUT_MS` | `60000` | Navigations-Timeout |
| `SAP_NETWORK_IDLE_TIMEOUT_MS` | `4000` | Kurze Wartezeit auf Netzwerk-Ruhe |
| `SAP_RENDER_SETTLE_MS` | `2500` | Wartezeit für spätes SPA-Rendering |
| `SAP_IDLE_TIMEOUT_MS` | `600000` | Browser nach Inaktivität schließen (0 = deaktiviert) |
| `SAP_USERNAME` | – | Nur optionales Username-Prefill im Login-CLI (Passwort wird nie aus ENV gelesen) |

## Wenn SAP das Portal umbaut

Der Server benutzt bewusst **keine** hartkodierten CSS-Klassen:

* Suche = alle Links, deren `href` auf eine Note-Nummer zeigt (`/notes/<n>`, `/knowledge/en/<n>`, …).
* Detail = grösster Content-Container (`main`, `article`, `[role=main]`, …) → Markdown.

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
(`.github/workflows/ci.yml`) bei jedem Push/PR — ohne SAP-Session und ohne Browser.
