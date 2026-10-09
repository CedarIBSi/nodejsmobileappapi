# IBS Intelligence News API

Complete operational and endpoint documentation for the TypeScript/Express backend used by the IBS Intelligence mobile application.

## 1. Service overview

- Production/development base URL: `https://dev.ibsintelligence.com`
- Local base URL: `http://127.0.0.1:3000`
- API version prefix: `/v1`
- Runtime: Node.js 20 or newer
- Framework: Express 5 with TypeScript
- Database: PostgreSQL 14 or newer
- Authentication: Firebase ID tokens
- Android subscriptions: Google Play Billing
- iOS subscriptions: Apple StoreKit/App Store Server API
- News/media source: WordPress REST API
- PDF delivery: private local storage with signed URLs and byte-range support

There is no `/research` endpoint. Unknown paths return `404 NOT_FOUND`.

## 2. Quick health tests

From the server:

```powershell
curl.exe http://127.0.0.1:3000/
curl.exe http://127.0.0.1:3000/health
```

From another computer or a phone using mobile data:

```text
https://dev.ibsintelligence.com/
https://dev.ibsintelligence.com/health
```

Successful health response:

```json
{
  "status": "ok",
  "database": "ok",
  "timestamp": "2026-08-31T00:00:00.000Z"
}
```

`503` with `database: "unavailable"` means Express is running but PostgreSQL is unavailable.

## 3. Installation and operation

```powershell
npm install
npm run migrate
npm run build
npm start
```

Development mode:

```powershell
npm run dev
```

Available scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run TypeScript with file watching |
| `npm run build` | Compile `src` into `dist` |
| `npm start` | Run `dist/server.js` |
| `npm run migrate` | Apply unapplied SQL migrations |
| `npm run seed:galaxy` | Load Galaxy page content |
| `npm run seed:journal-about` | Load journal marketing content |
| `npm run seed:awards` | Load awards content |
| `npm run seed:events` | Load the Cedar-IBSi events programme from `seed-data/events.json` |

The deployed process must start with the project configuration available at `.env`. Restart the process after changing `.env`; Firebase Admin and other clients are cached in memory.

## 4. Environment variables

Never commit `.env`, Firebase JSON keys, Google private keys, or Apple private keys.

### Core

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `test`, or `production`; default `development` |
| `PORT` | No | HTTP listening port; default `3000` |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DATABASE_SSL` | No | `true` or `false`; default `false` |
| `APP_BASE_URL` | Yes | Public HTTPS origin used when creating signed links |
| `MOBILE_APP_SCHEME` | No | Mobile deep-link scheme; default `ibsintelligence` |
| `CORS_ORIGINS` | No | Comma-separated browser origins; blank permits dynamic origins |
| `LOG_LEVEL` | No | Pino log level; default `info` |

### Firebase

| Variable | Required | Description |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Yes | Must match the mobile Firebase project |
| `FIREBASE_AUTH_DOMAIN` | No | Allowed Firebase Hosting host for email-link callbacks |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | Recommended | Relative or absolute path to the Admin service-account JSON |
| `FIREBASE_CLIENT_EMAIL` | Schema-required | Inline credential fallback when no JSON file is selected |
| `FIREBASE_PRIVATE_KEY` | Schema-required | Inline credential fallback; escaped `\n` is converted to newlines |

The configured project is currently `ibsi-fintech-news`. The Android application's `google-services.json` must come from the same project. A token issued by another Firebase project cannot be verified here.

### Google Play

| Variable | Required for Android purchases | Description |
| --- | --- | --- |
| `GOOGLE_PLAY_PACKAGE_NAME` | Yes | Android package, currently `com.ibsintelligence.news` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Yes | Service account with Android Publisher API access |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Yes | Corresponding private key |
| `GOOGLE_PUBSUB_AUDIENCE` | Yes for RTDN | Expected OIDC audience for Pub/Sub pushes |
| `GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL` | Recommended for RTDN | Restricts pushes to the expected Pub/Sub identity |

### Expo push notifications

| Variable | Required | Description |
| --- | --- | --- |
| `EXPO_ACCESS_TOKEN` | Recommended | EAS enhanced push-security token; store in Key Vault |
| `EXPO_PUSH_BATCH_INTERVAL_MS` | No | Delay between 100-device batches; default `250` |
| `EXPO_RECEIPT_DELAY_SECONDS` | No | Delay before checking delivery receipts; default `900` |

### Apple

| Variable | Required for iOS purchases | Description |
| --- | --- | --- |
| `APPLE_ISSUER_ID` | Yes | App Store Connect issuer ID |
| `APPLE_KEY_ID` | Yes | App Store Connect API key ID |
| `APPLE_PRIVATE_KEY` | Yes | App Store Connect `.p8` private key contents |
| `APPLE_BUNDLE_ID` | Yes | iOS bundle identifier |
| `APPLE_APP_APPLE_ID` | Required by some production verification paths | Numeric App Apple ID |
| `APPLE_ENVIRONMENT` | No | `Sandbox` or `Production`; default `Sandbox` |
| `APPLE_ROOT_CERTS_DIR` | Yes for signed payloads | Directory containing Apple's `.cer` root certificates |

### WordPress and media

| Variable | Required | Description |
| --- | --- | --- |
| `WORDPRESS_BASE_URL` | No | Default `https://ibsintelligence.com` |
| `WORDPRESS_USER_AGENT` | No | Browser-like default is supplied |
| `WORDPRESS_BYPASS_HEADER` | Environment-specific | Secret Cloudflare WAF bypass header name |
| `WORDPRESS_BYPASS_VALUE` | Environment-specific | Matching secret value |
| `WORDPRESS_TIMEOUT_MS` | No | Upstream timeout; default `15000` |
| `MEDIA_CACHE_TTL_SECONDS` | No | In-memory podcast/video cache; default `900` |
| `MEDIA_CACHE_MAX_ENTRIES` | No | Maximum process-local WordPress cache entries; default `500` |
| `NEWS_WINDOW_MONTHS` | No | News lookback window; default `6` |
| `NEWS_TOPIC_COUNT` | No | Maximum category count; default `12` |

