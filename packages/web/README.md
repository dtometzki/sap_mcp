# SAP Notes Web

Die eigenständige Web-App bietet eine deutsche Oberfläche für Suche, vollständige
Note-Ansicht, verschlüsselte SAP-Zugangsdaten und einen durchsuchbaren Suchverlauf.
Sie läuft für **eine Person mit einem SAP-Konto auf demselben Rechner**.

## Installation aus dem Download-Archiv

Das Archiv `sap-notes-web-<Version>.tar.gz` entpacken und in den enthaltenen Ordner wechseln.
Voraussetzungen: Node.js ab 20, npm und Internetzugang für npm-Pakete und Chromium.
Die passende Core-Bibliothek liegt im Archiv; ein MCP-Server wird nicht benötigt.

```bash
npm ci --omit=dev
npm run browser:install
npm run web:start     # im Hintergrund; http://127.0.0.1:3210
npm run web:status
npm run web:stop
```

Auf Linux ggf. vorab die Chromium-Systembibliotheken mit
`npx --no-install playwright install --with-deps chromium` installieren.
`npm start` startet den Web-Server im Vordergrund.

## Betrieb


`npm run web` startet den Server ebenfalls im Vordergrund (Strg+C beendet ihn).
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
   **Anhänge anzeigen** listet verfügbare Dateien mit Download-Button auf (z. B. ZIP
   oder PDF). Auch die Dateinamen in der Anhangstabelle des Note-Textes sind direkt
   anklickbar. **Herunterladen** speichert die Datei über den Browser; einen
   angezeigten Speicherdialog mit **Sichern** bestätigen.
   **Als PDF sichern** in der Note-Ansicht öffnet den Druckdialog des Browsers
   (macOS: „Als PDF sichern“); gedruckt wird nur die Note mit Quelle und
   Abrufzeitpunkt, der vorgeschlagene Dateiname ist „SAP Note <Nr> – <Titel>“.
5. In der Note-Ansicht auf **☆ Merken** klicken, bis zu 10 eigene Stichwörter
   (je 40 Zeichen, durch Kommas getrennt) und optional eine Notiz mit maximal
   2000 Zeichen eintragen. **Favorit speichern** legt Nummer, Titel, Stichwörter
   und eigene Notiz verschlüsselt im Tresor ab. **★ Favorit bearbeiten** öffnet
   die gespeicherten Angaben; dort lässt sich der Favorit auch entfernen.
6. Unter **Favoriten** nach Nummer, Titel, Stichwörtern oder eigener Notiz suchen,
   nach einem Stichwort filtern und Notes direkt öffnen. Beim Öffnen lädt die App
   den aktuellen Inhalt von SAP. Ein erneuter Klick auf denselben Treffer in der
   Suchliste lädt die bereits angezeigte Note nicht noch einmal. Die Liste zeigt
   die zuletzt bearbeiteten zuerst
   und umfasst maximal 500 Favoriten; weitere Einträge laden jeweils 50 nach.
   Vorhandene Tresore werden automatisch um eine leere Favoritenliste ergänzt.
   Favoriten bleiben beim Löschen des Suchverlaufs oder Wechseln des SAP-Kontos
   erhalten; sie lassen sich auch ohne aktive SAP-Anmeldung bearbeiten.
7. Im **Suchverlauf** erfolgreiche Suchen einschließlich null Treffern erneut
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
| `SAP_WEB_VAULT_B64_1` … `_4` | – | Optional, für Cursor Cloud: Base64-Teile einer vorhandenen `vault.enc`. Alle vier müssen gesetzt sein; `scripts/cloud-web-start.sh` setzt sie zu `vault.enc` zusammen und startet die Web-App. Werte nie ins Repository oder in Logs schreiben |

Nur die exakte Adresse `http://127.0.0.1:<Port>` wird akzeptiert, kein Netzwerkzugriff,
kein Reverse-Proxy und kein öffentliches Hosting. Das lokale HTTP-Cookie hat
`HttpOnly` und `SameSite=Strict`; Host-/Origin-Prüfung, JSON-Anfragen und eine
restriktive Content Security Policy schützen die lokale Oberfläche. Es gibt keine
CORS-Freigabe. Maximal fünf Entsperr-/Passwortprüfungen pro Minute sind erlaubt.

