import { query } from "../db/pool.js";
import { newsSlugFromLink, resolveNewsArticleIdFromLink } from "./wordpress.js";

export type HomePerspective = {
  article_id: string | null;
  image_url: string;
  link: string;
  title: string;
  updated_at: string;
};

type HomePerspectiveRow = {
  article_id: string | null;
  image_url: string;
  link: string;
  title: string;
  updated_at: Date;
};

/**
 * The editorial Perspective block on the home feed.
 *
 * Kept as one editable row because this is curated content, not a chronological
 * list. Updating this row changes the app block without shipping a new build.
 */
export async function getHomePerspective(): Promise<HomePerspective | null> {
  const result = await query<HomePerspectiveRow>(
    `SELECT article_id, title, image_url, link, updated_at FROM home_perspective
     WHERE id = 1
       AND is_active = true
       AND title <> ''
       AND image_url <> ''
       AND link <> ''
       AND (ends_at IS NULL OR ends_at > now())`
  );

  const row = result.rows[0];

  if (!row) return null;

  const articleId =
    row.article_id ?? (await resolveNewsArticleIdFromLink(row.link).catch(() => null)) ?? fallbackArticleId(row.link);

  return {
    article_id: articleId,
    image_url: row.image_url,
    link: row.link,
    title: row.title,
    updated_at: row.updated_at.toISOString()
  };
}

function fallbackArticleId(link: string): string | null {
  const slug = newsSlugFromLink(link);
  return slug ? `slug:${slug}` : null;
}
