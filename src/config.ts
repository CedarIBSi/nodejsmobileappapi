import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// Resolve from this module instead of process.cwd(). Windows services and
// mapped-drive launchers often start in a system directory, where dotenv's
// default `.env` lookup would silently miss the project's configuration.
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env")
});

const defaultWordPressUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Bind to loopback by default so the API is reachable only through the
  // reverse proxy. Azure App Service/Container Apps must explicitly set
  // HOST=0.0.0.0 because their ingress connects over the container network.
  HOST: z.string().refine((value) => isIP(value) === 4, "HOST must be an IPv4 address").default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default(""),
  DATABASE_SSL: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  PGHOST: z.string().default(""),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGDATABASE: z.string().default(""),
  PGUSER: z.string().default(""),
  PGPASSWORD: z.string().default(""),
  PGSSLMODE: z.enum(["disable", "require", "verify-ca", "verify-full"]).default("disable"),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_AUTH_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/i).optional(),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().min(1),
  FIREBASE_SERVICE_ACCOUNT_FILE: z.string().default(""),
  // Google Play Billing and Apple In-App Purchase verification. Optional at
  // startup, same as the journal/whitepaper signing secrets - the console
  // setup (service account, App Store Connect API key) happens on its own
  // timeline, and these routes fail closed (503) rather than block the rest
  // of the API from starting while that's in progress.
  GOOGLE_PLAY_PACKAGE_NAME: z.string().min(1).optional(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().min(1).optional(),
  // The Pub/Sub push subscription's configured OIDC audience (usually this
  // endpoint's own URL) and the service account it signs push requests with
  // (Play's default notifications publisher unless a custom one was set up)
  // - together these confirm a /v1/webhooks/google-play request really came
  // from Pub/Sub and not an unauthenticated caller.
  GOOGLE_PUBSUB_AUDIENCE: z.string().url().optional(),
  GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  APPLE_ISSUER_ID: z.string().min(1).optional(),
  APPLE_KEY_ID: z.string().min(1).optional(),
  APPLE_PRIVATE_KEY: z.string().min(1).optional(),
  APPLE_BUNDLE_ID: z.string().min(1).optional(),
  APPLE_APP_APPLE_ID: z.coerce.number().int().positive().optional(),
  APPLE_ENVIRONMENT: z.enum(["Sandbox", "Production"]).default("Sandbox"),
  // Root certificates downloaded by hand from https://www.apple.com/certificateauthority/
  // (Apple publishes no API for these). Verification fails closed if this
  // directory is missing or empty rather than skip the check.
  APPLE_ROOT_CERTS_DIR: z.string().min(1).default("C:\\ibsi-pdfs\\apple-root-certs"),
  APP_BASE_URL: z.string().url(),
  MOBILE_APP_SCHEME: z.string().regex(/^[a-z][a-z0-9+.-]*$/i).default("ibsintelligence"),
  CORS_ORIGINS: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),
  WORDPRESS_BASE_URL: z.string().url().default("https://ibsintelligence.com"),
  // Cloudflare in front of ibsintelligence.com rejects non-browser clients with
  // an empty 403, so outbound requests must present a browser user agent until
  // this server's source IP is allowlisted.
  // An empty value in .env must fall back rather than send a blank agent.
  WORDPRESS_USER_AGENT: z
    .string()
    .default(defaultWordPressUserAgent)
    .transform((value) => value.trim() || defaultWordPressUserAgent),
  // Cloudflare classifies Node's TLS fingerprint as a bot regardless of headers,
  // so a header-matched WAF skip rule is the supported way to let this server
  // through without pinning an egress IP. Both values must be set to take effect.
  WORDPRESS_BYPASS_HEADER: z.string().default(""),
  WORDPRESS_BYPASS_VALUE: z.string().default(""),
  WORDPRESS_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  MEDIA_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(900),
  JOURNAL_STORAGE_DIR: z.string().min(1).default("C:\\ibsi-pdfs\\ibs-journal"),
  JOURNAL_IMAGE_BASE_URL: z.string().url().default(
    "https://galaxy.ibsintelligence.com/vision-solution-images/img/journal-img/"
  ),
  // Optional at process startup so non-journal commands remain available while
  // deployment is being configured. Journal link creation fails closed.
  JOURNAL_SIGNING_SECRET: z.string().min(32).optional(),
  JOURNAL_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  // One flat directory for every white paper, whatever its category - the
  // website splits them into per-category folders, but nothing here needs to,
  // and a flat root keeps `category` away from the filesystem entirely.
  WHITEPAPER_STORAGE_DIR: z.string().min(1).default("C:\\ibsi-pdfs\\ibs-whitepaper"),
  WHITEPAPER_IMAGE_BASE_URL: z.string().url().default(
    "https://galaxy.ibsintelligence.com/vision-solution-images/img/whitepaper-img/"
  ),
  // Separate from the journal secret on purpose: rotating one must not
  // invalidate the other's outstanding links. Optional at startup for the same
  // reason as the journal secret - white paper links fail closed without it.
  WHITEPAPER_SIGNING_SECRET: z.string().min(32).optional(),
  WHITEPAPER_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  // Rolling window of recent news exposed by /v1/news.
  NEWS_WINDOW_MONTHS: z.coerce.number().int().positive().default(6),
  NEWS_TOPIC_COUNT: z.coerce.number().int().positive().max(100).default(12)
}).superRefine((value, context) => {
  if (value.DATABASE_URL) return;
  for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"] as const) {
    if (!value[name]) {
      context.addIssue({ code: "custom", path: [name], message: `${name} is required when DATABASE_URL is empty` });
    }
  }
});

export type Config = z.infer<typeof schema>;
let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment variables: ${missing}`);
  }
  cached = {
    ...result.data,
    FIREBASE_PRIVATE_KEY: result.data.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: result.data.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    APPLE_PRIVATE_KEY: result.data.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n")
  };
  return cached;
}
