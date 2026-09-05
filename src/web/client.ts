import type { NoteHit, NoteDetail } from "../notes.js";
import type { HistoryEntry } from "./vault.js";
import type { SapStatus } from "./sap.js";
import type { AppInfo } from "./about.js";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element ${id}`);
  return found as T;
}
const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item;
}
interface State { exists: boolean; unlocked: boolean; username?: string; sap?: SapStatus }
let state: State = { exists: true, unlocked: false };
let epoch = 0;
let searchSequence = 0;
let noteSequence = 0;
let historySequence = 0;
let historyOffset = 0;
let historyQuery = "";
let historyTotal = 0;
const pending = new Set<AbortController>();
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("sap-notes-web") : undefined;
channel?.addEventListener("message", (event: MessageEvent<unknown>) => { if (event.data === "locked") clearPrivateView(); });
class ObsoleteRequest extends Error {}
function message(text: string): void { el("message").textContent = text; el("message").hidden = !text; }
function clearPrivateView(): void {
  epoch++; searchSequence++; noteSequence++; historySequence++;
  for (const controller of pending) controller.abort(); pending.clear();
  for (const field of document.querySelectorAll<HTMLInputElement>("input")) field.value = "";
  el("results").replaceChildren(node("p", "Starte eine Suche nach SAP Notes.", "empty"));
  el("note-content").replaceChildren(node("p", "Wähle eine Note aus der Trefferliste.", "empty"));
  el("history-list").replaceChildren(); el("result-count").textContent = "0";
  historyOffset = 0; historyTotal = 0; historyQuery = "";
  state.unlocked = false;
  message(""); renderState();
}
function renderState(): void {
  el("gate").hidden = state.unlocked; el("workspace").hidden = !state.unlocked; el("lock").hidden = !state.unlocked;
  el("gate-title").textContent = state.exists ? "Arbeitsbereich entsperren" : "Deinen Tresor einrichten";
  el("gate-help").textContent = state.exists ? "Mit deinem Master-Passwort gibst du Zugangsdaten und Suchverlauf frei." : "Wähle ein Master-Passwort mit mindestens 12 Zeichen. Danach kannst du deinen SAP-Zugang verschlüsselt hinterlegen.";
  el("unlock-submit").textContent = state.exists ? "Entsperren" : "Tresor anlegen";
  el("confirm-wrap").hidden = state.exists; input("master-confirm").required = !state.exists;
  input("master").autocomplete = state.exists ? "current-password" : "new-password";
  const labels: Record<SapStatus, string> = { unknown: "Bereit", authenticated: "SAP verbunden", login_required: "SAP nicht angemeldet", mfa_required: "MFA erforderlich", login_failed: "Anmeldung prüfen", interactive: "SAP-Fenster geöffnet" };
  el("connection").textContent = state.unlocked ? labels[state.sap ?? "unknown"] : "Gesperrt";
  el("connection").classList.toggle("connected", state.unlocked && state.sap === "authenticated");
  el("login-banner").hidden = !state.unlocked || state.sap === "authenticated";
  el("login-start").hidden = state.sap === "interactive";
  el("login-finish").hidden = state.sap !== "interactive"; el("login-cancel").hidden = state.sap !== "interactive";
  el("login-help").textContent = state.sap === "interactive" ? "Schließe die Anmeldung im geöffneten SAP-Fenster ab und klicke dann auf „Anmeldung prüfen“." : "Zugangsdaten in den Einstellungen hinterlegen oder die Anmeldung im SAP-Fenster abschließen.";
}
async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const atStart = epoch;
  const controller = new AbortController(); pending.add(controller);
  try {
    const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: method === "GET" ? {} : { "Content-Type": "application/json" }, ...(method !== "GET" ? { body: JSON.stringify(data ?? {}) } : {}) });
    const value: unknown = await response.json();
    if (atStart !== epoch) throw new ObsoleteRequest();
    if (!response.ok) {
      const failure = value as { code: string; message: string };
      if (failure.code === "LOCKED") clearPrivateView();
      throw new Error(failure.message);
    }
    return value as T;
  } catch (error) {
    if (controller.signal.aborted || atStart !== epoch) throw new ObsoleteRequest();
    throw error;
  } finally { pending.delete(controller); }
}
async function refreshState(): Promise<void> {
  const next = await api<State>("/api/state");
  const lockedElsewhere = state.unlocked && !next.unlocked;
  if (lockedElsewhere) clearPrivateView();
  state = next; renderState();
  // Server-side idle lock or a lock from another browser: say why the workspace vanished.
  if (lockedElsewhere) message("Der Arbeitsbereich wurde gesperrt (Inaktivität oder Sperren in einer anderen Sitzung).");
}
async function action(fn: () => Promise<unknown>, source?: HTMLElement): Promise<void> {
  const buttons = source ? [...source.querySelectorAll<HTMLButtonElement>("button")] : [];
  if (source instanceof HTMLButtonElement) buttons.push(source);
  for (const button of buttons) button.disabled = true;
  try { message(""); await fn(); }
  catch (error) { if (!(error instanceof ObsoleteRequest)) message(error instanceof Error ? error.message : "Die Anfrage ist fehlgeschlagen."); }
  finally { for (const button of buttons) button.disabled = false; }
}
function showView(next: string): void {
  for (const name of ["search", "history", "settings"]) el(`${name}-view`).hidden = name !== next;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.classList.toggle("active", button.dataset.view === next);
    if (button.dataset.view === next) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
}
function click(id: string, fn: () => Promise<unknown>): void { const button = el(id); button.addEventListener("click", () => { void action(fn, button); }); }
function form(id: string, fn: () => Promise<unknown>): void {
  const target = el<HTMLFormElement>(id);
  target.addEventListener("submit", event => { event.preventDefault(); void action(fn, target); });
}
function sourceLink(url: string): HTMLAnchorElement {
  const link = node("a", "Bei SAP öffnen ↗");
  try { const parsed = new URL(url); if (parsed.protocol === "https:") link.href = parsed.href; } catch { /* No unsafe URLs. */ }
  link.target = "_blank"; link.rel = "noopener noreferrer"; return link;
}
async function openNote(number: string): Promise<{ id: string; title: string }> {
  if (!/^\d{4,10}$/.test(number)) throw new Error("Eine Note-Nummer besteht aus 4 bis 10 Ziffern.");
  const sequence = ++noteSequence;
  el("note-content").replaceChildren(node("p", `Note ${number} wird geladen …`, "empty"));
  try {
    const note = await api<NoteDetail & { html: string }>(`/api/notes/${number}`);
    if (sequence !== noteSequence) throw new ObsoleteRequest();
    const header = node("div", undefined, "note-header");
    header.append(node("div", `SAP NOTE / KBA · ${note.id}`, "eyebrow"), node("h2", note.title), sourceLink(note.url));
    const content = node("div", undefined, "note-body");
    // Only HTML produced by the server's HTML-disabled Markdown renderer.
    content.innerHTML = note.html;
    el("note-content").replaceChildren(header, content);
    for (const hit of document.querySelectorAll<HTMLButtonElement>(".result")) hit.classList.toggle("selected", hit.dataset.number === number);
    return { id: note.id, title: note.title };
  } catch (error) {
    if (sequence === noteSequence) el("note-content").replaceChildren(node("p", "Die Note konnte nicht geladen werden.", "empty"));
    throw error;
  } finally { if (state.unlocked) void refreshState().catch(() => undefined); }
}
async function search(query: string, limit: number): Promise<NoteHit[]> {
  query = query.trim();
  if (query.length < 2 || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Suchtext und Trefferlimit prüfen.");
  showView("search"); input("query").value = query;
  const select = el<HTMLSelectElement>("limit");
  if (![...select.options].some(option => option.value === String(limit))) select.add(new Option(String(limit), String(limit)));
  select.value = String(limit);
  const sequence = ++searchSequence;
  el("results").replaceChildren(node("p", "SAP Notes werden gesucht …", "empty"));
  el("result-count").textContent = "…";
  try {
    const { hits } = await api<{ hits: NoteHit[] }>("/api/search", "POST", { query, limit });
    if (sequence !== searchSequence) throw new ObsoleteRequest();
    const results = el("results"); results.replaceChildren(); el("result-count").textContent = String(hits.length);
    for (const hit of hits) {
      const button = node("button", undefined, "result"); button.dataset.number = hit.id;
      button.append(node("span", `SAP NOTE / KBA · ${hit.id}`, "number"), node("span", hit.title, "title"));
      button.addEventListener("click", () => { void action(() => openNote(hit.id)); }); results.append(button);
    }
    if (!hits.length) results.append(node("p", "Keine passenden Notes gefunden. Probiere andere Suchbegriffe.", "empty"));
    return hits;
  } catch (error) {
    if (sequence === searchSequence) { el("results").replaceChildren(node("p", "Suche nicht abgeschlossen. Bitte erneut versuchen.", "empty")); el("result-count").textContent = "0"; }
    throw error;
  } finally { if (state.unlocked) void refreshState().catch(() => undefined); }
}
async function history(more = false): Promise<void> {
  if (!more) { historyOffset = 0; historyQuery = input("history-filter").value; }
  const sequence = ++historySequence;
  const result = await api<{ entries: HistoryEntry[]; total: number }>(`/api/history?q=${encodeURIComponent(historyQuery)}&offset=${historyOffset}`);
  if (sequence !== historySequence) throw new ObsoleteRequest();
  const list = el("history-list"); if (!more) list.replaceChildren(); historyTotal = result.total;
  for (const entry of result.entries) {
    const row = node("div", undefined, "history-item");
    const button = node("button", entry.query, "history-query");
    button.append(node("small", `${new Date(entry.at).toLocaleString("de-DE")} · ${entry.count} Treffer · Limit ${entry.limit}`));
    button.addEventListener("click", () => { void action(() => search(entry.query, entry.limit)); });
    const remove = node("button", "Löschen", "quiet"); remove.setAttribute("aria-label", `Suche „${entry.query}“ löschen`);
    remove.addEventListener("click", () => { void action(async () => { await api(`/api/history/${entry.id}`, "DELETE"); await history(); }, remove); });
    row.append(button, remove); list.append(row);
  }
  historyOffset += result.entries.length; el("history-more").hidden = historyOffset >= historyTotal;
  if (!historyTotal) list.append(node("p", historyQuery ? "Keine passenden Suchanfragen." : "Deine erfolgreichen Suchanfragen erscheinen hier.", "empty"));
}
async function checkSap(): Promise<void> { try { await api("/api/sap/check", "POST"); } finally { await refreshState(); } }

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
  button.addEventListener("click", () => {
    const next = button.dataset.view ?? "search"; showView(next);
    if (next === "history") void action(() => history());
    if (next === "settings") input("username").value = state.username ?? "";
  });
}
form("unlock-form", async () => {
  const password = input("master").value;
  if (!state.exists && password !== input("master-confirm").value) throw new Error("Die Master-Passwörter stimmen nicht überein.");
  input("master").value = ""; input("master-confirm").value = "";
  await api(state.exists ? "/api/unlock" : "/api/setup", "POST", { password });
  await refreshState();
  showView(state.username ? "search" : "settings"); input("username").value = state.username ?? "";
  void action(checkSap);
});
click("lock", async () => { clearPrivateView(); channel?.postMessage("locked"); await api("/api/lock", "POST"); await refreshState(); });
form("search-form", async () => {
  const query = input("query").value.trim();
  if (/^\d{4,10}$/.test(query)) { showView("search"); await openNote(query); }
  else await search(query, Number(el<HTMLSelectElement>("limit").value));
});
form("history-filter-form", () => history());
click("history-more", () => history(true));
click("clear-history", async () => { if (!window.confirm("Den gesamten Suchverlauf unwiderruflich löschen?")) return; await api("/api/history", "DELETE"); await history(); });
form("credentials-form", async () => {
  const username = input("username").value.trim(); const password = input("sap-password").value; input("sap-password").value = "";
  await api("/api/credentials", "PUT", { username, password }); await refreshState(); message("SAP-Zugangsdaten verschlüsselt gespeichert.");
  void action(checkSap);
});
click("delete-credentials", async () => {
  if (!window.confirm("SAP-Zugangsdaten und gespeicherte SAP-Session löschen? Dein Suchverlauf bleibt erhalten.")) return;
  await api("/api/credentials", "DELETE"); input("username").value = ""; input("sap-password").value = ""; await refreshState(); message("SAP-Zugangsdaten und Session gelöscht.");
});
form("password-form", async () => {
  const current = input("current-master").value; const next = input("next-master").value;
  if (next !== input("next-confirm").value) throw new Error("Die neuen Master-Passwörter stimmen nicht überein.");
  for (const id of ["current-master", "next-master", "next-confirm"]) input(id).value = "";
  await api("/api/password", "PUT", { current, next }); message("Master-Passwort geändert. Andere Browser-Sitzungen wurden abgemeldet.");
});
click("login-start", async () => { await api("/api/sap/login/start", "POST"); await refreshState(); });
click("login-finish", async () => { await api("/api/sap/login/finish", "POST"); await checkSap(); });
click("login-cancel", async () => { await api("/api/sap/login/cancel", "POST"); await refreshState(); });
async function showAbout(): Promise<void> {
  const dialog = el<HTMLDialogElement>("about");
  if (!dialog.open) dialog.showModal();
  el("about-status").hidden = false;
  el("about-status").textContent = "App-Informationen werden geladen …";
  el("about-details").hidden = true;
  try {
    const info = await api<AppInfo>("/api/about");
    el("about-name").textContent = info.name;
    el("about-version").textContent = info.version;
    el("about-commit").textContent = info.commit?.hash.slice(0, 12) ?? "Nicht verfügbar";
    el("about-commit").title = info.commit?.hash ?? "Keine Git-Informationen vorhanden";
    el("about-subject").textContent = info.commit?.subject ?? "";
    const date = el<HTMLTimeElement>("about-date");
    date.textContent = info.commit ? new Date(info.commit.date).toLocaleString("de-DE") : "";
    date.dateTime = info.commit?.date ?? "";
    el("about-status").hidden = true;
    el("about-details").hidden = false;
  } catch {
    el("about-status").textContent = "App-Informationen konnten nicht geladen werden. Bitte About erneut öffnen.";
  }
}
el("about-link").addEventListener("click", event => { event.preventDefault(); void showAbout(); });
if (window.location.hash === "#about") void showAbout();
window.addEventListener("pagehide", clearPrivateView);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshState().catch(() => undefined); });
setInterval(() => { if (state.unlocked && !document.hidden) void refreshState().catch(() => undefined); }, 5000);
void action(refreshState);

// Progressive enhancement: optional browser WebMCP, sharing the actual UI actions.
interface ModelTool { name: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute(input: unknown): Promise<unknown> }
const context = (document as Document & { modelContext?: { registerTool(tool: ModelTool, options: { signal: AbortSignal }): void | Promise<void> } }).modelContext;
if (context?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  const tools: ModelTool[] = [
    { name: "search_sap_notes", description: "Sucht SAP Notes, zeigt die Treffer und speichert die Suchanfrage im Verlauf. App muss entsperrt sein.", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 25 } }, required: ["query"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, async execute(value) {
      if (!state.unlocked) throw new Error("App zuerst entsperren.");
      const arg = value as { query?: unknown; limit?: unknown } | null;
      if (!arg || typeof arg.query !== "string" || (arg.limit !== undefined && typeof arg.limit !== "number") || Object.keys(arg).some(key => !["query", "limit"].includes(key))) throw new Error("Ungültige Eingabe.");
      return { hits: await search(arg.query, arg.limit ?? 10) };
    } },
    { name: "open_sap_note", description: "Öffnet die vollständige SAP Note in der sichtbaren Note-Ansicht. App muss entsperrt sein.", inputSchema: { type: "object", properties: { number: { type: "string", pattern: "^[0-9]{4,10}$" } }, required: ["number"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, async execute(value) {
      if (!state.unlocked) throw new Error("App zuerst entsperren.");
      const arg = value as { number?: unknown } | null;
      if (!arg || typeof arg.number !== "string" || Object.keys(arg).some(key => key !== "number")) throw new Error("Ungültige Eingabe.");
      showView("search"); return openNote(arg.number);
    } },
  ];
  for (const tool of tools) {
    try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined); }
    catch { /* Browsers without a working registry still have the full UI. */ }
  }
}
