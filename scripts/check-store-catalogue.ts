import assert from "node:assert/strict";
import {
  matchesStoreProduct,
  planCodeForStoreProduct,
  storeCatalogue,
} from "../src/lib/storeCatalogue.js";

for (const entry of storeCatalogue) {
  assert.equal(planCodeForStoreProduct(entry.legacy), entry.code);
  assert.equal(planCodeForStoreProduct(entry.productId), entry.code);
  for (const configured of [entry.legacy, entry.productId]) {
    for (const received of [entry.legacy, entry.productId]) {
      assert.equal(matchesStoreProduct(entry.code, configured, received), true);
    }
    for (const other of storeCatalogue.filter(
      (item) => item.code !== entry.code,
    )) {
      assert.equal(
        matchesStoreProduct(entry.code, configured, other.productId),
        false,
      );
      assert.equal(
        matchesStoreProduct(entry.code, configured, other.legacy),
        false,
      );
    }
  }
  assert.equal(matchesStoreProduct(entry.code, null, entry.legacy), false);
  assert.equal(
    matchesStoreProduct(entry.code, "unrelated", entry.legacy),
    false,
  );
}
assert.equal(planCodeForStoreProduct("test_ibsi_premium_monthly"), null);
assert.equal(planCodeForStoreProduct("ibsi_journal_india_monthly_extra"), null);
assert.equal(matchesStoreProduct("custom", "custom_sku", "custom_sku"), true);
console.log("Store catalogue migration checks passed.");
