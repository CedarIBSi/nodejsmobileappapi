import type { PoolClient } from "pg";
import type { StoreProvider } from "./subscriptionReconcile.js";

export type StoreTransactionInput = {
  currency: string | null;
  environment: "sandbox" | "production";
  grossAmountMicros: bigint | null;
  proceedsAmountMicros: bigint | null;
  productId: string | null;
  provider: StoreProvider;
  providerTransactionId: string;
  purchasedAt: Date | null;
  rawSummary: unknown;
  refundAmountMicros: bigint | null;
  storeUpdatedAt: Date | null;
  subscriptionId: string;
  taxAmountMicros: bigint | null;
  transactionKind: "charge" | "refund";
  userId: string;
};

/**
 * Upserts the latest verified store snapshot. Store notification retries and
 * the app's restore pass are therefore harmless and never double-count money.
 */
export async function recordStoreTransaction(client: PoolClient, input: StoreTransactionInput): Promise<void> {
  await client.query(
    `INSERT INTO subscription_transactions
       (subscription_id, user_id, provider, provider_transaction_id, product_id, environment,
        transaction_kind, currency, gross_amount_micros, refund_amount_micros,
        proceeds_amount_micros, tax_amount_micros, purchased_at, store_updated_at, raw_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     ON CONFLICT (provider, provider_transaction_id) DO UPDATE SET
       subscription_id = EXCLUDED.subscription_id,
       user_id = EXCLUDED.user_id,
       product_id = COALESCE(EXCLUDED.product_id, subscription_transactions.product_id),
       environment = EXCLUDED.environment,
       transaction_kind = EXCLUDED.transaction_kind,
       currency = COALESCE(EXCLUDED.currency, subscription_transactions.currency),
       gross_amount_micros = COALESCE(EXCLUDED.gross_amount_micros, subscription_transactions.gross_amount_micros),
       refund_amount_micros = COALESCE(EXCLUDED.refund_amount_micros, subscription_transactions.refund_amount_micros),
       proceeds_amount_micros = COALESCE(EXCLUDED.proceeds_amount_micros, subscription_transactions.proceeds_amount_micros),
       tax_amount_micros = COALESCE(EXCLUDED.tax_amount_micros, subscription_transactions.tax_amount_micros),
       purchased_at = COALESCE(EXCLUDED.purchased_at, subscription_transactions.purchased_at),
       store_updated_at = COALESCE(EXCLUDED.store_updated_at, subscription_transactions.store_updated_at),
       raw_summary = EXCLUDED.raw_summary,
       updated_at = now()`,
    [
      input.subscriptionId, input.userId, input.provider, input.providerTransactionId,
      input.productId, input.environment, input.transactionKind, input.currency,
      input.grossAmountMicros?.toString() ?? null, input.refundAmountMicros?.toString() ?? null,
      input.proceedsAmountMicros?.toString() ?? null, input.taxAmountMicros?.toString() ?? null,
      input.purchasedAt, input.storeUpdatedAt, JSON.stringify(input.rawSummary)
    ]
  );
}
