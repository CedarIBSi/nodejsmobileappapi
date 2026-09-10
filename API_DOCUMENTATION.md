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
| `402` | Subscription or free-article limit required |
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

Public. Returns active monthly/yearly plans and their Apple/Google product IDs. Money is stored in the currency's smallest unit.

#### `GET /v1/subscription/status` — Private

Returns the newest subscription and whether it currently has an active entitlement.

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

The API never trusts a client-supplied status. It fetches the canonical purchase state from Google or Apple, upserts the subscription, and reconciles premium entitlement. `active`, `trialing`, and `in_grace_period` grant access.

#### `GET /v1/entitlements/me` — Private

Returns active entitlements and the caller's role. `employee`, `admin`, and `super_admin` receive a synthetic staff entitlement and unlimited access.

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

#### `GET /v1/news`

Public. Query: `page`, `limit`, optional numeric `category`.

```text
GET /v1/news?page=1&limit=20&category=12
```

Returns `{ articles, pagination }`. Cached publicly for 300 seconds.

#### `GET /v1/news/categories`

Public. Returns `{ categories }`, cached for 300 seconds.

#### `GET /v1/news/articles/:news_article_id`

Public article body lookup. Returns `{ article: { id, body } }`.

#### `POST /v1/news/access`

Optional Firebase token. Anonymous callers must supply a persistent installation UUID:

```json
{
  "news_article_id": "12345",
  "installation_id": "7d84c40c-cf72-4b5e-9db5-eb0923a84680"
}
```

Users receive five unique free articles per calendar month in `Asia/Kolkata`. Reopening an article does not consume another view. When a caller signs in, the current installation's usage is merged into the account. Premium and staff users bypass the meter.

Successful/denied shape:

```json
{
  "access": {
    "allowed": true,
    "reason": "free",
    "remaining_free_articles": 4,
    "period_timezone": "Asia/Kolkata",
    "requires_authentication": false,
    "requires_subscription": false
  }
}
```

The sixth new free article returns `402`.

#### Reading history — Private

- `POST /v1/news/reading-history` with `{ "news_article_id": "12345" }`
- `GET /v1/news/reading-history?page=1&limit=20`

#### Saved articles — Private

- `POST /v1/news/saved-articles` with `{ "news_article_id": "12345" }`
- `GET /v1/news/saved-articles?page=1&limit=20`
- `DELETE /v1/news/saved-articles/:news_article_id`

### Podcasts and videos

#### `GET /v1/podcasts`

Optional Firebase token; query `page` and `limit`. Metadata is public. `audio_url` is `null` without premium/staff access.

#### `GET /v1/videos`

Optional Firebase token; query `page` and `limit`. Metadata is public. `youtube_id` is `null` without premium/staff access.

### Journals

#### `GET /v1/journals/about`

Public marketing/about content; cached for 300 seconds.

#### `GET /v1/journals` — Private + premium/staff

Query: `page`, `limit`, optional `year`, `edition_type`, and `search`. PDF filenames are never returned.

#### `POST /v1/journals/:journal_id/view-link` — Private + premium/staff

Returns a signed, expiring `view_url`. Response must not be cached.

#### `GET /v1/journals/view/:token`

Serves the PDF inline. Supports `Range: bytes=...`, returning `206` or `416`. The signed path is excluded from access logs.

### White papers

#### `GET /v1/whitepapers` — Private + premium/staff

Query: `page`, `limit`, optional `year`, `category`, and `search`. Only rows with `live_status = Live` and a PDF filename are listed.

#### `POST /v1/whitepapers/:whitepaper_id/view-link` — Private + premium/staff

Returns a signed, expiring `view_url`.

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
- `subscription_plans`: price, interval, Apple and Google product IDs
- `subscriptions`: provider purchase state and billing periods
- `entitlements`: normalized premium access grants
- `store_events`: idempotent Google/Apple webhook records
- `news_article_access`: anonymous/account monthly meter
- `news_reading_history`: per-user reading history
- `saved_news_articles`: per-user bookmarks
- `push_tokens`: Expo device tokens
- `pv_ibsi_journal_data`: journal metadata and private PDF filename
- `db_white_paper_data`: white-paper metadata and private PDF filename
- `galaxy_page_content`, journal-about, awards, and house-ad tables: seeded content

All current migrations `001` through `011` must be present in `schema_migrations`.

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
