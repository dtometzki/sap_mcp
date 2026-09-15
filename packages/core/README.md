# SAP Notes Core

Gemeinsame TypeScript-/ESM-Bibliothek für SAP-Zugriff, Sessions, Login, Notes und
Anhänge. Core hat keinen Serverprozess und keinen eigenen Netzwerk-Endpunkt.
MCP und Web verwenden jeweils eine eigene Instanz mit eigenen Zugangsdaten und
Session-Speichern.

Die öffentliche API wird über `@sap-notes/core` importiert. Interne Modulpfade sind
nicht freigegeben. Die Anwendungen bestimmen die `.env`-Suchverzeichnisse;
Core liest keine eigene Paket-`.env`. `SessionStore` ermöglicht der Web-App die
verschlüsselte Speicherung, während MCP seinen bisherigen Dateispeicher nutzt.

Im Workspace: `npm run build --workspace @sap-notes/core` und
`npm test --workspace @sap-notes/core`. Releases verwenden dieselbe Version wie
beide Apps. Der Archiv-Build legt die passende Bibliothek als npm-Tarball bei.
