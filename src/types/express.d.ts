import type { DecodedIdToken } from "firebase-admin/auth";

declare global {
  namespace Express {
    interface Request {
      firebaseUser?: DecodedIdToken;
      appUser?: {
        id: string;
        firebase_uid: string;
        email: string | null;
        display_name: string | null;
        phone: string | null;
        role: string;
      };
    }
  }
}

export {};