Cloudflare currently returns `403` to WordPress calls from this server. Until the source IP is allowlisted or a matching WAF bypass header is configured, news, categories, podcasts, and videos return `502 WORDPRESS_UNAVAILABLE`.

### Journals and white papers

| Variable | Required | Description |
| --- | --- | --- |
| `JOURNAL_STORAGE_DIR` | No | Default `C:\\ibsi-pdfs\\ibs-journal` |
| `JOURNAL_IMAGE_BASE_URL` | No | Public journal cover base URL |
| `JOURNAL_SIGNING_SECRET` | For view links | At least 32 characters |
| `JOURNAL_URL_TTL_SECONDS` | No | 60–86400; default `3600` |
| `WHITEPAPER_STORAGE_DIR` | No | Default `C:\\ibsi-pdfs\\ibs-whitepaper` |
| `WHITEPAPER_IMAGE_BASE_URL` | No | Public white-paper cover base URL |
| `WHITEPAPER_SIGNING_SECRET` | For view links | At least 32 characters and distinct from journal secret |
| `WHITEPAPER_URL_TTL_SECONDS` | No | 60–86400; default `3600` |

The two storage defaults are Windows paths for local development only. The
Azure App Service is Linux and sets `JOURNAL_STORAGE_DIR=/mounts/pdf-previews/journals`
and `WHITEPAPER_STORAGE_DIR=/mounts/pdf-previews/whitepapers`, pointing at the
`pdf-previews` blob container mounted into the app. See the README for why, and
for what to recreate if the App Service is ever rebuilt.

The current API has removed Razorpay create/cancel and webhook flows. Mobile purchases use Google Play and Apple, and `.env.example` contains only the current configuration names and safe placeholders.

## 5. Authentication

Private endpoints require a current Firebase ID token:

```http
Authorization: Bearer FIREBASE_ID_TOKEN
```

Authentication sequence:

1. The mobile app signs in with Firebase.
2. It calls Firebase `getIdToken()`.
3. It calls `POST /v1/auth/sync-user` with that bearer token.
4. The backend verifies the token, including revocation status, and creates or updates `app_users`.
   A verified normalized email can belong to only one Firebase UID. A second
   UID receives `409 EMAIL_ALREADY_LINKED`; providers must be linked through
   Firebase rather than silently transferring the API account.
5. The same bearer token is used for private endpoints.

Because revocation checking contacts Firebase, the server clock must be synchronized. Windows Time should be running and automatic:

```powershell
Get-Service W32Time
w32tm /query /status
```

If valid users receive `Invalid or expired Firebase token`, verify:

- Mobile and backend project IDs match.
- The configured service-account JSON belongs to that project.
- Windows Time is synchronized.
- The backend was restarted after configuration changes.
- The app signed out and back in to obtain a fresh token.

