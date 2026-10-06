import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, OAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const $ = (id) => document.getElementById(id);
const config = window.__FIREBASE_CONFIG__ || {};
const auth = config.apiKey ? getAuth(initializeApp(config)) : null;
let token = "";
let selectedArticle = null;

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
  const { broadcasts } = await api("/broadcasts?limit=50"); $("history").innerHTML = "";
  for (const item of broadcasts) {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = `<span class="badge">${escapeHtml(item.kind)}</span><div><strong>${escapeHtml(item.title || item.headline || "Untitled")}</strong><p>${new Date(item.created_at).toLocaleString()} · ${escapeHtml(item.requested_by_name || "Deleted user")} · ${escapeHtml(JSON.stringify(item.audience))}</p><p>${escapeHtml(item.status)} · targeted ${item.target_count} · accepted ${item.accepted_count} · delivered ${item.delivered_count} · failed ${item.failed_count}</p></div>${item.status === "scheduled" ? '<div class="row-actions"><button class="cancel">Cancel</button></div>' : ""}`;
    row.querySelector(".cancel")?.addEventListener("click", async () => { if (!confirm("Cancel this scheduled notification?")) return; try { await api(`/broadcasts/${item.id}`, { method: "DELETE" }); await loadHistory(); } catch (error) { status(error.message, true); } });
    $("history").append(row);
  }
}
function escapeHtml(value) { const node = document.createElement("div"); node.textContent = String(value ?? ""); return node.innerHTML; }

for (const button of document.querySelectorAll("nav button")) button.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((item) => item.classList.toggle("active", item === button));
  for (const name of ["news", "message", "history"]) $(`${name}-panel`).hidden = name !== button.dataset.tab;
  if (button.dataset.tab === "history") void loadHistory();
});
for (const id of ["title", "body", "image"]) $(id).addEventListener("input", updatePreview);
$("target-type").addEventListener("change", () => { $("target-value-wrap").hidden = $("target-type").value.startsWith("screen:"); });
$("audience").addEventListener("change", countAudience);
$("message-preview").addEventListener("click", async () => { try { status("Sending preview…"); const result = await api("/preview", { method: "POST", body: JSON.stringify(messageBody()) }); status(`Preview accepted on ${result.sent} device(s).`); } catch (error) { status(error.message, true); } });
$("message-send").addEventListener("click", async () => { try { status("Submitting…"); await confirmedBroadcast(messageBody(), `${$("title").value}\n${$("body").value}`); status($("scheduled-at").value ? "Notification scheduled." : "Notification accepted."); await loadHistory(); } catch (error) { status(error.message, true); } });
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
