# AGENTS.md

## Release-Checkliste bei Code-Änderungen

Nach jeder funktionalen Änderung am Server-Code:

1. **CHANGELOG.md** – Eintrag unter `[Unreleased]` (Hinzugefügt / Behoben / Geändert).
2. **package.json** – Version nach SemVer bumpen und `[Unreleased]` im CHANGELOG
   in einen datierten Abschnitt überführen.
3. **README.md** – Prüfen, ob Tools, ENV-Variablen oder Setup-Schritte betroffen sind;
   nur bei nutzersichtbaren Änderungen aktualisieren.
4. **Build + Lint + Tests** – `npm run build && npm run lint && npm test` muss grün sein.

## Cursor Cloud Agents

`.cursor/environment.json` bereitet Abhängigkeiten, Playwright Chromium und
`dist/` vor. Es gibt kein `start`-Skript: `npm start` blockiert auf stdio.
Eine SAP-Session entsteht nur lokal mit `npm run login`; sie gehört nicht ins
Install-Skript und nicht ins Repo.
