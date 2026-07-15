# sap-notes-mcp

MCP-Server für die Suche in SAP Notes / KBAs im **geschützten** SAP-Support-Bereich.

Da SAP keine offizielle Notes-API anbietet, arbeitet der Server mit einer
authentifizierten Browser-Session (Playwright):

1. **Einmalig** interaktiv einloggen (`npm run login`) — inkl. MFA, im sichtbaren Browser.
2. Session (Cookies + localStorage) wird nach `~/.sap-notes-mcp/session.json` (mode 0600) gespeichert.
3. Der MCP-Server läuft danach **headless** und nutzt diese Session.
4. Läuft die Session ab, liefern die Tools eine klare Fehlermeldung → `npm run login` erneut ausführen.

## Setup

```bash
npm install
npx playwright install chromium
npm run build
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
| `SAP_NOTE_URL` | `https://me.sap.com/notes/{id}` | Detail-URL (`{id}`) |
| `SAP_PROBE_URL` | `https://me.sap.com/notes/2170696` | Seite zur Session-Prüfung |
| `SAP_NAV_TIMEOUT_MS` | `60000` | Navigations-Timeout |
| `SAP_RENDER_SETTLE_MS` | `2500` | Wartezeit für spätes SPA-Rendering |
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
* Kein Bulk-Crawling: ein Seitenaufruf pro Tool-Call, keine Parallelisierung.
* Korrekturanweisungen (ABAP) werden nicht ausgelesen; dafür wäre ein zusätzlicher
  OData-Call gegen den Note-Assistant-Service nötig.
