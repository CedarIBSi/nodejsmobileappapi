/**
 * The topic filter on the website's Views pages (/views/, /views/webinars/),
 * as the site renders it: one button per tag, in this order, each carrying
 * the WordPress tag id the page then filters by. The app's Analyst Opinions
 * screen offers the same row, so a reader filters the same way in both.
 *
 * Kept here rather than in the app, like news regions: editorial adds a
 * topic by adding a button to the site, and matching it is a one-line
 * change and a deploy rather than a store release.
 *
 * Ids copied from the site's own markup on 2026-10-01 (`attr-tid` on each
 * `.btn-cat`). "Webinars" is left out: on the site it is the tag that
 * marks a post as a webinar, not a subject anyone would filter opinions by.
 */
export type InsightTopic = { id: number; name: string };

export const insightTopics: readonly InsightTopic[] = [
  { id: 11395, name: "Analytics" },
  { id: 11381, name: "Artificial Intelligence" },
  { id: 41779, name: "BankTech" },
  { id: 11383, name: "Big Data" },
  { id: 11385, name: "Blockchain" },
  { id: 11382, name: "Cloud" },
  { id: 11368, name: "Core Banking" },
  { id: 11376, name: "Digital Banking" },
  { id: 16786, name: "IBSi Flagship Events" },
  { id: 19264, name: "IBSi Flagship Offerings" },
  { id: 11374, name: "Islamic Banking" },
  { id: 11379, name: "Lending" },
  { id: 11394, name: "Machine Learning" },
  { id: 11378, name: "Open Banking" },
  { id: 16788, name: "Partner Events Coverage" },
  { id: 11384, name: "Payments" },
  { id: 11377, name: "Platformification" },
  { id: 11373, name: "RegTech" },
  { id: 11372, name: "RiskTech" },
  { id: 11467, name: "Robotic Process Automation" },
  { id: 11397, name: "SaaS" },
  { id: 11369, name: "Transaction Banking" }
];
