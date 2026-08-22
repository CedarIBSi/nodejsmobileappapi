import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { entitlementRouter } from "./routes/entitlements.js";
import { healthRouter } from "./routes/health.js";
import { podcastRouter, videoRouter } from "./routes/media.js";
import { newsRouter } from "./routes/news.js";
import { journalRouter } from "./routes/journals.js";
import { whitepaperRouter } from "./routes/whitepapers.js";
import { pushTokenRouter } from "./routes/push-tokens.js";
import { subscriptionRouter } from "./routes/subscriptions.js";
import { webhookRouter } from "./routes/webhooks.js";
import { errorHandler, notFound } from "./middleware/error-handler.js";

export function createApp() {
  const app = express();
  const env = config();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(pinoHttp({
    level: env.LOG_LEVEL,
    redact: ["req.headers.authorization", "req.headers.x-razorpay-signature"],
    // Journal and white paper view URLs contain a temporary bearer credential
    // in the path. Avoid writing it to application access logs.
    autoLogging: {
      ignore: (req) =>
        (req.url?.startsWith("/v1/journals/view/") ||
          req.url?.startsWith("/v1/whitepapers/view/")) ?? false
    }
  }));
  app.use(helmet());
  const origins = env.CORS_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : true, credentials: true }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));

  // Signature verification requires the exact bytes received from Razorpay.
  app.use("/v1/webhooks", express.raw({ type: "application/json", limit: "1mb" }), webhookRouter);
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.json({
      service: "IBS Intelligence News API",
      status: "ok",
      health: "/health",
      version: "v1"
    });
  });
  // Firebase email-link authentication returns here after unwrapping the link.
  // Hand the complete callback URL to the installed mobile app so its Firebase
  // client can call signInWithEmailLink with the original parameters intact.
  app.get("/app-auth", (req, res) => {
    const suppliedLink = typeof req.query.link === "string" ? req.query.link : undefined;
    let fullLink: string;

    if (suppliedLink) {
      // Only Firebase Hosting action links are accepted as nested sign-in links.
      const parsed = new URL(suppliedLink);
      const expectedHost = env.FIREBASE_AUTH_DOMAIN;
      const validFirebaseHost = expectedHost
        ? parsed.hostname === expectedHost
        : parsed.hostname.endsWith(".firebaseapp.com");
      if (parsed.protocol !== "https:" || !validFirebaseHost || parsed.pathname !== "/__/auth/action") {
        res.status(400).json({ error: { code: "INVALID_AUTH_LINK", message: "Invalid Firebase authentication link" } });
        return;
      }
      fullLink = parsed.toString();
    } else {
      // Retain the complete HTTPS callback when Firebase forwards action
      // parameters directly instead of wrapping them in `link`.
      fullLink = new URL(req.originalUrl, env.APP_BASE_URL).toString();
    }

    const appUrl = `${env.MOBILE_APP_SCHEME}://app-auth?link=${encodeURIComponent(fullLink)}`;
    res.redirect(302, appUrl);
  });
  app.use("/health", healthRouter);
  app.use("/v1/auth", authRouter);
  app.use("/v1/subscription", subscriptionRouter);
  app.use("/v1/entitlements", entitlementRouter);
  app.use("/v1/push-token", pushTokenRouter);
  app.use("/v1/news", newsRouter);
  app.use("/v1/journals", journalRouter);
  app.use("/v1/whitepapers", whitepaperRouter);
  app.use("/v1/podcasts", podcastRouter);
  app.use("/v1/videos", videoRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
