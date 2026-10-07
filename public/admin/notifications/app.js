import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, OAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const $ = (id) => document.getElementById(id);
const config = window.__FIREBASE_CONFIG__ || {};
const auth = config.apiKey ? getAuth(initializeApp(config)) : null;
let token = "";
let selectedArticle = null;
let numberRows = [];

async function authorization() {
  if (auth?.currentUser) token = await auth.currentUser.getIdToken();
  return `Bearer ${token}`;
}

async function api(path, options = {}) {
  const response = await fetch(`/v1/notifications${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: await authorization(), ...(options.headers || {}) }
  });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error?.message || `HTTP ${response.status}`), { code: payload.error?.code, details: payload.error?.details });
  return payload;
}

async function authApi(path, options = {}) {
  const response = await fetch(`/v1/auth${path}`, { ...options, headers: { Authorization: await authorization() } });
  if (!response.ok) throw new Error("Your IBSi account could not be loaded.");
  return response.json();
}

async function appApi(path, options = {}) {
  const response = await fetch(`/v1/app${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: await authorization(), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
  return payload;
}

function status(message, error = false) { $("status").textContent = message; $("status").className = error ? "error" : ""; }
function target() {
  const choice = $("target-type").value;
  if (choice.startsWith("screen:")) return { type: "screen", screen: choice.split(":")[1] };
  if (choice === "article") return { type: "article", article_id: $("target-value").value.trim() };
  return { type: "url", url: $("target-value").value.trim() };
}
function messageBody() {
  return { kind: "message", title: $("title").value.trim(), body: $("body").value.trim(),
    ...($("image").value.trim() ? { image_url: $("image").value.trim() } : {}), target: target() };
}
function updatePreview() {
  $("title-count").textContent = `${$("title").value.length} / 65`;
  $("body-count").textContent = `${$("body").value.length} / 240`;
  $("title-count").className = $("title").value.length > 65 ? "warn" : "";
  $("body-count").className = $("body").value.length > 240 ? "warn" : "";
  $("preview-title").textContent = $("title").value || "IBS Intelligence";
  $("preview-body").textContent = $("body").value || "Your message preview.";
  const image = $("image").value.trim();
  $("preview-image").hidden = !image; if (image) $("preview-image").src = image;
}

async function loadArticles() {
  let articles;
  try {
    ({ articles } = await api("/articles?limit=30"));
  } catch (error) {
    // News is public and remains useful even if the admin-only Sent-badge
    // lookup has a transient problem. The database unique index still blocks
    // an accidental duplicate when Send is pressed.
    const response = await fetch("/v1/news?page=1&limit=30");
    if (!response.ok) throw error;
    const fallback = await response.json();
    articles = (fallback.articles || []).map((article) => ({
      id: String(article.id),
      headline: article.title,
      image_url: article.image_url,
      published_at: article.published_at,
      already_notified: false
    }));
    status("Latest news loaded; Sent badges are temporarily unavailable.", true);
  }
  $("articles").innerHTML = "";
  for (const article of articles) {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = `${article.image_url ? `<img src="${escapeHtml(article.image_url)}" alt="">` : "<span></span>"}<div><strong>${escapeHtml(article.headline)}</strong><p>${article.published_at ? new Date(article.published_at).toLocaleString() : ""} ${article.already_notified ? '<span class="sent">Sent</span>' : ""}</p></div><div class="row-actions"><button class="secondary preview-article">Send to me</button><button class="send-article" ${article.already_notified ? "disabled" : ""}>Send to everyone</button></div>`;
    row.addEventListener("click", () => selectArticle(article));
    row.querySelector(".preview-article").addEventListener("click", (event) => { event.stopPropagation(); selectArticle(article); void previewArticle(); });
    row.querySelector(".send-article").addEventListener("click", (event) => { event.stopPropagation(); selectArticle(article); void sendArticle(); });
    $("articles").append(row);
  }
}
function selectArticle(article) {
  selectedArticle = article; $("preview-title").textContent = "IBS Intelligence"; $("preview-body").textContent = article.headline;
  $("preview-image").hidden = !article.image_url; if (article.image_url) $("preview-image").src = article.image_url;
}
async function previewArticle() {
  if (!selectedArticle) return; status("Sending preview…");
  try { const result = await api("/preview", { method: "POST", body: JSON.stringify({ kind: "article", article_id: selectedArticle.id, headline: selectedArticle.headline, image_url: selectedArticle.image_url || undefined }) }); status(`Preview accepted on ${result.sent} device(s).`); }
  catch (error) { status(error.message, true); }
}
async function confirmedBroadcast(body, description, options = {}) {
  const audience = options.audience || JSON.parse($("audience").value || '{"type":"all"}');
  const audienceResult = options.audience
    ? await api(`/audience-count?audience=${encodeURIComponent(JSON.stringify(audience))}`)
    : null;
  const count = audienceResult
    ? `${audienceResult.devices} devices / ${audienceResult.users} users`
    : $("audience-count").textContent;
  if (!confirm(`Send to ${count}?\n\n${description}`)) return;
  const request = { ...body, audience, confirm: true };
  if (options.allowSchedule !== false && $("scheduled-at").value) request.scheduled_at = new Date($("scheduled-at").value).toISOString();
  try { return await api("/broadcast", { method: "POST", body: JSON.stringify(request) }); }
  catch (error) {
    if (error.code === "DAILY_CAP" && confirm(`${error.message}. Readers switch notifications off when there are too many. Send anyway?`)) {
      return api("/broadcast", { method: "POST", body: JSON.stringify({ ...request, confirm_cap: true }) });
    }
    throw error;
  }
}
async function sendArticle() {
  if (!selectedArticle) return;
  try { status("Sending…"); await confirmedBroadcast({ kind: "article", article_id: selectedArticle.id, headline: selectedArticle.headline, image_url: selectedArticle.image_url || undefined }, selectedArticle.headline, { audience: { type: "all" }, allowSchedule: false }); status("Article notification accepted."); await Promise.all([loadArticles(), loadHistory()]); }
  catch (error) { status(error.message, true); }
}

async function countAudience() {
  try { const result = await api(`/audience-count?audience=${encodeURIComponent($("audience").value)}`); $("audience-count").textContent = `${result.devices} devices / ${result.users} users`; }
  catch (error) { $("audience-count").textContent = error.message; }
}
async function loadHistory() {
  const history = $("history");
  history.innerHTML = "<p>Loading…</p>";
  try {
    const { broadcasts } = await api("/broadcasts?limit=50");
    history.innerHTML = "";
    if (!broadcasts.length) {
      history.innerHTML = "<p>No broadcasts yet. Test messages sent with <strong>Send to me</strong> are not recorded here.</p>";
      return;
    }
    for (const item of broadcasts) {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<span class="badge">${escapeHtml(item.kind)}</span><div><strong>${escapeHtml(item.title || item.headline || "Untitled")}</strong><p>${new Date(item.created_at).toLocaleString()} · ${escapeHtml(item.requested_by_name || "Deleted user")} · ${escapeHtml(JSON.stringify(item.audience))}</p><p>${escapeHtml(item.status)} · targeted ${item.target_count} · accepted ${item.accepted_count} · delivered ${item.delivered_count} · failed ${item.failed_count}</p></div>${item.status === "scheduled" ? '<div class="row-actions"><button class="cancel">Cancel</button></div>' : ""}`;
      row.querySelector(".cancel")?.addEventListener("click", async () => { if (!confirm("Cancel this scheduled notification?")) return; try { await api(`/broadcasts/${item.id}`, { method: "DELETE" }); await loadHistory(); } catch (error) { status(error.message, true); } });
      history.append(row);
    }
  } catch (error) {
    history.innerHTML = `<div class="error-state"><p>History could not be loaded: ${escapeHtml(error.message)}</p><button type="button" class="secondary retry-history">Retry</button></div>`;
    history.querySelector(".retry-history")?.addEventListener("click", () => void loadHistory());
  }
}

function localDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function nullableBuild(id) {
  const value = $(id).value.trim();
  return value === "" ? null : Number(value);
}

function gateBody() {
  return {
    min_ios_version: $("min-ios-version").value.trim(),
    min_ios_build: nullableBuild("min-ios-build"),
    min_android_version: $("min-android-version").value.trim(),
    min_android_build: nullableBuild("min-android-build")
  };
}

function noticeBody(active = $("notice-active").checked) {
  return {
    notice_active: active,
    notice_level: $("notice-level").value,
    notice_title: $("notice-title").value.trim() || null,
    notice_message: $("notice-message").value.trim() || null,
    notice_link: $("notice-link").value.trim() || null,
    notice_until: $("notice-until").value ? new Date($("notice-until").value).toISOString() : null
  };
}

function updateNoticePreview() {
  const preview = $("notice-preview");
  preview.className = `notice-preview ${$("notice-level").value}`;
  preview.querySelector("strong").textContent = $("notice-title").value.trim() || "Service notice preview";
  preview.querySelector("p").textContent = $("notice-message").value.trim() || "Your message will appear here.";
}

async function loadAppStatus(showLoading = true) {
  if (showLoading) $("app-status-result").textContent = "Loading…";
  try {
    const { status: current } = await appApi("/status/config");
    $("min-ios-version").value = current.min_ios_version;
    $("min-ios-build").value = current.min_ios_build ?? "";
    $("min-android-version").value = current.min_android_version;
    $("min-android-build").value = current.min_android_build ?? "";
    $("update-message").value = current.update_message;
    $("notice-active").checked = current.notice_active;
    $("notice-level").value = current.notice_level;
    $("notice-title").value = current.notice_title ?? "";
    $("notice-message").value = current.notice_message ?? "";
    $("notice-link").value = current.notice_link ?? "";
    $("notice-until").value = localDateTime(current.notice_until);
    $("app-status-meta").textContent = `Last changed ${new Date(current.updated_at).toLocaleString()} by ${current.updated_by_name || "system"}.`;
    if (showLoading) $("app-status-result").textContent = "";
    updateNoticePreview();
  } catch (error) {
    $("app-status-result").textContent = `Status settings could not be loaded: ${error.message}`;
    $("app-status-result").className = "error";
  }
}

async function saveGate(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const gate = gateBody();
  try {
    $("app-status-result").textContent = "Calculating affected installations…";
    const impact = await appApi("/status/impact", { method: "POST", body: JSON.stringify(gate) });
    const message = impact.known
      ? `This gate will require an update from ${impact.blocked} of ${impact.known} measured installations (${impact.ios.blocked} iOS, ${impact.android.blocked} Android). Save it?`
      : "No installation versions have been measured yet. A wrong gate can block readers. Save it anyway?";
    if (!confirm(message)) { $("app-status-result").textContent = "Update gate was not changed."; return; }
    await appApi("/status", { method: "PUT", body: JSON.stringify({ ...gate, update_message: $("update-message").value.trim() }) });
    $("app-status-result").className = "";
    $("app-status-result").textContent = "Update gate saved.";
    await loadAppStatus(false);
  } catch (error) {
    $("app-status-result").className = "error";
    $("app-status-result").textContent = error.message;
  }
}

async function saveNotice(event) {
  event?.preventDefault();
  if (event && !event.currentTarget.reportValidity()) return;
  if ($("notice-active").checked && !$("notice-message").value.trim()) {
    $("app-status-result").className = "error";
    $("app-status-result").textContent = "Enter a notice message before switching it on.";
    return;
  }
  try {
    await appApi("/status", { method: "PUT", body: JSON.stringify(noticeBody()) });
    $("app-status-result").className = "";
    $("app-status-result").textContent = $("notice-active").checked ? "Service notice saved and active." : "Service notice saved and inactive.";
    await loadAppStatus(false);
  } catch (error) {
    $("app-status-result").className = "error";
    $("app-status-result").textContent = error.message;
  }
}

async function switchNoticeOff() {
  try {
    await appApi("/status", { method: "PUT", body: JSON.stringify({ notice_active: false }) });
    $("notice-active").checked = false;
    $("app-status-result").className = "";
    $("app-status-result").textContent = "Service notice switched off.";
    await loadAppStatus(false);
  } catch (error) {
    $("app-status-result").className = "error";
    $("app-status-result").textContent = error.message;
  }
}

async function loadNumbers() {
  const table = $("numbers-table");
  table.innerHTML = "<p>Loading…</p>";
  try {
    const result = await appApi(`/events/summary?days=${$("numbers-days").value}`);
    numberRows = result.rows;
    if (!numberRows.length) { table.innerHTML = "<p>No app events have been received for this period yet.</p>"; return; }
    table.innerHTML = `<table class="data-table"><thead><tr><th>Day</th><th>Event</th><th>Platform</th><th>Events</th><th>Installations</th><th>Readers</th></tr></thead><tbody>${numberRows.map((row) => `<tr><td>${escapeHtml(row.day)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.platform || "all")}</td><td>${row.events}</td><td>${row.installations}</td><td>${row.users}</td></tr>`).join("")}</tbody></table>`;
  } catch (error) {
    table.innerHTML = `<div class="error-state"><p>Numbers could not be loaded: ${escapeHtml(error.message)}</p></div>`;
  }
}

function exportNumbers() {
  if (!numberRows.length) { alert("There are no rows to export."); return; }
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [["day", "event", "platform", "events", "installations", "readers"], ...numberRows.map((row) => [row.day, row.name, row.platform, row.events, row.installations, row.users])]
    .map((row) => row.map(quote).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `ibsi-app-events-${$("numbers-days").value}-days.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
function escapeHtml(value) { const node = document.createElement("div"); node.textContent = String(value ?? ""); return node.innerHTML; }

function closeHelp(exceptButton) {
  for (const button of document.querySelectorAll(".help-button")) {
    if (button === exceptButton) continue;
    button.setAttribute("aria-expanded", "false");
    const popover = $(button.getAttribute("aria-controls"));
    if (popover) popover.hidden = true;
  }
}
for (const button of document.querySelectorAll(".help-button")) button.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const popover = $(button.getAttribute("aria-controls"));
  const opening = button.getAttribute("aria-expanded") !== "true";
  closeHelp(opening ? button : null);
  button.setAttribute("aria-expanded", String(opening));
  if (popover) popover.hidden = !opening;
});
document.addEventListener("click", () => closeHelp());
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeHelp(); });

for (const button of document.querySelectorAll("nav button")) button.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((item) => item.classList.toggle("active", item === button));
  for (const name of ["news", "message", "history", "app-status", "numbers"]) $(`${name}-panel`).hidden = name !== button.dataset.tab;
  $("preview-panel").hidden = !["news", "message"].includes(button.dataset.tab);
  if (button.dataset.tab === "history") void loadHistory();
  if (button.dataset.tab === "app-status") void loadAppStatus();
  if (button.dataset.tab === "numbers") void loadNumbers();
});
for (const id of ["title", "body", "image"]) $(id).addEventListener("input", updatePreview);
$("target-type").addEventListener("change", () => { $("target-value-wrap").hidden = $("target-type").value.startsWith("screen:"); });
$("audience").addEventListener("change", countAudience);
$("message-preview").addEventListener("click", async () => { try { status("Sending preview…"); const result = await api("/preview", { method: "POST", body: JSON.stringify(messageBody()) }); status(`Preview accepted on ${result.sent} device(s).`); } catch (error) { status(error.message, true); } });
$("message-send").addEventListener("click", async () => { try { status("Submitting…"); await confirmedBroadcast(messageBody(), `${$("title").value}\n${$("body").value}`); status($("scheduled-at").value ? "Notification scheduled." : "Notification accepted."); await loadHistory(); } catch (error) { status(error.message, true); } });
$("update-gate-form").addEventListener("submit", saveGate);
$("notice-form").addEventListener("submit", saveNotice);
$("notice-off").addEventListener("click", switchNoticeOff);
for (const id of ["notice-level", "notice-title", "notice-message"]) $(id).addEventListener("input", updateNoticePreview);
$("numbers-days").addEventListener("change", loadNumbers);
$("numbers-export").addEventListener("click", exportNumbers);
$("google").addEventListener("click", async () => {
  if (!auth) return;
  $("auth-error").textContent = "";
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try { await signInWithPopup(auth, provider); }
  catch (error) { $("auth-error").textContent = `${error.code || "auth/error"}: ${error.message}`; }
});
$("microsoft").addEventListener("click", async () => {
  if (!auth) return;
  $("auth-error").textContent = "";
  try { await signInWithPopup(auth, new OAuthProvider("microsoft.com")); }
  catch (error) { $("auth-error").textContent = `${error.code || "auth/error"}: ${error.message}`; }
});
$("sign-out").addEventListener("click", () => auth && signOut(auth));

if (!auth) $("auth-error").textContent = "Firebase Web API settings are not configured on this server.";
else onAuthStateChanged(auth, async (user) => {
  $("sign-in").hidden = Boolean(user); $("sign-out").hidden = !user; $("console").hidden = true; $("denied").hidden = true;
  if (!user) return;
  try {
    token = await user.getIdToken();
    await authApi("/sync-user", { method: "POST" });
    const { user: profile } = await authApi("/me");
    $("identity").textContent = profile.display_name || profile.email || "Signed in"; $("role").textContent = profile.role;
    if (!["admin", "super_admin"].includes(profile.role)) { $("denied").hidden = false; return; }
    $("console").hidden = false;
    updatePreview();
    const initial = await Promise.allSettled([loadArticles(), loadHistory(), countAudience()]);
    const failed = initial.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      status(`One console panel could not load: ${failed.reason?.message || "Unknown error"}`, true);
    }
  } catch (error) { $("auth-error").textContent = error.message; $("sign-in").hidden = false; }
});
