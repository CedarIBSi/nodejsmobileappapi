/**
 * The Events section of the admin console: the summits and awards list,
 * one event at a time in a form, and the page copy around the list in
 * per-section boxes. Talks to /v1/admin/events; what it saves is what
 * GET /v1/events serves the app within its five-minute cache.
 *
 * Wired from app.js, which owns sign-in, the sidebar and the API helpers.
 */
export function setupEvents({ $, adminApi, escapeHtml }) {
  let state = { events: [], page: null, today: "" };
  /** The id of the event open in the form, or null for a new one. */
  let editingId = null;

  const result = (id, message, error = false) => {
    $(id).textContent = message;
    $(id).className = error ? "error" : "";
  };

  // ---------------------------------------------------------------- events

  const eventStatus = (event) => {
    if (!event.is_published) return ["Unpublished", "pill-unpublished"];
    if (event.starts_on && event.starts_on < state.today) return ["Past", "pill-past"];
    return ["Upcoming", "pill-upcoming"];
  };

  function renderEvents() {
    const table = $("events-table");
    if (!state.events.length) {
      table.innerHTML = "<p>No events yet. Add the first with <strong>New event</strong>.</p>";
      return;
    }
    table.innerHTML = `<table class="data-table events-table"><thead><tr><th>Event</th><th>City</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>${state.events
      .map((event) => {
        const [label, pill] = eventStatus(event);
        return `<tr><td><strong>${escapeHtml(event.title)}</strong>${event.is_featured ? '<span class="pill pill-featured">Featured</span>' : ""}</td><td>${escapeHtml(event.city)}</td><td>${escapeHtml(event.date_label || event.starts_on || "Date not set")}</td><td><span class="pill ${pill}">${label}</span></td><td class="row-actions"><button type="button" class="secondary" data-edit="${escapeHtml(event.id)}">Edit</button></td></tr>`;
      })
      .join("")}</tbody></table>`;
    for (const button of table.querySelectorAll("button[data-edit]")) {
      button.addEventListener("click", () => openEvent(button.dataset.edit));
    }
  }

  const slugify = (value) =>
    String(value ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  /** "28 October 2026" from a date input value, for the label when it is left blank. */
  const longDate = (iso) => {
    if (!iso) return "";
    const [year, month, day] = iso.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  };

  const suggestedId = () => {
    const year = ($("ev-starts-on").value || "").slice(0, 4);
    const city = slugify(($("ev-city").value || "").split(",")[0]);
    return [year, city, slugify($("ev-title").value)].filter(Boolean).join("-");
  };

  function fillEventForm(event) {
    $("ev-id").value = event?.id ?? "";
    $("ev-id").readOnly = Boolean(event);
    $("ev-title").value = event?.title ?? "";
    $("ev-city").value = event?.city ?? "";
    $("ev-starts-on").value = event?.starts_on ?? "";
    $("ev-date-label").value = event?.date_label ?? "";
    $("ev-venue").value = event?.venue ?? "";
    $("ev-email").value = event?.registration_email ?? "";
    $("ev-summary").value = event?.summary ?? "";
    $("ev-image").value = event?.image_url ?? "";
    $("ev-sort").value = String(event?.sort_order ?? 0);
    $("ev-featured").checked = Boolean(event?.is_featured);
    $("ev-published").checked = event ? Boolean(event.is_published) : true;
    updateImagePreview();
  }

  function updateImagePreview() {
    const url = $("ev-image").value.trim();
    const preview = $("ev-image-preview");
    preview.hidden = !url;
    if (url) preview.src = url;
  }

  function openEvent(id) {
    const event = state.events.find((item) => item.id === id) ?? null;
    editingId = event ? event.id : null;
    $("event-form-title").textContent = event ? `Edit: ${event.title}` : "New event";
    $("event-delete").hidden = !event;
    fillEventForm(event);
    $("event-form").hidden = false;
    result("events-result", "");
    $("event-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeEventForm() {
    editingId = null;
    $("event-form").hidden = true;
  }

  const nullable = (value) => (value.trim() ? value.trim() : null);

  function eventBody() {
    const startsOn = $("ev-starts-on").value || null;
    return {
      title: $("ev-title").value.trim(),
      summary: $("ev-summary").value.trim(),
      date_label: $("ev-date-label").value.trim() || longDate(startsOn),
      starts_on: startsOn,
      city: $("ev-city").value.trim(),
      venue: nullable($("ev-venue").value),
      image_url: nullable($("ev-image").value),
      is_featured: $("ev-featured").checked,
      registration_email: nullable($("ev-email").value),
      is_published: $("ev-published").checked,
      sort_order: Number($("ev-sort").value || 0)
    };
  }

  async function saveEvent(submit) {
    submit.preventDefault();
    const body = eventBody();
    try {
      result("events-result", "Saving…");
      if (editingId) {
        await adminApi(`/events/events/${encodeURIComponent(editingId)}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        const id = $("ev-id").value.trim() || suggestedId();
        if (!id) throw new Error("Give the event a title before saving.");
        await adminApi("/events/events", { method: "POST", body: JSON.stringify({ id, ...body }) });
      }
      closeEventForm();
      await loadEvents(false);
      result("events-result", "Event saved. The app picks it up within five minutes.");
    } catch (error) {
      result("events-result", error.message, true);
    }
  }

  async function deleteEvent() {
    if (!editingId) return;
    const event = state.events.find((item) => item.id === editingId);
    if (!confirm(`Delete "${event?.title ?? editingId}"? This cannot be undone. To hide it without deleting, untick Published instead.`)) return;
    try {
      result("events-result", "Deleting…");
      await adminApi(`/events/events/${encodeURIComponent(editingId)}`, { method: "DELETE" });
      closeEventForm();
      await loadEvents(false);
      result("events-result", "Event deleted.");
    } catch (error) {
      result("events-result", error.message, true);
    }
  }

  async function loadEvents(showLoading = true) {
    if (showLoading) $("events-table").innerHTML = "<p>Loading…</p>";
    try {
      state = await adminApi("/events");
      renderEvents();
      const upcoming = state.events.filter((event) => eventStatus(event)[0] === "Upcoming").length;
      const featured = state.events.find((event) => event.is_featured && eventStatus(event)[0] === "Upcoming");
      $("events-meta").textContent = `${upcoming} upcoming in the app${featured ? `, featured: ${featured.title} (${featured.city})` : ", nothing featured"}. An event leaves the app the day after its date; unpublished events never show.`;
    } catch (error) {
      $("events-table").innerHTML = `<p class="error">Events could not be loaded: ${escapeHtml(error.message)}</p>`;
    }
  }

  // ----------------------------------------------------------- page content

  const lines = (value) => value.split("\n").map((item) => item.trim()).filter(Boolean);
  const paragraphs = (value) => value.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);

  /** Field specs for the repeating sections, in the order the inputs appear. */
  const repeaters = {
    stats: [
      { key: "label", label: "Label", placeholder: "In-person attendees" },
      { key: "value", label: "Value", placeholder: "3,000+" }
    ],
    series: [
      { key: "key", label: "Key (lower-case, hyphens)", placeholder: "summits" },
      { key: "title", label: "Title", placeholder: "Summits" },
      { key: "body", label: "Description", type: "textarea", placeholder: "One or two sentences." },
      { key: "items", label: "Items, one per line", type: "lines", placeholder: "IBSi Digital Banking Awards" }
    ],
    videos: [
      { key: "id", label: "Id (lower-case, hyphens)", placeholder: "summits-2025-highlights" },
      { key: "title", label: "Title", placeholder: "Cedar-IBSi Summits - 2025 highlights" },
      { key: "youtubeId", label: "YouTube video id", placeholder: "G2Hm_84jU7I" },
      { key: "dateLabel", label: "Date as shown", placeholder: "2025", optional: true },
      { key: "thumbnailUrl", label: "Thumbnail URL (optional; YouTube's is used otherwise)", placeholder: "https://…", optional: true }
    ],
    insights: [
      { key: "id", label: "Id (lower-case, hyphens)", placeholder: "digital-islamic-banking" },
      { key: "title", label: "Title", placeholder: "Adding the Power of Digital to Islamic Banking" },
      { key: "topic", label: "Topic", placeholder: "Digital Banking", optional: true },
      { key: "summary", label: "Summary", type: "textarea", placeholder: "Optional", optional: true }
    ]
  };

  function repeaterRow(section, row = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "repeater-row";
    const fields = document.createElement("div");
    fields.className = "repeater-fields";
    for (const field of repeaters[section]) {
      const label = document.createElement("label");
      label.append(field.label);
      const input = document.createElement(field.type === "textarea" || field.type === "lines" ? "textarea" : "input");
      input.dataset.key = field.key;
      input.placeholder = field.placeholder ?? "";
      const value = row[field.key];
      input.value = field.type === "lines" ? (Array.isArray(value) ? value.join("\n") : "") : value ?? "";
      label.append(input);
      fields.append(label);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "repeater-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => wrapper.remove());
    wrapper.append(fields, remove);
    return wrapper;
  }

  function renderRepeater(section, rows) {
    const container = $(`rep-${section}`);
    container.replaceChildren(...rows.map((row) => repeaterRow(section, row)));
  }

  function readRepeater(section) {
    return Array.from($(`rep-${section}`).querySelectorAll(".repeater-row")).map((row) => {
      const item = {};
      for (const field of repeaters[section]) {
        const raw = row.querySelector(`[data-key="${field.key}"]`).value;
        if (field.type === "lines") item[field.key] = lines(raw);
        else if (field.optional) item[field.key] = raw.trim() || null;
        else item[field.key] = raw.trim();
      }
      return item;
    });
  }

  function renderPage() {
    const page = state.page;
    if (!page) return;
    $("pg-intro").value = page.intro ?? "";
    $("pg-intro-points").value = (page.intro_points ?? []).join("\n");
    $("pg-about-heading").value = page.about?.heading ?? "";
    $("pg-about-body").value = (page.about?.body ?? []).join("\n\n");
    $("pg-about-points").value = (page.about?.points ?? []).join("\n");
    for (const section of Object.keys(repeaters)) renderRepeater(section, page[section] ?? []);
    $("events-page-meta").textContent = page.updated_at
      ? `Last changed ${new Date(page.updated_at).toLocaleString()}. Each box saves on its own.`
      : "Each box saves on its own.";
  }

  function sectionBody(section) {
    switch (section) {
      case "intro":
        return { intro: $("pg-intro").value.trim(), intro_points: lines($("pg-intro-points").value) };
      case "about":
        return {
          about: {
            heading: $("pg-about-heading").value.trim(),
            body: paragraphs($("pg-about-body").value),
            points: lines($("pg-about-points").value)
          }
        };
      default:
        return { [section]: readRepeater(section) };
    }
  }

  async function savePageSection(submit) {
    submit.preventDefault();
    const section = submit.currentTarget.dataset.section;
    try {
      result("events-page-result", "Saving…");
      const { page } = await adminApi("/events/page", { method: "PUT", body: JSON.stringify(sectionBody(section)) });
      state.page = page;
      renderPage();
      result("events-page-result", `${submit.currentTarget.querySelector("h3").textContent} saved. The app picks it up within five minutes.`);
    } catch (error) {
      result("events-page-result", error.message, true);
    }
  }

  async function loadEventsPage() {
    result("events-page-result", "Loading…");
    try {
      state = await adminApi("/events");
      renderPage();
      result("events-page-result", "");
    } catch (error) {
      result("events-page-result", `Page content could not be loaded: ${error.message}`, true);
    }
  }

  // ----------------------------------------------------------------- wiring

  $("event-new").addEventListener("click", () => openEvent(null));
  $("event-form").addEventListener("submit", saveEvent);
  $("event-cancel").addEventListener("click", closeEventForm);
  $("event-delete").addEventListener("click", deleteEvent);
  $("ev-image").addEventListener("input", updateImagePreview);
  for (const form of document.querySelectorAll("#events-page-panel form[data-section]")) {
    form.addEventListener("submit", savePageSection);
  }
  for (const button of document.querySelectorAll("#events-page-panel button[data-add]")) {
    button.addEventListener("click", () => $(`rep-${button.dataset.add}`).append(repeaterRow(button.dataset.add)));
  }

  return { loadEvents, loadEventsPage };
}