Der Tresor verschlüsselt **SAP-Zugangsdaten, Cookies/localStorage, Suchverlauf und Favoriten**
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
Links auf sichere Protokolle begrenzt. Anhang-Downloads in der Web-App benötigen
einen entsperrten Tresor und die SAP-Berechtigung für die jeweilige Datei. Sie sind
auf 100 MiB pro Datei begrenzt und werden als Stream an den Browser übergeben;
auf dem Server entstehen keine Klartextdateien, und die SAP-Warteschlange bleibt
während des Transfers frei. Das Ziel bestimmt der Browser, `SAP_ATTACHMENT_DIR`
gilt weiterhin nur für MCP-Downloads. Sperren bricht laufende Downloads ab;
bereits im Browser gespeicherte Dateien bleiben erhalten.
SAP kann Anhänge während der Vorbereitung einer neuen Note-Version ausblenden.

Browser mit WebMCP-Unterstützung können die sichtbaren Aktionen
`search_sap_notes` und `open_sap_note` nutzen. Diese benötigen dieselbe entsperrte
App-Sitzung und dieselben Prüfungen wie die Oberfläche. Es gibt keine Werkzeuge für
Passwörter oder das Entsperren. Ohne WebMCP funktioniert die Oberfläche vollständig.

### Master-Passwort vergessen / Sicherung

Es gibt **keine Passwortwiederherstellung**. Für eine Sicherung die App beenden und
`vault.enc` aus dem Datenverzeichnis kopieren; zum Wiederherstellen sind die Datei
und das zugehörige Master-Passwort nötig. Bestehende Daten nicht überschreiben.

In Cursor Cloud stellen Environment-Secrets `SAP_WEB_VAULT_B64_1` bis `_4` den
Tresor beim Agentenstart wieder her (`.cursor/environment.json` ruft
`scripts/cloud-web-start.sh` auf). Die Teile sind die Base64-Kodierung von `vault.enc`,
bei Bedarf in vier Brocken. Werte nur als Secrets hinterlegen, nicht in Chats oder
Dateien. Nach einer Änderung am Tresor die Secrets aktualisieren, sonst überschreibt
der nächste Agentenstart die Datei mit dem alten Stand.

Für einen neuen, leeren Tresor die App beenden und `vault.enc` umbenennen oder
bewusst löschen. Beim nächsten Start kann ein neuer Tresor angelegt werden. Ohne
das alte Passwort sind die bisherigen Zugangsdaten, der Suchverlauf und die Favoriten nicht mehr
zugänglich. Eine verwaiste `server.lock` nach einem Absturz wird automatisch erkannt;
eine beschädigte Sperrdatei erst entfernen, nachdem alle Web-App-Prozesse beendet sind.

### Web-Tests

`npm run build`, `npm run lint` und `npm test` prüfen auch Verschlüsselung,
HTTP-Zugriffsschutz, Session-Isolation, Suchverlauf, Sperr-Rennen und die
Browser-Bedienung gegen lokale SAP-Fixtures. Der WebMCP-Vertrag wird mit einer
Test-Registry geprüft; das ersetzt keine Prüfung einer nativen Browser-Implementierung.
Die Tests verwenden keine echten SAP-Zugangsdaten und senden keine SAP-Anfragen.


## Konfiguration und Entwicklung im Workspace

Eine optionale `.env` neben dieser README wird vor der `.env` im Workspace-Root
und der Datei im Arbeitsverzeichnis gelesen; die erste vorhandene Datei gewinnt.
`SAP_ENV_FILE` ist exklusiv. Prozessvariablen behalten Vorrang.
Die alten Root-Befehle verwenden weiterhin Root-`.env` vor Arbeitsverzeichnis-`.env`.
Zugangsdaten aus diesen Dateien werden vor dem Start der SAP-Browser entfernt;
der Web-Zugang wird ausschließlich im Tresor verwaltet.

Im Repository vom Root aus:

```bash
npm ci
npm run build --workspace @sap-notes/web
npm run web:start --workspace @sap-notes/web
npm run lint --workspace @sap-notes/web
npm test --workspace @sap-notes/web
```

Der Paket-Build baut Core automatisch mit. Die mitgelieferten Archive benötigen
keinen TypeScript-Build. Gemeinsame Portal-, Timeout- und Login-Selektor-Overrides
stehen in `.env.example`. `SAP_STATE_PATH`, `SAP_ATTACHMENT_DIR` und
`SAP_AUTO_LOGIN` steuern weiterhin ausschließlich die MCP-Nutzung.
