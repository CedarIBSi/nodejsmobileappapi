import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { listLatestJournals } from "../services/journalLatest.js";
import { type HomeFeaturedItem, listHomeFeatured } from "../services/wordpress.js";

export const homeRouter = Router();

/**
 * The Journal's card in the carousel: the newest issue, Global first because
 * it is the edition most readers can buy. No editorial pick exists for the
 * Journal, so "featured" here means "latest". The card is omitted when the
 * lookup fails, since the WordPress cards are still worth showing.
 */
async function journalFeaturedCard(): Promise<HomeFeaturedItem | null> {
  try {
    const issues = await listLatestJournals();
    const issue = issues.find((item) => item.edition === "global") ?? issues[0];
    if (!issue) return null;
    return {
      content_id: issue.journal_id,
      content_type: "journal",
      edition: issue.edition,
      excerpt: [issue.month, issue.year].filter(Boolean).join(" ") || null,
      image_url: issue.image_url,
      link: "",
      published_at: issue.published_date,
      title: issue.title ?? ""
    };
  } catch {
    return null;
  }
}

/** Public Home content; the server cache protects WordPress and the edge. */
homeRouter.get("/featured", asyncHandler(async (_req, res) => {
  const [items, journal] = await Promise.all([listHomeFeatured(), journalFeaturedCard()]);
  // Blogs, interviews, case studies, then the Journal, then news: the order
  // the design asks for, with news last since it has its own tab.
  const newsIndex = items.findIndex((item) => item.content_type === "news");
  const ordered = newsIndex === -1 ? [...items] : [...items.slice(0, newsIndex), ...items.slice(newsIndex + 1)];
  if (journal) ordered.push(journal);
  if (newsIndex !== -1) ordered.push(items[newsIndex]!);
  res.set("Cache-Control", "public, max-age=300");
  res.json({ items: ordered });
}));
