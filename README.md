# IBS Intelligence News API

TypeScript/Express backend for the IBS Intelligence React Native/Expo app. PostgreSQL stores application users, subscriptions, entitlements, monthly article access, push tokens, reading history, and saved articles. WordPress remains the source of news content; this API stores WordPress news article IDs as text.

For the current complete endpoint, environment, deployment, testing, and troubleshooting reference, see [API_DOCUMENTATION.md](API_DOCUMENTATION.md).

## Requirements

- Node.js 20+
- PostgreSQL 14+
- Firebase project and service-account credentials
- Razorpay account, plans, API keys, and webhook secret
- HTTPS reverse proxy in production (for example, Nginx, Cloudflare, or a managed host)

## Local setup

```bash
npm install
copy .env.example .env
npm run migrate
npm run dev
```

Edit `.env` before migrating. `FIREBASE_PRIVATE_KEY` may contain escaped `\n` newlines. Never commit `.env`.

The default API URL is `http://localhost:3000`. Check it with:

```bash
curl http://localhost:3000/health
```

## Database and plans

Migrations are SQL files in `migrations/` and are tracked in `schema_migrations`. Add a Razorpay plan to both Razorpay and the local database (amount is in the currency's smallest unit, such as paise):

```sql
INSERT INTO subscription_plans
  (code, name, razorpay_plan_id, price_amount, currency, "interval", status)
VALUES
  ('premium_monthly', 'Premium Monthly', 'plan_REPLACE_ME', 49900, 'INR', 'monthly', 'active');
```

The backend returns the public Razorpay `key_id` for checkout. It never returns `key_secret`.

## Firebase authentication

The app obtains an ID token from Firebase Auth and sends it on private requests:

```text
Authorization: Bearer FIREBASE_ID_TOKEN
```

After first sign-in, call `POST /v1/auth/sync-user`. Other private endpoints require the synced application user.

Firebase owns passwords and identity-provider credentials; they are never sent to or stored by this API. In the Expo app, register or sign in with the Firebase client SDK, retrieve the ID token, then synchronize the backend profile:

```ts
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";

// Registration
const registration = await createUserWithEmailAndPassword(auth, email, password);
const registrationToken = await registration.user.getIdToken();
await fetch(`${API_URL}/v1/auth/sync-user`, {
  method: "POST",
  headers: { Authorization: `Bearer ${registrationToken}` }
});

// Login
const login = await signInWithEmailAndPassword(auth, email, password);
const token = await login.user.getIdToken();
await fetch(`${API_URL}/v1/auth/sync-user`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` }
});
```

Use `GET /v1/auth/me` to restore the application profile. `POST /v1/auth/logout` performs no server-side token revocation; the app must call Firebase `signOut(auth)` and clear locally cached sensitive data. Use `POST /v1/auth/logout-all` only when the user explicitly chooses to sign out on every device. Private API verification checks token revocation.

Password reset and email verification use Firebase client functions such as `sendPasswordResetEmail` and `sendEmailVerification`. Google and Apple sign-in also use their Firebase Auth providers; once Firebase returns an ID token, the same `/v1/auth/sync-user` call applies.

`DELETE /v1/auth/me` with `{ "confirmation": "DELETE" }` permanently deletes the Firebase identity and cascades application data. To prevent continued external billing, deletion is rejected while a subscription is active; the user must cancel it first.

## Staff roles

`app_users.role` is one of `user`, `employee`, `admin`, or `super_admin`. The
three staff roles all receive **unlimited access**: they bypass the five-article
monthly meter and receive premium podcasts and videos without a subscription.

Roles are assigned **manually via SQL only**. There is no self-service path, no
API endpoint, and no automatic grant from email domain, so every new account
starts as `user` and stays there until someone changes it. Signing in again does
not reset an assigned role.

The user must have signed in at least once (so `/v1/auth/sync-user` has created
their row) before they can be promoted.

```sql
-- Grant access
UPDATE app_users SET role = 'employee',   updated_at = now() WHERE email = 'person@ibsintelligence.com';
UPDATE app_users SET role = 'admin',      updated_at = now() WHERE email = 'lead@ibsintelligence.com';
UPDATE app_users SET role = 'super_admin', updated_at = now() WHERE email = 'owner@ibsintelligence.com';

-- Promote several people at once
UPDATE app_users SET role = 'employee', updated_at = now()
WHERE email IN ('a@ibsintelligence.com', 'b@ibsintelligence.com');

-- Revoke access (for example when someone leaves)
UPDATE app_users SET role = 'user', updated_at = now() WHERE email = 'leaver@ibsintelligence.com';

