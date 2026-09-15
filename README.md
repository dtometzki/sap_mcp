# SAP Notes: MCP und Web

Zwei eigenständige Anwendungen für Suche, Note-Abruf und Anhänge im geschützten
SAP-Support-Bereich. Beide greifen über Playwright direkt auf SAP zu und können
unabhängig auf verschiedenen Rechnern installiert werden.

| Paket | Aufgabe | Anleitung |
|---|---|---|
| `@sap-notes/mcp` | MCP-Server über stdio, Login-CLI und Diagnose | [MCP](packages/mcp/README.md) |
| `@sap-notes/web` | Lokale Oberfläche, HTTP-Server, Tresor, Favoriten und Verlauf | [Web](packages/web/README.md) |
| `@sap-notes/core` | Gemeinsame SAP-Bibliothek | [Core](packages/core/README.md) |

## Separate Installation

Die CI stellt nach erfolgreichen Tests unter **Actions → CI → Artifacts** zwei
Archive bereit: `sap-notes-mcp-<Version>.tar.gz` und `sap-notes-web-<Version>.tar.gz`.
Das gewünschte Archiv entpacken und im enthaltenen Ordner ausführen:

```bash
npm ci --omit=dev
npm run browser:install
npm start
```

Node.js ab 20, npm und Internetzugang zur Installation sind erforderlich.
Auf Linux können zusätzliche Chromium-Systembibliotheken erforderlich sein:
`npx --no-install playwright install --with-deps chromium`.
Die Core-Bibliothek liegt jedem Archiv bei; eine Registry für eigene Pakete oder
Installation der anderen Anwendung ist nicht nötig. Alle Pakete erhalten dieselbe
Versionsnummer. Updates erfolgen durch Entpacken der neuen Version in einen eigenen
Ordner, Installation und Umstellen des Startpfads; eine eigene `.env` bei Bedarf
übernehmen oder mit `SAP_ENV_FILE` referenzieren.

MCP benötigt anschließend die Anmeldung über `npm run login` oder konfigurierte
Auto-Login-Zugangsdaten. Web wird unter `http://127.0.0.1:3210` bedient und verwaltet
SAP-Zugang und Sessions ausschließlich im verschlüsselten Tresor.

## Entwicklung im Repository

```bash
npm ci
npx --no-install playwright install chromium
npm run build
npm run lint
npm test
npm run typecheck
```

TypeScript Project References bauen Core vor den Anwendungen. Selektiv:

```bash
npm run build --workspace @sap-notes/mcp
npm test --workspace @sap-notes/mcp
npm run build --workspace @sap-notes/web
npm test --workspace @sap-notes/web
```

Tests verwenden temporäre Datenverzeichnisse und lokale SAP-Ersatzdaten.
Sie senden keine Anfragen an SAP. CI verlangt erfolgreiche Browser-Tests;
lokal werden diese bei nicht verfügbarem Chromium übersprungen.

## Bestehende Starts bleiben gültig

```bash
npm run login
npm start
npm run web
npm run web:start
npm run web:status
npm run web:stop
npm run web:restore-vault
npm run web:cloud-start
```

Der Root-Build erzeugt Weiterleitungen für `dist/server.js`, `dist/login.js`,
`dist/test-search.js`, `dist/diagnose-search.js`, `dist/web/main.js` und
`dist/web/daemon.js`. Vorhandene MCP-Client-Konfigurationen können unverändert bleiben.
Direkt ist auch `node packages/mcp/dist/server.js` möglich.

Alte Root-Einstiege suchen `.env` im Repository-Root und danach im Arbeitsverzeichnis.
Direkte Paket-Einstiege suchen zuerst im App-Verzeichnis, dann gegebenenfalls im
Workspace-Root, zuletzt im Arbeitsverzeichnis. Die erste vorhandene Datei gewinnt;
Prozessvariablen haben Vorrang. `SAP_ENV_FILE` bleibt exklusiv.

MCP speichert seine Session weiterhin unter `~/.sap-notes-mcp/session.json`;
Web verwendet `~/.sap-notes-web`. Beide können parallel laufen. Bestehende Daten
benötigen keine Migration. Der Web-Server bleibt auf `127.0.0.1` beschränkt.

## Archive erstellen und prüfen

```bash
npm run package
npm run test:archives
```

`artifacts/` enthält die beiden Archive. Sie enthalten gebauten Code, eine
Installations-Lockdatei und die passende Core-Bibliothek, beim Web zusätzlich
Oberfläche und Betriebsskripte. Quelltests, lokale `.env`, Tresore und Sessions
werden nicht übernommen. Archivtests installieren beide Anwendungen außerhalb des
Repositorys und prüfen Start, Protokoll, Assets, Abhängigkeiten und Parallelbetrieb.
Die Installation und der Abhängigkeitsaudit benötigen Internetzugang.

## Cursor Cloud

Der bestehende Einstieg `scripts/cloud-web-start.sh` leitet an das Web-Paket weiter.
Die vier Secrets `SAP_WEB_VAULT_B64_1` bis `_4` werden weiterhin automatisch
wiederhergestellt; fehlt ein Teil, bricht der Start ab. Inhalte werden nicht geloggt.
Weitere Betriebsdetails stehen in der [Web-Anleitung](packages/web/README.md).

## Release

[CHANGELOG.md](CHANGELOG.md) dokumentiert gemeinsame Releases. Root und alle drei
Pakete werden zusammen versioniert; die Lockdatei und Core-Abhängigkeiten müssen
dieselbe Version enthalten. Änderungen werden über einen geprüften PR nach `main`
bereitgestellt.
