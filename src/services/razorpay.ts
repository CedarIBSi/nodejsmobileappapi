import Razorpay from "razorpay";
import { config } from "../config.js";

let instance: Razorpay | undefined;

export function razorpay(): Razorpay {
  if (!instance) {
    const env = config();
    instance = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  }
  return instance;
}