-- Review who currently holds elevated access
SELECT email, display_name, role, updated_at FROM app_users WHERE role <> 'user' ORDER BY role, email;
```

Staff access is derived from the role and is not stored in `entitlements`, so it
cannot expire or be affected by billing. `GET /v1/entitlements/me` reports it as
a synthetic entitlement with `source: "staff"` and also returns the caller's
`role`, so clients need no special handling. The app shows an "Employee access"
badge on the Menu screen.

Changes take effect on the user's next request; no sign-out is required.

## Free article allowance

Each installation/account can open five unique articles per calendar month in the `Asia/Kolkata` timezone. Reopening an already-counted article does not consume another view. When a user authenticates, the current installation's allowance is merged into the account so reinstalling or switching devices cannot reset it.

Before displaying full article content, call `POST /v1/news/access`. Anonymous requests must include an app-generated UUID stored in secure device storage. Authenticated requests include the same installation ID plus the Firebase bearer token:

```bash
curl -X POST http://localhost:3000/v1/news/access \
  -H "Content-Type: application/json" \
  -d '{"news_article_id":"12345","installation_id":"7d84c40c-cf72-4b5e-9db5-eb0923a84680"}'
```

The first five unique articles return HTTP `200`. A new article after the limit returns HTTP `402` with `requires_authentication` and `requires_subscription`. The app should then show only the WordPress title, featured image, and excerpt with its sign-in/subscribe prompt. Active entitlements bypass this limit.

## Podcasts and videos

The app cannot call WordPress directly, so this API proxies the `podcasts` and
`videos` custom post types from `WORDPRESS_BASE_URL` and re-serves them in the
shape the app expects:

```text
GET /v1/podcasts?page=1&limit=50
GET /v1/videos?page=1&limit=50
```

Authentication is optional. Both are premium content: metadata is always
returned so the app can render a locked preview, but `audio_url` (podcasts) and
`youtube_id` (videos) are `null` unless the caller has an active entitlement.

Podcast audio is derived from the Buzzsprout player script embedded in the post
content. Video YouTube IDs are not present in the REST payload — they live in
hidden oEmbed post meta — so each video's permalink is fetched once and cached
for 24 hours per revision. Listings are cached for `MEDIA_CACHE_TTL_SECONDS`.

Cloudflare in front of `ibsintelligence.com` rejects clients it classifies as
bots with an empty `403`, regardless of user agent. If this server is affected,
either allowlist its egress IP or ask for a Cloudflare WAF "Skip" rule matching
a secret header and set `WORDPRESS_BYPASS_HEADER` and `WORDPRESS_BYPASS_VALUE`.
When WordPress is unreachable both endpoints return `502 WORDPRESS_UNAVAILABLE`
and the app falls back to its public sources.

```bash
curl "http://localhost:3000/v1/podcasts?page=1&limit=2"
curl "http://localhost:3000/v1/videos?page=1&limit=2" -H "Authorization: Bearer $TOKEN"
```

## IBSi journals

Journal PDFs are read from the private directory configured by
`JOURNAL_STORAGE_DIR` (by default `C:\\ibsi-pdfs\\ibs-journal`). Store only the
PDF filename in `pv_ibsi_journal_data.redirect_page`; never expose or store the
physical server path in API responses. The directory must not be served as a
public static folder.

Journal cover filenames from `image_path` are resolved against
`JOURNAL_IMAGE_BASE_URL`. List responses include both the original `image_path`
and the complete `image_url` for direct use by the mobile app.

Authenticated users with an active entitlement (and staff users) can list
journals and request a reusable signed viewing link:

```text
GET  /v1/journals?page=1&limit=20&year=2026&edition_type=Global%20Edition
POST /v1/journals/{journal_id}/view-link
```

The second endpoint returns `view_url`, `expires_at`, and `expires_in_seconds`.
The default lifetime is one hour. Open `view_url` directly in the iOS or Android
PDF viewer; it does not require an Authorization header and supports HTTP byte
ranges. The URL is a bearer credential until it expires, so do not persist or
share it. Application access logging is disabled for the viewing route; configure
the reverse proxy/CDN not to log `/v1/journals/view/*` URLs either. Set
`JOURNAL_SIGNING_SECRET` to an environment-specific random value
of at least 32 characters and rotate it to invalidate every outstanding link.

## IBSi white papers

White papers follow the journal model. Access is premium throughout: listing
and viewing both require an authenticated user with an active entitlement (or a
staff role), so nothing is visible without a subscription.

The one behavioural difference from journals is that **only rows the CMS has
marked live are published**. The filter is `lower(btrim(live_status)) = 'live'`,
so a paper with `live_status` unset is not listed and cannot be opened. Legacy
rows in `db_white_paper_data` predate that column and hold `NULL`; backfill them
to `Live` to publish them.

Every PDF sits directly in `WHITEPAPER_STORAGE_DIR`, one flat directory
regardless of category. The website keeps them in per-category folders; this
API does not copy that, so `category` is a listing facet only and never reaches
the filesystem. That is deliberate — deriving a folder from the stored category
is the bug in the website's `whitepaper.jsp`, where
`?category=../research-reports` escapes into the paid reports.

Store only the PDF filename in `redirect_page`; never a path. Cover filenames
from `image_path` resolve against `WHITEPAPER_IMAGE_BASE_URL`, and list
responses carry both `image_path` and the complete `image_url`. Titles and
teasers are returned with HTML entities decoded and line breaks folded away,
because the CMS text contains both.

```text
GET  /v1/whitepapers?page=1&limit=20&year=2026&category=Core%20Banking&search=islamic
POST /v1/whitepapers/{whitepaper_id}/view-link
```

`whitepaper_id` is `sr_no`. The second endpoint returns `view_url`,
`expires_at`, and `expires_in_seconds`, on the same terms as journals: reusable
for one hour, no Authorization header, byte-range capable, and a bearer
credential until it expires. Application access logging is disabled for
`/v1/whitepapers/view/*`; configure the reverse proxy not to log it either. Set
`WHITEPAPER_SIGNING_SECRET` to at least 32 random characters, distinct from
`JOURNAL_SIGNING_SECRET` so the two can be rotated independently.

## Subscription providers

Plans and entitlements use a shared provider model for `apple`, `google_play`, and `razorpay`. The included monthly and yearly plans are initially `draft` until their store/Razorpay product IDs are configured. Base prices are ₹99 monthly and ₹400 yearly, plus 18% GST where applicable. Cancellation retains access through the already-paid period, and both products are recurring subscriptions with no free trial.

## Razorpay webhook

Configure Razorpay to send webhooks to:

```text
https://YOUR_API_HOST/v1/webhooks/razorpay
```

Subscribe to `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.paused`, `subscription.resumed`, `subscription.completed`, and `payment.failed`. Set the same secret in Razorpay and `RAZORPAY_WEBHOOK_SECRET`. Signatures are checked against the untouched request body. Event IDs (or a body hash fallback) make delivery idempotent.

## Example requests

Replace `$TOKEN`, `$PLAN_ID`, and `$ARTICLE_ID` as appropriate.

```bash
# Synchronize Firebase user
curl -X POST http://localhost:3000/v1/auth/sync-user \
  -H "Authorization: Bearer $TOKEN"

# Public plans
curl http://localhost:3000/v1/subscription/plans

# Create a Razorpay subscription
curl -X POST http://localhost:3000/v1/subscription/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan_id":"'$PLAN_ID'"}'

# Status and entitlements
curl http://localhost:3000/v1/subscription/status -H "Authorization: Bearer $TOKEN"
curl http://localhost:3000/v1/entitlements/me -H "Authorization: Bearer $TOKEN"

# Cancel at the end of the current billing cycle
curl -X POST http://localhost:3000/v1/subscription/cancel \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cancel_at_cycle_end":true}'

# Register an FCM token
curl -X POST http://localhost:3000/v1/push-token \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fcm_token":"YOUR_LONG_FCM_TOKEN","platform":"android","device_id":"device-1"}'

# Record and list reading history
curl -X POST http://localhost:3000/v1/news/reading-history \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"news_article_id":"'$ARTICLE_ID'"}'
curl "http://localhost:3000/v1/news/reading-history?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"

# Save, list, and remove an article
curl -X POST http://localhost:3000/v1/news/saved-articles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"news_article_id":"'$ARTICLE_ID'"}'
curl "http://localhost:3000/v1/news/saved-articles?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
curl -X DELETE "http://localhost:3000/v1/news/saved-articles/$ARTICLE_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## Production deployment

1. Provision PostgreSQL and set `DATABASE_URL` with a restricted application database user.
2. Store all environment values in the deployment platform's secret manager.
3. Run `npm ci`, `npm run build`, and `npm run migrate` during deployment.
4. Start with `npm start` behind an HTTPS load balancer or reverse proxy.
5. Set `CORS_ORIGINS` to allowed web origins. Native mobile requests generally have no browser origin.
6. Configure health monitoring against `/health` and Razorpay webhook retries/alerts.

## Scripts

- `npm run dev` — development server with reload
- `npm run build` — compile TypeScript into `dist/`
- `npm start` — run compiled server
- `npm run migrate` — apply pending SQL migrations

## API behavior

Successful list responses include `items` and pagination metadata. Errors use `{ "error": { "code", "message" } }`. Input is validated with Zod, SQL uses parameters, private routes verify Firebase ID tokens, headers containing credentials are redacted from logs, and general request rate limiting is enabled.
