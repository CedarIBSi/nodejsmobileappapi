import type { RequestHandler } from "express";
import { query } from "../db/pool.js";
import { HttpError } from "../lib/errors.js";
import { asyncHandler } from "../lib/async-handler.js";
import { firebaseAuth } from "../services/firebase.js";

export const verifyFirebaseToken: RequestHandler = asyncHandler(async (req, _res, next) => {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Bearer token required", "UNAUTHORIZED");
  try {
    req.firebaseUser = await firebaseAuth().verifyIdToken(authorization.slice(7), true);
    next();
  } catch (err) {
    req.log.warn({ err }, "Firebase token verification failed");
    throw new HttpError(401, "Invalid or expired Firebase token", "UNAUTHORIZED");
  }
});

export const requireAppUser: RequestHandler = asyncHandler(async (req, _res, next) => {
  if (!req.firebaseUser) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  const result = await query<NonNullable<Express.Request["appUser"]>>(
    `SELECT id, firebase_uid, email, display_name, phone, role
     FROM app_users WHERE firebase_uid = $1`,
    [req.firebaseUser.uid]
  );
  if (!result.rows[0]) throw new HttpError(404, "Call /v1/auth/sync-user first", "USER_NOT_SYNCED");
  req.appUser = result.rows[0];
  next();
});

export const privateRoute = [verifyFirebaseToken, requireAppUser];

export const resolveOptionalUser: RequestHandler = asyncHandler(async (req, _res, next) => {
  const authorization = req.header("authorization");
  if (!authorization) {
    next();
    return;
  }
  if (!authorization.startsWith("Bearer ")) throw new HttpError(401, "Invalid authorization header", "UNAUTHORIZED");
  try {
    req.firebaseUser = await firebaseAuth().verifyIdToken(authorization.slice(7), true);
  } catch (err) {
    req.log.warn({ err }, "Firebase token verification failed");
    throw new HttpError(401, "Invalid or expired Firebase token", "UNAUTHORIZED");
  }
  const result = await query<NonNullable<Express.Request["appUser"]>>(
    `SELECT id, firebase_uid, email, display_name, phone, role FROM app_users WHERE firebase_uid = $1`,
    [req.firebaseUser.uid]
  );
  if (!result.rows[0]) throw new HttpError(404, "Call /v1/auth/sync-user first", "USER_NOT_SYNCED");
  req.appUser = result.rows[0];
  next();
});
