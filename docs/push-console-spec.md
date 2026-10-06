# Push notification console - build spec

For the API developer. Written 2026-10-06. Goal: editorial and marketing send
push notifications themselves from a web page, without engineering, with a
preview, an audience choice and a history. Everything below builds on what
the API already has; nothing is replaced.

## 1. What exists today, and stays

| Piece | Where | Keep as is |
| --- | --- | --- |
| Device tokens | `push_tokens` (`expo_push_token`, `platform`, `user_id`, `device_id`) | yes |
| Send to one user | `sendPushNotificationToUser()` in `services/expoPush.ts`, route `POST /v1/notifications/send` | yes, reused for "send to me" |
| Broadcast an article to every device | `broadcastArticle()` in `services/expoPush.ts`, route `POST /v1/notifications/article` | yes, becomes one kind of broadcast |
| Broadcast record and receipts | `article_push_broadcasts`, `expo_push_receipts`, receipt worker | yes, table generalised in §4 |
| Auth | `privateRoute` (Firebase ID token -> `app_users`), `isAdminRole()` on `app_users.role` (`admin`, `super_admin`) | yes |
| Article metadata from WordPress | `getArticleMetadata()`, `listNews()` in `services/wordpress.ts` | yes |
| Expo batching, receipts, stale-token pruning | `expoPush.ts` | yes |

The app opens a notification whose `data` is `{ type: 'news_article', article_id, image_url? }`
(`src/services/notificationRouting.ts` in the app). Any other `data.type` is
ignored by current builds; §7 adds two more types on the app side.

## 2. The console page

One static page, served by the API at `GET /admin/notifications`. Plain HTML
and JavaScript, no framework or build step, served with `express.static` from
`public/admin/`. The page holds no secrets: it signs the user in with the
Firebase **web** SDK (the project's public web config, the same project the
app uses), using the Google and Microsoft providers, then calls the routes in
§3 with the Firebase ID token as `Authorization: Bearer`. The API decides who
may send by role; the page only hides buttons.

Firebase: add `api.ibsintelligence.com` to Authentication -> Settings ->
Authorised domains, or sign-in redirects will be refused.

Layout, top to bottom:

1. **Sign in** (Google / Microsoft). After sign-in, show the user's name and
   role. If `role` is not `admin` or `super_admin`, show "Ask an administrator
   for sending rights" and nothing else.
2. **Tabs**: News, Message, History.
3. **News tab**: the 30 most recent articles from `GET /v1/notifications/articles`
   (§3.1) as rows: thumbnail, headline, published time, and a "Sent" badge
   where `already_notified` is true. Clicking a row fills the preview with the
   headline and image; the title is fixed as "IBS Intelligence". Buttons: *Send
   to me*, *Send to everyone*. Everyone sends go through the confirm in §6.
4. **Message tab**: fields Title (max 65 shown, 200 allowed), Body (max 240
   shown, 1000 allowed), Image URL (optional, https), *Opens*: a dropdown of
   screens (News, Exclusive, Journal, Subscribe, Events, About) or an Article
   id or a Web URL; *Audience* (§5) with the live device count from §3.4;
   *Send at* (optional date-time, local, converted to UTC). Buttons: *Send to
   me*, *Send to everyone* / *Schedule*.
5. **Preview**: a phone-notification mock-up: app icon, "IBS Intelligence" or
   the title, the body, the image. Updates as fields change.
6. **History tab**: the last 50 broadcasts from §3.5: when, who, kind, title or
   headline, audience, status, targeted / accepted / delivered / failed. A
   *Cancel* button on rows with status `scheduled`.

## 3. Routes

All under `/v1/notifications`, all `privateRoute` + `isAdminRole`, all JSON.
Validation with zod as elsewhere.

### 3.1 `GET /articles?limit=30`
Returns the latest news from `listNews()` joined to `push_broadcasts` on
`article_id`:
```json
{ "articles": [ { "id": "576443", "headline": "...", "image_url": "...", "published_at": "...", "already_notified": false } ] }
```

### 3.2 `POST /broadcast`
The general send. Body:
```json
{
  "kind": "article" | "message",
  "article_id": "576443",            // kind=article
  "headline": "...", "summary": "...", "image_url": "...",   // article overrides, optional
  "title": "...", "body": "...",      // kind=message
  "target": { "type": "screen", "screen": "journal" }
          | { "type": "article", "article_id": "..." }
          | { "type": "url", "url": "https://..." },
  "audience": { ...see §5... },
  "scheduled_at": "2026-10-07T03:30:00Z",   // optional; absent = now
  "confirm": true                            // required when audience is everyone, see §6
}
```
Behaviour: insert a `push_broadcasts` row (status `scheduled` if `scheduled_at`
is in the future, else `processing`), then for an immediate send run the
existing batching loop from `broadcastArticle()` against the audience query
from §5. Return `202` with the row. `kind=article` keeps the existing rules:
headline and image from WordPress unless overridden, and `409
ARTICLE_ALREADY_NOTIFIED` on a repeat. Refactor `broadcastArticle()` into
`runBroadcast(broadcastId)` so the scheduler (§4) and this route share it.

The notification payload:
- `kind=article`: unchanged - title "IBS Intelligence", body = headline,
  `data: { type: 'news_article', article_id, image_url? }`.
- `kind=message`: title and body as given, `richContent.image` if an image,
  `data` is `{ type: 'screen', screen }` or `{ type: 'news_article', article_id }`
  or `{ type: 'url', url }`.

Keep `POST /article` working as a thin wrapper that calls the same code with
`kind: 'article'`, audience everyone, so nothing already scripted breaks.

