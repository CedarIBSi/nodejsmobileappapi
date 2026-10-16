import { query } from "../db/pool.js";
import { config } from "../config.js";
import { getPerspectiveArticleContent } from "./wordpress.js";

export const homePerspectiveArticleId = "perspective:1";

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

  return {
    article_id: homePerspectiveArticleId,
    image_url: new URL("/v1/home/perspective/image", config().APP_BASE_URL).toString(),
    link: row.link,
    title: row.title,
    updated_at: row.updated_at.toISOString()
  };
}

export type HomePerspectiveArticle = {
  author_name: string | null;
  author_role: string | null;
  body: string;
  body_html: string | null;
  id: string;
  image_url: string;
  link: string;
  title: string;
};

export async function getHomePerspectiveArticle(): Promise<HomePerspectiveArticle | null> {
  const perspective = await getHomePerspective();
  if (!perspective) return null;
  const content = await getPerspectiveArticleContent(perspective.link);
  if (!content?.text) return null;

  return {
    author_name: content.author_name,
    author_role: null,
    body: content.text,
    body_html: content.html,
    id: homePerspectiveArticleId,
    image_url: perspective.image_url,
    link: content.link,
    title: content.title || perspective.title
  };
}

export async function getHomePerspectiveSourceImageUrl(): Promise<string | null> {
  const result = await query<{ image_url: string }>(
    `SELECT image_url FROM home_perspective
     WHERE id = 1 AND is_active = true AND image_url <> ''
       AND (ends_at IS NULL OR ends_at > now())`
  );
  return result.rows[0]?.image_url ?? null;
}
