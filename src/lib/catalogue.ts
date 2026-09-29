/**
 * What the app sells, and what each purchase unlocks.
 *
 * Three products, each sold monthly and yearly (six plan rows, six store
 * products): the IBSi FinTech Journal India edition, the Global edition, and
 * both together. Every product also includes unlimited Insights - the tab
 * the free-read meter sits on - so no plan exists that a reader could buy and
 * still be metered.
 *
 * A plan row names its product in `subscription_plans.product_code`; this
 * module turns that into the entitlement rows a purchase grants and the
 * journal editions those rows open. Kept in code rather than a table because
 * the mapping is the product definition, and a definition that can drift in
 * data is one nobody notices drifting.
 */
export const productCodes = ["journal_india", "journal_global", "journal_all"] as const;
export type ProductCode = (typeof productCodes)[number];

export const journalEditions = ["india", "global"] as const;
export type JournalEdition = (typeof journalEditions)[number];

/**
 * The rows written to `entitlements.entitlement_type`. 'insights' is on every
 * product; the journal ones follow the product. The retired 'premium_news'
 * type, which used to stand for everything, was split into these three by
 * migration 030.
 */
export const entitlementTypes = ["insights", "journal_india", "journal_global"] as const;
export type EntitlementType = (typeof entitlementTypes)[number];

type Product = {
  name: string;
  editions: readonly JournalEdition[];
  entitlements: readonly EntitlementType[];
};

export const products: Record<ProductCode, Product> = {
  journal_india: {
    name: "IBSi FinTech Journal India",
    editions: ["india"],
    entitlements: ["insights", "journal_india"]
  },
  journal_global: {
    name: "IBSi FinTech Journal Global",
    editions: ["global"],
    entitlements: ["insights", "journal_global"]
  },
  journal_all: {
    name: "IBSi FinTech Journal India + Global",
    editions: ["india", "global"],
    entitlements: ["insights", "journal_india", "journal_global"]
  }
};

export function isProductCode(value: unknown): value is ProductCode {
  return typeof value === "string" && (productCodes as readonly string[]).includes(value);
}

/** The entitlement that opens one journal edition. */
export function journalEntitlement(edition: JournalEdition): EntitlementType {
  return edition === "india" ? "journal_india" : "journal_global";
}

/**
 * Which edition a journal issue belongs to, from the free-text
 * `pv_ibsi_journal_data.edition_type` the CMS stores ("India Edition",
 * "Global Edition"). Matched by word rather than exact string because the
 * column is typed by hand. Null for an issue that names neither - such an
 * issue is treated as open to any journal subscriber, since withholding it on
 * a blank field would take content from someone who paid.
 */
export function journalEditionOf(editionType: string | null | undefined): JournalEdition | null {
  const value = editionType?.toLowerCase() ?? "";
  if (/\bindia\b/.test(value)) return "india";
  if (/\bglobal\b/.test(value)) return "global";
  return null;
}