## 6. Common API behavior

### Pagination

Paginated endpoints accept:

- `page`: integer, minimum `1`, default `1`
- `limit`: integer, `1`–`100`, default `20`

Response metadata:

```json
{
  "page": 1,
  "limit": 20,
  "total": 100,
  "total_pages": 5
}
```

### Errors

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": {}
  }
}
```

Internal `5xx` details are logged but returned as `Internal server error`.

Common status codes:

| Status | Meaning |
| --- | --- |
| `200` | Successful read/update |
| `201` | Resource created |
| `204` | Successful operation with no body |
| `206` | Partial PDF response |
| `400` | Invalid body/query/path parameter |
| `401` | Missing, invalid, expired, or revoked token |
| `402` | Subscription required, or the free Insights allowance is spent |
| `403` | Authenticated but not authorized |
| `404` | Resource, synced user, or endpoint not found |
| `409` | Account cannot be deleted while subscription is active |
| `416` | Invalid PDF byte range |
| `429` | Rate limit exceeded |
| `500` | Unexpected server or content configuration error |
| `502` | WordPress unavailable |
| `503` | Dependency/integration not configured or database unavailable |

Global request limit: 120 requests per minute per client IP.

## 7. Endpoint reference

### Service

#### `GET /`

Public service identification.

#### `GET /health`

Public database readiness check.

#### `GET /app-auth`

Firebase email-link callback. Accepts a Firebase Hosting action URL in `link` or direct Firebase query parameters, validates the host/path, then redirects to `ibsintelligence://app-auth?...` (or the configured scheme).

### Authentication

#### `POST /v1/auth/sync-user` — Firebase token required

Creates or updates the local profile using verified Firebase claims.

```bash
curl -X POST "https://dev.ibsintelligence.com/v1/auth/sync-user" \
  -H "Authorization: Bearer $TOKEN"
```

Response:

```json
{
  "user": {
    "id": "uuid",
    "firebase_uid": "firebase-uid",
    "email": "user@example.com",
    "display_name": "Example User",
    "phone": null,
    "role": "user",
    "created_at": "...",
    "updated_at": "..."
  }
}
```

#### `GET /v1/auth/me` — Private

Returns the current application profile.

#### `POST /v1/auth/logout` — Private

Returns `204`. The app must also call Firebase `signOut()` locally.

#### `POST /v1/auth/logout-all` — Private

Revokes Firebase refresh tokens for every device. Returns `204`.

#### `DELETE /v1/auth/me` — Private

Body:

```json
{ "confirmation": "DELETE" }
```

Deletes Firebase identity and cascades local user data. Rejected while a subscription has an active-like state.

### Subscription and entitlement

#### `GET /v1/subscription/plans`

Public. Returns the active plans, ordered by product then interval. Three products, each sold monthly and yearly (see `src/lib/catalogue.ts`):

| `product_code` | Grants |
|---|---|
| `journal_india` | Unlimited Insights + the IBSi FinTech Journal India edition |
| `journal_global` | Unlimited Insights + the Global edition |
| `journal_all` | Unlimited Insights + both editions |

Each plan carries `id`, `code`, `name`, `product_code`, `product_name`, `editions[]`, `interval`, `apple_product_id`, `google_product_id`, and a reference `price_amount` the app never displays (the store quotes the real price). The store product ids are `test_ibsi_journal_{india|global|all}_{monthly|yearly}` on both stores for now; a follow-up migration swaps in the final `ibsi_journal_*` ids once the real products are approved (product ids are permanent, so the test ones are throwaways).

#### `GET /v1/subscription/status` — Private

