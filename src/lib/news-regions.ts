/**
 * Region is not a taxonomy in WordPress.
 *
 * `ibsi_news` has exactly two taxonomies, `category` and `post_tag`, and the
 * categories are entirely topical - Payments, Core Banking, Lending, all 39 of
 * them. Region exists only as ordinary tags, sharing one flat namespace of
 * ~38,000 terms with every other tag on the site.
 *
 * Those tags are also inconsistent, because nothing ever forced them to agree:
 * "USA" and "America" are the same place under two names, "FinTech USA" is a
 * third, and Middle East / MENA / UAE overlap three ways. A reader should not
 * have to know the site's tagging history to find news about the Gulf, so each
 * region below folds its variants together and the app asks for the region.
 *
 * Kept here rather than in the app on purpose. Editorial invents new tags
 * without warning; when they do, this is a one-line change and a deploy, and
 * every installed app picks it up at once. In the app it would need a store
 * release. And when WordPress eventually grows a real `region` taxonomy, only
 * this file and the two lookups in wordpress.ts change - the app keeps sending
 * `region=apac` and never learns a tag id.
 *
 * Tag ids verified against the live site 2026-09-15. Ordered by how much news
 * each carries, so an unsorted render still leads with the busiest.
 *
 * One caveat worth keeping in view: only about 60% of news carries any region
 * tag at all, and that share has been falling (73% in late 2024, 60% in the
 * most recent quarter). Filtering by region therefore hides a real slice of
 * output, which is why the app treats it as a narrowing and never a default.
 * See docs/data-collection-register.md in the app repo for the measurements.
 */
export type NewsRegion = {
  name: string;
  slug: string;
  /** WordPress tag ids, sent to the REST API comma-separated, which is OR. */
  tagIds: number[];
};

export const newsRegions: NewsRegion[] = [
  { name: "Europe", slug: "europe", tagIds: [11508] },
  { name: "UK", slug: "uk", tagIds: [11406] },
  { name: "North America", slug: "north-america", tagIds: [11416, 11868, 35274] },
  { name: "Asia Pacific", slug: "apac", tagIds: [11864, 37446, 11478, 11673] },
  { name: "India", slug: "india", tagIds: [11404, 26467] },
  { name: "Middle East", slug: "middle-east", tagIds: [11732, 16136, 12428] },
  { name: "Africa", slug: "africa", tagIds: [12849] }
];

export const newsRegionSlugs = newsRegions.map((region) => region.slug) as [
  string,
  ...string[]
];

export function findNewsRegion(slug?: string): NewsRegion | undefined {
  if (!slug) return undefined;
  return newsRegions.find((region) => region.slug === slug);
}

/** The `tags` value WordPress wants: comma-separated ids, matched as OR. */
export function newsRegionTagParam(region: NewsRegion): string {
  return region.tagIds.join(",");
}