### 3.3 `POST /preview`
Same body as 3.2 minus audience and schedule. Sends only to the caller:
`sendPushNotificationToUser(req.appUser.id, ...)` with the same payload
construction. Records nothing. Returns the Expo ticket summary.

### 3.4 `GET /audience-count?audience=<url-encoded JSON>`
Returns `{ "devices": 1234, "users": 1100 }` for the audience in §5. The page
calls it whenever the audience changes.

### 3.5 `GET /broadcasts?limit=50` and `DELETE /broadcasts/:id`
List, newest first, joined to `app_users` for `requested_by_name`. DELETE
only when status is `scheduled`; sets `cancelled`. Keep the existing
`GET /article/:broadcastId` as an alias of a single-row fetch.

## 4. Data model, migration 034

Generalise the existing table rather than adding a second one, so receipts
keep one foreign key:

```sql
ALTER TABLE article_push_broadcasts RENAME TO push_broadcasts;
ALTER TABLE push_broadcasts
  ADD COLUMN kind text NOT NULL DEFAULT 'article' CHECK (kind IN ('article','message')),
  ADD COLUMN title text,
  ADD COLUMN body text,
  ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN audience jsonb NOT NULL DEFAULT '{"type":"all"}'::jsonb,
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ALTER COLUMN article_id DROP NOT NULL,
  DROP CONSTRAINT article_push_broadcasts_article_id_key;
CREATE UNIQUE INDEX push_broadcasts_article_once ON push_broadcasts (article_id) WHERE article_id IS NOT NULL;
ALTER TABLE push_broadcasts DROP CONSTRAINT article_push_broadcasts_status_check;
ALTER TABLE push_broadcasts ADD CONSTRAINT push_broadcasts_status_check
  CHECK (status IN ('scheduled','processing','accepted','partial','failed','cancelled'));
-- expo_push_receipts.broadcast_id keeps its FK; Postgres follows the rename.
```
`headline` stays for `kind=article`; `title`/`body` are for `kind=message`.
Existing rows keep working with the defaults.

**Scheduler.** A worker alongside `startExpoReceiptWorker()`: every 30
seconds, `SELECT ... FROM push_broadcasts WHERE status='scheduled' AND
scheduled_at <= now() FOR UPDATE SKIP LOCKED LIMIT 1`, flip to `processing`,
run `runBroadcast()`. The App Service runs one instance today; the row lock
keeps it safe if that ever changes. Migrations are applied by hand, as always.

## 5. Audience

`audience` is JSON; the API turns it into one SQL query over `push_tokens`
joined to `app_users` and `entitlements`. Only what the database already
knows:

| `audience` | SQL meaning |
| --- | --- |
| `{"type":"all"}` | every row in `push_tokens` |
| `{"type":"platform","platform":"ios"}` or `android` | `push_tokens.platform = $1` |
| `{"type":"subscribers"}` | users with an entitlement where `status='active'` and (`ends_at` is null or `> now()`) |
| `{"type":"free"}` | users with no such entitlement |
| `{"type":"entitlement","entitlement_type":"journal_india"}` or `journal_global` or `insights` | users holding that entitlement, active, unexpired |

Combinations are out of scope for version one. Topic or region targeting is
not possible until the app records follows; do not add a fake option.

## 6. Guardrails

- **Confirm for everyone.** Any audience other than the caller must be sent
  with `confirm: true`; the page shows a second step stating the device count
  and the exact text before setting it.
- **Daily cap.** Count non-cancelled broadcasts in the last 24 hours. From the
  fourth onward, return `429 DAILY_CAP` unless `confirm_cap: true` is also
  sent; the page shows "This is the Nth notification today - readers switch
  notifications off when there are too many" and asks again.
- **Article once.** Already enforced by the unique index.
- **Length.** The page warns past 65 title and 240 body characters, which is
  what a lock screen shows; the API allows the existing 200 and 1000.
- **Audit.** `requested_by` is already recorded. Show it in History.
- **Roles.** Sending stays on `isAdminRole()`. To let an editor send, set
  `app_users.role = 'admin'` for them. A later version may add a `publisher`
  role; not now.

## 7. App side (not the API developer's work, listed for completeness)

`src/services/notificationRouting.ts` handles `type: 'news_article'`. Two
additions for `kind=message` targets:
- `type: 'screen'` with `screen` in `news | exclusive | journal | subscribe |
  events | about`, navigating to that tab or stack route.
- `type: 'url'`, opening the URL in the in-app browser.
Until a build with this ships, a `message` broadcast that targets a screen or
URL still arrives and shows; a tap opens the app on the News tab. So the
console can launch before the app change.

## 8. Not in scope

A Send-push button inside the WordPress editor (phase two, calls 3.2 with a
server-side key). Any third-party push product. Per-topic or per-region
targeting. Localisation of notification text.

## 9. Done when

1. An editor with `role='admin'` can sign in on `/admin/notifications` with
   their Google or Microsoft account; a `user` role sees the no-rights notice.
2. News tab lists the latest 30 articles with Sent badges; *Send to me* lands
   on the editor's phone and opens the article; *Send to everyone* asks for
   confirmation, sends, and appears in History with counts that update as
   receipts come in.
3. Message tab: a message with a Journal target reaches an iOS and an Android
   device; audience *subscribers* reports a smaller count than *all* and only
   subscribers receive it.
4. A message scheduled five minutes ahead shows as `scheduled`, can be
   cancelled, and if not cancelled sends within 30 seconds of its time.
5. A second send of the same article returns 409 and the page says so.
6. The fourth broadcast in a day triggers the cap prompt.
7. `POST /v1/notifications/article` still works unchanged.

Estimated effort: three working days including the migration and tests.
