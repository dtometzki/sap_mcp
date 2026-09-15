# AGENTS.md

## Release-Checkliste bei Code-Änderungen

Nach jeder funktionalen Änderung am Server-Code:

1. **CHANGELOG.md** – Eintrag unter `[Unreleased]` (Hinzugefügt / Behoben / Geändert).
2. **package.json** – Version im Root und in allen drei Workspace-Paketen gemeinsam nach SemVer bumpen und `[Unreleased]` im CHANGELOG
   in einen datierten Abschnitt überführen. Core-Abhängigkeiten und Lockdatei mitziehen.
3. **README.md** – Prüfen, ob Tools, ENV-Variablen oder Setup-Schritte betroffen sind;
   nur bei nutzersichtbaren Änderungen aktualisieren.
4. **Build + Lint + Tests** – `npm run build && npm run lint && npm test` muss grün sein.
   Bei Änderungen an Paketstruktur, Build oder Installation zusätzlich
   `npm run package && npm run test:archives` ausführen.

## GitHub-Workflow für Code-Änderungen

Sofern der Benutzer nichts anderes vorgibt, werden beauftragte Code-Änderungen über
einen Pull Request nach `main` bereitgestellt:

1. **Ausgangslage prüfen** – `git status` kontrollieren und vorhandene, nicht zum Auftrag
   gehörende Änderungen oder unversionierte Dateien unverändert lassen.
2. **Von `main` starten** – auf `main` wechseln, den Stand bei Bedarf per Fast-Forward
   aktualisieren und davon eine eigene Branch mit Präfix `codex/` erstellen.
3. **Änderung prüfen** – die Release-Checkliste oben vollständig ausführen.
4. **Gezielt committen** – nur die zum Auftrag gehörenden Dateien stagen und mit einer
   aussagekräftigen Commit-Message committen.
5. **Branch pushen** – die Arbeits-Branch nach `origin` pushen und das Upstream-Tracking
   setzen.
6. **Pull Request erstellen** – einen PR von der Arbeits-Branch nach `main` mit kurzer
   Zusammenfassung, Testergebnissen und bekannten Einschränkungen eröffnen.
7. **Nicht selbst mergen** – den PR nur auf ausdrückliche Anweisung des Benutzers mergen.
8. **Branch nach dem Merge entfernen** – nach einem erfolgreichen Merge nach `main` die
   zugehörige `codex/`-Branch lokal und auf `origin` löschen, sofern der Benutzer nichts
   anderes vorgibt.

## Cursor Cloud

Beim Umgebungstart leitet `scripts/cloud-web-start.sh` an
`packages/web/scripts/cloud-web-start.sh` weiter. Dieses stellt den Tresor aus
`SAP_WEB_VAULT_B64_1` bis `_4` wieder her (Verzeichnis `0700`, Datei `0600`) und
führt `npm run web:start` aus. Das passiert automatisch — den Benutzer nicht
nach Vault-Teilen, Master-Passwort oder einem Start-Prompt fragen.

- Nur Vorhandensein und Länge der vier Variablen prüfen, niemals Werte oder
  `vault.enc` per `echo`/`print`/`cat` ausgeben.
- Fehlt einer der Teile: abbrechen, nicht nach Werten fragen.
- Läuft die Web-App nicht (z. B. nach einem Absturz): `npm run web:cloud-start`
  ausführen, nicht den Restore-Prompt vom Benutzer anfordern.
- Status nur als ja/nein plus URL melden (`npm run web:status`), ohne Dateiinhalt.
