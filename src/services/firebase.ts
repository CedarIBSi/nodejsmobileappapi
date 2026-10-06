import fs from "node:fs";
import path from "node:path";
import { applicationDefault, cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { config } from "../config.js";

export function firebaseAuth() {
  if (!getApps().length) {
    const env = config();
    const configuredFile = env.FIREBASE_SERVICE_ACCOUNT_FILE.trim();
    const firebaseDir = path.resolve(process.cwd(), "firebase");
    const discoveredFile = fs.existsSync(firebaseDir)
      ? fs.readdirSync(firebaseDir).find((name) => name.endsWith(".json"))
      : undefined;
    const serviceAccountFile = configuredFile
      ? path.resolve(process.cwd(), configuredFile)
      : discoveredFile
        ? path.join(firebaseDir, discoveredFile)
        : undefined;

    const credential = serviceAccountFile
      ? cert(JSON.parse(fs.readFileSync(serviceAccountFile, "utf8")) as ServiceAccount)
      : env.FIREBASE_PROJECT_ID && env.FIREBASE_PROJECT_ID !== "pending-configuration"
        ? cert({
            projectId: env.FIREBASE_PROJECT_ID,
            clientEmail: env.FIREBASE_CLIENT_EMAIL,
            privateKey: env.FIREBASE_PRIVATE_KEY
          })
        : applicationDefault();

    initializeApp({
      credential
    });
  }
  return getAuth();
}

export type FirebaseWebConfig = {
  apiKey: string;
  appId: string;
  authDomain?: string;
  projectId: string;
};

let webConfigPromise: Promise<FirebaseWebConfig> | undefined;

/**
 * Firebase Web identifiers are public, but keeping the API key out of Git
 * avoids secret-scanner noise and lets Firebase remain the source of truth.
 * The Admin credential already used for token verification reads the web app
 * configuration once; the promise is cached for the process lifetime.
 */
export function firebaseWebConfig(): Promise<FirebaseWebConfig> {
  if (webConfigPromise) return webConfigPromise;
  webConfigPromise = (async () => {
    firebaseAuth();
    const env = config();
    if (env.FIREBASE_WEB_API_KEY && env.FIREBASE_WEB_APP_ID) {
      return {
        apiKey: env.FIREBASE_WEB_API_KEY,
        appId: env.FIREBASE_WEB_APP_ID,
        authDomain: env.FIREBASE_AUTH_DOMAIN,
        projectId: env.FIREBASE_PROJECT_ID
      };
    }

    const credential = getApps()[0]?.options.credential;
    if (!credential) throw new Error("Firebase Admin credential is unavailable");
    const access = await credential.getAccessToken();
    const headers = { Authorization: `Bearer ${access.access_token}` };
    const project = encodeURIComponent(env.FIREBASE_PROJECT_ID);
    const appsResponse = await fetch(`https://firebase.googleapis.com/v1beta1/projects/${project}/webApps`, {
      headers,
      signal: AbortSignal.timeout(10_000)
    });
    if (!appsResponse.ok) throw new Error(`Firebase web-app lookup failed with HTTP ${appsResponse.status}`);
    const apps = await appsResponse.json() as { apps?: Array<{ name: string }> };
    const app = apps.apps?.[0];
    if (!app) throw new Error("Firebase project has no registered web app");
    const configResponse = await fetch(`https://firebase.googleapis.com/v1beta1/${app.name}/config`, {
      headers,
      signal: AbortSignal.timeout(10_000)
    });
    if (!configResponse.ok) throw new Error(`Firebase web config lookup failed with HTTP ${configResponse.status}`);
    const web = await configResponse.json() as { apiKey?: string; appId?: string };
    if (!web.apiKey || !web.appId) throw new Error("Firebase web configuration is incomplete");
    return {
      apiKey: web.apiKey,
      appId: web.appId,
      authDomain: env.FIREBASE_AUTH_DOMAIN,
      projectId: env.FIREBASE_PROJECT_ID
    };
  })().catch((error) => {
    webConfigPromise = undefined;
    throw error;
  });
  return webConfigPromise;
}
