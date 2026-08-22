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
