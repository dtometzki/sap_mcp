# AGENTS.md

## Release-Checkliste bei Code-Änderungen

Nach jeder funktionalen Änderung am Server-Code:

1. **CHANGELOG.md** – Eintrag unter `[Unreleased]` (Hinzugefügt / Behoben / Geändert).
2. **package.json** – Version nach SemVer bumpen und `[Unreleased]` im CHANGELOG
   in einen datierten Abschnitt überführen.
3. **README.md** – Prüfen, ob Tools, ENV-Variablen oder Setup-Schritte betroffen sind;
   nur bei nutzersichtbaren Änderungen aktualisieren.
4. **Build + Lint + Tests** – `npm run build && npm run lint && npm test` muss grün sein.

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
