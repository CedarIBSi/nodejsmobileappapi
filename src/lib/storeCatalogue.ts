/** Exact aliases keep pre-cutover receipts and renewals tied to the same plan. */
export const storeCatalogue = [
  {
    code: "journal_india_monthly",
    legacy: "test_ibsi_journal_india_monthly",
    productId: "ibsi_journal_india_monthly",
    name: "IBSi FinTech Journal India Edition - Monthly",
  },
  {
    code: "journal_india_yearly",
    legacy: "test_ibsi_journal_india_yearly",
    productId: "ibsi_journal_india_yearly",
    name: "IBSi FinTech Journal India Edition - Yearly",
  },
  {
    code: "journal_global_monthly",
    legacy: "test_ibsi_journal_global_monthly",
    productId: "ibsi_journal_global_monthly",
    name: "IBSi FinTech Journal Global Edition - Monthly",
  },
  {
    code: "journal_global_yearly",
    legacy: "test_ibsi_journal_global_yearly",
    productId: "ibsi_journal_global_yearly",
    name: "IBSi FinTech Journal Global Edition - Yearly",
  },
  {
    code: "journal_all_monthly",
    legacy: "test_ibsi_journal_all_monthly",
    productId: "ibsi_journal_global_india_monthly",
    name: "IBSi FinTech Journal Global + India Edition - Monthly",
  },
  {
    code: "journal_all_yearly",
    legacy: "test_ibsi_journal_all_yearly",
    productId: "ibsi_journal_global_india_yearly",
    name: "IBSi FinTech Journal Global + India Edition - Yearly",
  },
] as const;

export function planCodeForStoreProduct(productId: string): string | null {
  return (
    storeCatalogue.find(
      (entry) => entry.productId === productId || entry.legacy === productId,
    )?.code ?? null
  );
}

export function matchesStoreProduct(
  planCode: string,
  configuredId: string | null,
  productId: string,
): boolean {
  if (configuredId === productId) return true;
  return storeCatalogue.some(
    (entry) =>
      entry.code === planCode &&
      (configuredId === entry.productId || configuredId === entry.legacy) &&
      (productId === entry.productId || productId === entry.legacy),
  );
}