Returns the newest subscription (with its plan's `product_code`) and whether it currently has an active entitlement.

#### `POST /v1/subscription/verify-purchase` — Private

Android body:

```json
{
  "platform": "android",
  "plan_id": "plan-uuid",
  "product_id": "test_premium_monthly_01",
  "purchase_token": "GOOGLE_PLAY_PURCHASE_TOKEN"
}
```

iOS body:

```json
{
  "platform": "ios",
  "plan_id": "plan-uuid",
  "product_id": "APPLE_PRODUCT_ID",
  "transaction_id": "APPLE_TRANSACTION_ID"
}
```

The API never trusts a client-supplied status. It fetches the canonical purchase state from Google or Apple, upserts the subscription, and writes one `entitlements` row per type the plan's product grants (`insights`, `journal_india`, `journal_global`), closing any type the product does not include. `active`, `trialing`, and `in_grace_period` grant access. Webhooks and the lapsed-subscription refresh re-resolve the plan from the product id the store reports, so a plan change made in the store's own UI is reconciled too.

After migration `036_subscription_transaction_ledger.sql`, verified Apple transactions and Google Play orders are also recorded idempotently in `subscription_transactions`. Customer totals come from the signed Apple transaction or Google Orders API, never `subscription_plans.price_amount`. Google order accounting runs after the purchase response and all accounting failures are non-blocking, so reporting cannot delay or deny access. Store webhooks retry the same capture for renewals and refunds. Amounts are stored as integer millionths of a currency unit; sandbox and production are always reported separately.

**Subscription emails** (`src/lib/purchaseEmail.ts`). After the response here, and after each store webhook and lapsed-subscription refresh commits, the API compares the subscription row's plan and status before and after the reconcile and emails the reader in IBSi's own branding at four moments, each once however often the same state is reported: a plan recorded for the first time ("Welcome": what it includes, renewal interval and period end, that the store holds the receipt, how to manage or cancel in that store), a move to another of our plans, a cancellation while the paid period still runs (Google reports this state; Apple does not, so Apple readers get only the next one), and an expiry or refund ("has ended", not sent after a cancellation mail). Renewals and repeat verifications send nothing. Every message names `SUPPORT_EMAIL`; sandbox purchases get a `[Test]` subject and a no-money-taken note. Same SMTP as Express interest; a failure is logged with the subscription id and never affects the purchase or the webhook. Nothing is sent when SMTP is unconfigured or the account has no email.

#### `GET /v1/entitlements/me` — Private

Returns the active entitlement rows, the caller's role, and `access: { insights, journal_editions[] }` — the rows summed up. `employee`, `admin`, and `super_admin` receive synthetic staff rows for every type.

### Webhooks

#### `POST /v1/webhooks/google-play`

Receives Google Play Real-time Developer Notifications through Pub/Sub. Requires a valid Pub/Sub OIDC bearer token. `message.data` is base64-decoded; the purchase is re-fetched from Google before reconciliation. Duplicate Pub/Sub message IDs are idempotent.

#### `POST /v1/webhooks/apple`

Receives App Store Server Notifications V2:

```json
{ "signedPayload": "APPLE_JWS" }
```

The outer notification and nested transaction are cryptographically verified against installed Apple roots. Notification UUIDs provide idempotency.

### News

#### `GET /v1/home/featured`

Public and cached. Returns `items[]` in the stable Home-card shape: `content_type`, `content_id`, `title`, `excerpt`, `image_url`, `published_at`, and `link`. The first version returns at most one item: the newest `ibsi_news` post assigned to the `editor_s_picks` term whose slug is `featured-news`. An absent term or no assigned post returns `{ "items": [] }`, not an error. The source builder accepts multiple post types so Blogs, Leadership Interviews, Case Studies and Videos can be added later without changing this endpoint or its payload.

#### `GET /v1/news`

Public. Query: `page`, `limit`, optional numeric `category`.

```text
GET /v1/news?page=1&limit=20&category=12
```

Returns `{ articles, pagination }`. Cached publicly for 300 seconds.

#### `GET /v1/news/categories`

Public. Returns `{ categories }`, cached for 300 seconds.

#### `GET /v1/news/articles/:news_article_id`

Public article body lookup, cached for 300 seconds. Returns `{ article: { id, body, body_html } }`. News is free: there is no meter on articles. (`POST /v1/news/access` has been removed; the meter now lives on Insights content, below.)

#### Reading history — Private

- `POST /v1/news/reading-history` with `{ "news_article_id": "12345" }`
- `GET /v1/news/reading-history?page=1&limit=20`

#### Saved articles — Private

- `POST /v1/news/saved-articles` with `{ "news_article_id": "12345" }`
- `GET /v1/news/saved-articles?page=1&limit=20`
- `DELETE /v1/news/saved-articles/:news_article_id`

### Insights meter

Analyst opinions, case studies, leadership interviews, podcasts and videos share one free allowance: **five distinct items per calendar month** in `Asia/Kolkata`, counted per signed-in user or, before sign-in, per installation. Reopening an item already read this month is free. When a caller signs in, the installation's reads for the month are merged into the account. Premium and staff users bypass the meter. White papers are not metered: they are free to read, and `whitepaper` is rejected as a `content_type` since 2026-09-30.

Listings for all five types are open to anyone. The thing the allowance buys - an article body, an audio URL, or a YouTube id - is served only after a read has been spent on that item.

#### `POST /v1/insights/access`

Optional Firebase token. Anonymous callers must supply a persistent installation UUID. This is the only call that spends a read; the app makes it before opening an item.

```json
{
  "content_type": "analyst_opinion",
  "content_id": "12345",
  "installation_id": "7d84c40c-cf72-4b5e-9db5-eb0923a84680"
}
```

`content_type` is one of `analyst_opinion`, `case_study`, `leadership_interview`, `podcast`, `video`. Editorial ids may be given as `12345` or `postid-12345`; both count as the same item.

Allowed/denied shape:

```json
{
  "access": {
    "allowed": true,
    "reason": "free",
    "remaining_free_reads": 4,
    "period_timezone": "Asia/Kolkata",
    "requires_authentication": false,
    "requires_subscription": false
  }
}
```

`reason` is `free`, `premium`, or `monthly_limit_reached`. The sixth new item in a month returns `402` with `allowed: false`.

#### Metered content routes

Each of the routes below checks that a read was spent on the item (or that the caller is premium/staff) and otherwise answers `402` with the same `{ access }` envelope. Signed-out callers pass the installation id that spent the read: as `?installation_id=` on a GET, or `{ "installation_id" }` in the body of a POST.

- `GET /v1/analyst-opinions/:opinion_id`
- `GET /v1/case-studies/:case_study_id`
- `GET /v1/leadership-interviews/:interview_id`
- `GET /v1/podcasts/:podcast_id`
- `GET /v1/videos/:video_id`

### Topic filters on every Insights and Exclusive list

`GET /v1/{podcasts,videos,webinars,blogs,case-studies,leadership-interviews}/topics` returns `topics[]` of `{ id, name, count }`: the website's Views topics that actually hold items of that kind, counted, in the site's order. A kind whose post type ignores the category filter returns an empty list, so the app shows no filter there. Cached an hour at the edge, twelve on the server. Each of those listings takes an optional `category=<id>`.

### Podcasts and videos

#### `GET /v1/podcasts`

Optional Firebase token; query `page` and `limit`. Metadata is public; `audio_url` is always `null` on the listing.

#### `GET /v1/podcasts/:podcast_id` — Metered

Returns `{ podcast }` with `audio_url` populated. See the Insights meter above.

#### `GET /v1/videos`

Optional Firebase token; query `page` and `limit`. Metadata is public; `youtube_id` is always `null` on the listing.

#### `GET /v1/videos/:video_id` — Metered

Returns `{ video }` with `youtube_id` resolved. See the Insights meter above.

### Webinars

Free to watch: nothing here is metered or gated. Read from the `webinars` WordPress post type, in the same shape as videos with `is_premium: false`.

#### `GET /v1/webinars`

Optional Firebase token. Query: `page`, `limit`. Rows carry `youtube_id: null`; the detail resolves it.

#### `GET /v1/webinars/:webinar_id`

Optional Firebase token. One webinar with `youtube_id` resolved from its permalink. `404` with `WEBINAR_NOT_FOUND` for an unknown id.

### Blogs

Free to read: nothing here is metered or gated. Read from the `blogs` WordPress post type, in the same article shape the app uses for free editorial content. The listing is limited to posts published in the rolling last six months.

#### `GET /v1/blogs`

Optional Firebase token. Query: `page`, `limit`. Returns only blogs from the rolling last six months as `blogs[]` with `id`, `title`, `excerpt`, `image_url`, `published_at`, and `link`, plus the standard pagination object.

#### `GET /v1/blogs/:blog_id`

Optional Firebase token. Returns the selected blog as `blog`, including `body` (plain text) and `body_html` (rich content). `404` with `BLOG_NOT_FOUND` for an unknown id.

### Case studies

Case Studies are Insights content. The listing is public; the body is metered through the shared Insights meter.

#### `GET /v1/case-studies?page=1&limit=20`

Returns `case_studies[]` with `id`, `title`, `excerpt`, `image_url`, `published_at`, and `link`, plus the standard pagination object.

#### `GET /v1/case-studies/:case_study_id` — Metered

Returns the selected item as `case_study`, including the listing fields and its complete `body` (plain text) and `body_html` (rich content). Both a numeric WordPress ID and the app's `postid-123` form are accepted. `404` with `CASE_STUDY_NOT_FOUND` for an unknown id.

### Express interest

#### `POST /v1/interest` — Private

The "Express interest" button on the app's From IBSi pages. Body: `{ "topic": "IBSi Galaxy", "platform": "android" }`. Records a row in `interest_requests` with the caller's name and email, then emails `INTEREST_TO_EMAIL` (one or more comma- or semicolon-separated recipients; default `amitj@ibsintelligence.com`) over SMTP with the reader's address as reply-to. Returns `201 { "interest": { "id", "emailed": true } }`.

`503 INTEREST_NOT_CONFIGURED` when `SMTP_HOST` / `SMTP_FROM` are unset (the row is still written), `502 INTEREST_EMAIL_FAILED` when the send fails. The app answers both by opening the reader's own mail client with the same details.

Environment: `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` (`false` for STARTTLS), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `INTEREST_TO_EMAIL`. Migration `033_interest_requests.sql`.

### Journals

#### `GET /v1/journals/about`

Public marketing/about content; cached for 300 seconds.

#### `GET /v1/journals` — Private + premium/staff

Query: `page`, `limit`, optional `year`, `edition` (`india` or `global`, matched by the same word rule the locks use), `edition_type` (the exact CMS string), and `search`. PDF filenames are never returned.

`GET /v1/journals/filters` (same access) returns `years[]` and `editions[]` for the archive; with `edition=india|global` the years are that edition's alone.

Each journal carries `locked` and `locked_reason` (`edition` when the issue's
edition is not on the reader's plan, `archive` when it predates a monthly
plan's window, `null` when it opens), and the response carries
`archive: { editions[], full, from_month }`. An issue's edition is read from
its `edition_type` by word ("India", "Global"); one naming neither opens for
any journal subscriber. Yearly subscribers of an edition and staff get
`full: true` and nothing of that edition locked; a monthly subscriber gets
`from_month` (`YYYY-MM`, the month they first subscribed) and
`locked_reason: 'archive'` on every issue published before it. Locked issues
stay in the listing on purpose — they are the upgrade prompt.

The window is `MIN(subscriptions.archive_from_month)` across all of a user's
subscriptions, lapsed ones included, so cancelling and resubscribing keeps the
original window. Access still requires a currently active entitlement.

`archive_from_month` is frozen when the subscription row is first written, as
the earlier of the joining month and the newest issue published by then — so
someone who subscribes before the current month's edition ships still gets the
previous one. It is never recomputed: deriving it live would move the window
forward as new issues publish and re-lock editions already being read. Rows
predating the column fall back to the month of `first_subscribed_at`.

#### `POST /v1/journals/:journal_id/view-link` — Private + premium/staff

Returns a signed, expiring `view_url`. Response must not be cached.

Enforces both locks: an issue of an edition the plan does not include returns
`403` `EDITION_UPGRADE_REQUIRED`, one outside the archive window returns `403`
`ARCHIVE_UPGRADE_REQUIRED` (both distinct from `402` `SUBSCRIPTION_REQUIRED`,
which means no journal subscription at all). This is the authoritative check —
the `locked` flag on the listing is presentation only.

#### `GET /v1/journals/view/:token`

Serves the PDF inline. Supports `Range: bytes=...`, returning `206` or `416`. The signed path is excluded from access logs.

### White papers

#### `GET /v1/whitepapers`

Optional Firebase token. Query: `page`, `limit`, optional `year`, `category`, and `search`. Only rows with `live_status = Live` and a PDF filename are listed.

#### `POST /v1/whitepapers/:whitepaper_id/view-link`

Optional Firebase token. Returns a signed, expiring `view_url`. Free to read: no meter and no entitlement check. A body is accepted and ignored, for app builds that still send `{ "installation_id" }`.

#### `GET /v1/whitepapers/view/:token`

Serves a validated PDF filename from the flat private storage root with byte-range support.

### Static/database-backed content

#### `GET /v1/galaxy`

Public Galaxy page content. Returns `503 GALAXY_NOT_SEEDED` until seeded.

#### `GET /v1/awards`

Public award programs.

#### `GET /v1/events`

The Cedar-IBSi events programme for the app's Events screen, as one payload:
`intro`, `upcoming[]`, `stats[]`, `about`, `series[]`, `videos[]`, `insights[]`.

`upcoming` lists only published events, featured first, and an event drops off
the day after its `starts_on` date - nothing has to be unpublished by hand once
a summit has run. Registration is an email address, not a link: the app never
sends a reader to cedaribsi.events.

Content is curated in `seed-data/events.json` (there is no CMS behind the events
site to read) and loaded with `npm run seed:events`.

#### `GET /v1/ads`

Public active house advertisements.

All four public content endpoints use a 300-second cache window.

### Analyst opinions

Analyst Opinions (the WordPress **IBSi Views** article collection) are
Insights content. The listing is public; the body is metered (see the Insights
meter above).

#### `GET /v1/analyst-opinions/topics`

The live Analyst Opinions topic filter from `/views/`: `topics[]` of `{ id, name }`, in the site's order. `id` is the WordPress category id the listing filters by - the same categories `/v1/news/categories` lists. The API reads and caches the website buttons, so editorial changes do not require a release.

#### `GET /v1/analyst-opinions?page=1&limit=20&category=11384`

Returns `analyst_opinions[]` with `id`, `title`, `excerpt`, `image_url`,
`published_at`, and `link`, plus the standard pagination object. Optional `category` narrows to one topic from `/topics`; an unknown id returns `400 INVALID_INSIGHT_TOPIC`.

#### `GET /v1/analyst-opinions/:opinion_id` — Metered

Returns the selected item as `analyst_opinion`, including the listing fields
and its complete `body` (plain text) and `body_html` (rich content). Both a
numeric WordPress ID and the app's `postid-123` form are accepted.

### Leadership interviews

Leadership Interviews (the WordPress `leadership-interview` post type, listed
on the site at `/leadership-interviews/`) are Insights content served in the
same shape as analyst opinions: public listing, metered body.

#### `GET /v1/leadership-interviews?page=1&limit=20`

Returns `leadership_interviews[]` with `id`, `title`, `excerpt`, `image_url`,
`published_at`, and `link`, plus the standard pagination object.

#### `GET /v1/leadership-interviews/:interview_id` — Metered

Returns the selected item as `leadership_interview`, including the listing
fields and its complete `body` (plain text) and `body_html` (rich content).
Both a numeric WordPress ID and the app's `postid-123` form are accepted.

### Push notifications

#### `POST /v1/push-token` — Private

```json
{
  "expo_push_token": "ExponentPushToken[...]",
  "platform": "android",
  "device_id": "optional-device-id"
}
```

Upserts ownership of the Expo token.

#### `POST /v1/notifications/send` — Admin only

```json
{
  "user_id": "target-user-uuid",
  "title": "Breaking news",
  "body": "A new article is available",
  "data": { "article_id": "12345" }
}
```

Sends to every registered Expo token belonging to the target user.

#### `POST /v1/notifications/article` — Admin only

Broadcasts one editor-selected article to every registered device:

```json
{
  "article_id": "12345",
  "headline": "Optional headline override",
  "summary": "Optional internal/audit summary",
  "image_url": "https://example.com/optional-article-image.jpg"
}
```

The visible title is always `IBS Intelligence`. The backend loads the real
headline and featured image from WordPress; `headline` and `image_url` are
optional overrides.
The app receives `type: news_article`, `article_id`, and the optional
`image_url`, so tapping the notification can open the exact article.

The same article cannot be broadcast twice. Sends use batches of 100, remain
below Expo's 600-notifications-per-second limit, retry temporary failures, and
store Expo tickets for delayed receipt checking. Tokens reported as
`DeviceNotRegistered` are removed automatically.

#### `GET /v1/notifications/article/:broadcastId` — Admin only

Returns the target, accepted, delivered and failed counts for a broadcast.

#### Push notification console — Admin only

`GET /admin/notifications` serves the editorial console. The API reads the
public Firebase Web SDK identifiers through its existing Admin credential and
caches them; `FIREBASE_WEB_API_KEY` and `FIREBASE_WEB_APP_ID` are optional
overrides only. Add `api.ibsintelligence.com` to Firebase Authentication ->
Settings -> Authorised domains. Google and Microsoft sign-in still produce a
Firebase ID token; every API operation verifies it and requires the database
role `admin` or `super_admin`.

Migration `034_push_notification_console.sql` renames
`article_push_broadcasts` to `push_broadcasts` and adds general messages,
audiences, scheduling, and cancellation. Apply it before deploying this API.

- `GET /v1/notifications/articles?limit=30`: recent news with `already_notified`.
- `POST /v1/notifications/preview`: send only to the caller and record nothing.
- `POST /v1/notifications/broadcast`: send or schedule an article/message.
  Requires `confirm: true`; the fourth broadcast in 24 hours also requires
  `confirm_cap: true` after a `429 DAILY_CAP` response.
- `GET /v1/notifications/audience-count?audience=<JSON>`: device and distinct
  user counts for all, platform, subscribers, free users, or one entitlement.
- `GET /v1/notifications/broadcasts?limit=50`: newest-first audit history.
- `DELETE /v1/notifications/broadcasts/:id`: cancel a scheduled row only.

The scheduler polls every 30 seconds. Article payloads are unchanged. Message
payloads target a known screen, a news article, or an HTTPS URL. The legacy
article POST and single-broadcast GET remain available.

The mobile app controls the IBSI notification icon. It must also handle a
notification tap by navigating to the ID provided in `data.article_id`.

## 8. Roles and manual access

Roles are `user`, `employee`, `admin`, and `super_admin`. Staff roles all bypass content metering and subscription requirements.

Grant manual staff access only after the user has signed in and synchronized:

```sql
UPDATE app_users
SET role = 'employee', updated_at = now()
WHERE lower(email) = lower('USER@gmail.com')
RETURNING id, firebase_uid, email, role;
```

Revoke it:

```sql
UPDATE app_users
SET role = 'user', updated_at = now()
WHERE lower(email) = lower('USER@gmail.com');
```

This is safer than inventing a fake store subscription.

## 9. Data model

Principal tables:

- `app_users`: Firebase-to-application profile mapping and role
- `subscription_plans`: product_code, interval, Apple and Google product IDs, reference price
- `subscriptions`: provider purchase state and billing periods
- `subscription_transactions`: store-confirmed customer totals, refunds and available proceeds per transaction/order
- `entitlements`: normalized premium access grants
- `store_events`: idempotent Google/Apple webhook records
- `news_article_access`: anonymous/account monthly meter
- `news_reading_history`: per-user reading history
- `saved_news_articles`: per-user bookmarks
- `push_tokens`: Expo device tokens
- `pv_ibsi_journal_data`: journal metadata and private PDF filename
- `db_white_paper_data`: white-paper metadata and private PDF filename
- `galaxy_page_content`, journal-about, awards, and house-ad tables: seeded content

Every migration present in `migrations/` must also be present in `schema_migrations`; production migrations are applied manually before dependent API code is deployed.

## 10. Security behavior

- Firebase token verification includes revocation checks.
- Authorization headers are redacted from logs.
- Signed PDF bearer tokens in paths are excluded from access logging.
- Helmet security headers are enabled.
- JSON/raw webhook bodies are limited to 1 MB.
- Store purchase status is verified server-to-server.
- Google webhook identity is verified with OIDC.
- Apple notifications and transactions are verified as signed JWS values.
- PDF filenames must be bare `.pdf` names and must resolve directly under their configured roots.
- PDF responses are private and non-cacheable.
- Public content endpoints explicitly allow short edge caching.
- Database operations use parameterized SQL.

## 11. Current deployment status and known issues

As of 2026-08-31:

- Express listens on port `3000`.
- Nginx listens on ports `80` and `443` and proxies HTTPS locally.
- The TLS certificate validates for `dev.ibsintelligence.com`.
- PostgreSQL health is good.
- Firebase Admin credential access is good.
- Windows Time is automatic and synchronized; this was required to fix Firebase profile-sync failures.
- Migrations `001`–`011` are applied.
- Google Play purchase credentials are present.
- Google Pub/Sub audience/sender settings are not complete.
- Apple purchase credentials/root setup is not complete.
- WordPress-backed endpoints return `502` because Cloudflare rejects the backend with `403`.
- `npm run build` currently encounters Windows `EPERM` when overwriting some existing files in `dist`, although `npx tsc -p tsconfig.json --noEmit` passes.
- The project currently has no automated test script.

## 12. External smoke-test checklist

Open these from a phone with Wi-Fi disabled:

1. `https://dev.ibsintelligence.com/`
2. `https://dev.ibsintelligence.com/health`
3. `https://dev.ibsintelligence.com/v1/subscription/plans`
4. `https://dev.ibsintelligence.com/v1/journals/about`
5. `https://dev.ibsintelligence.com/v1/galaxy`
6. `https://dev.ibsintelligence.com/v1/awards`
7. `https://dev.ibsintelligence.com/v1/ads`

Expected current failure tests:

- `/v1/news`: `502` until Cloudflare WordPress access is fixed
- `/v1/news/categories`: `502` for the same reason
- `/v1/podcasts`: `502` for the same reason
- `/v1/videos`: `502` for the same reason
- `/v1/auth/me` without a token: `401`
- `/research`: `404 NOT_FOUND` because it is not an API route
