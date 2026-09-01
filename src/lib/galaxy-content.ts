import { decodeEntities, htmlToPlainText, toText } from "../services/wordpress.js";

export type GalaxyFeature = { bullets: string[]; image: string | null; title: string };
export type GalaxyContent = { body: string; features: GalaxyFeature[]; title: string };

/**
 * Like toText, but keeps <strong>/<b> emphasis as `**marked**` text instead
 * of dropping it, so the app can render it bold. Other tags (the site wraps
 * bullets in a stray <span> and occasional <u>) are stripped like toText.
 */
function toInlineMarkdown(html = ""): string {
  return decodeEntities(
    html
      .replace(/<(?:strong|b)[^>]*>/gi, "**")
      .replace(/<\/(?:strong|b)>/gi, "**")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/\s+/g, " ")
    .trim();
}

type WordPressPageFields = {
  content?: { rendered?: string };
  title?: { rendered?: string };
};

/** Reads the lead copy out of the WordPress REST response for the page. */
export function parseGalaxyIntro(page: WordPressPageFields): { body: string; title: string } {
  return {
    body: htmlToPlainText(page.content?.rendered) || "",
    title: toText(page.title?.rendered) || "IBSi Galaxy"
  };
}

/**
 * The "Features and data" accordion lives only in the page's PHP template
 * (`templateIbsiGalaxy.php`), not in the REST `content` field or any ACF
 * field - there is no JSON source for it, so it is scraped from the rendered
 * page between these two markers. Coupled to that template on purpose: if it
 * changes, this degrades to an empty list rather than failing the seed.
 */
const galaxyFeaturesSectionStart = "Features and data</h3>";
const galaxyFeaturesSectionEnd = '<div class="col-md-12" style="display: none">';
const accordionItemMarker = '<div class="accordion-item">';

export function parseGalaxyFeatures(pageHtml: string): GalaxyFeature[] {
  const startIndex = pageHtml.indexOf(galaxyFeaturesSectionStart);
  if (startIndex === -1) return [];

  const endIndex = pageHtml.indexOf(galaxyFeaturesSectionEnd, startIndex);
  const section = endIndex === -1 ? pageHtml.slice(startIndex) : pageHtml.slice(startIndex, endIndex);

  return section
    .split(accordionItemMarker)
    .slice(1)
    .map((chunk): GalaxyFeature => {
      const title = toText(/class="accordion-button[^>]*>([\s\S]*?)<\/button>/.exec(chunk)?.[1]);
      const image =
        /class="galaxyFeature"[\s\S]*?<img[^>]*\bsrc="([^"]+)"/.exec(chunk)?.[1] ?? null;
      const bullets = Array.from(chunk.matchAll(/<li>([\s\S]*?)<\/li>/g))
        .map((match) => toInlineMarkdown(match[1]))
        // Drops filler like "Much more…." - not worth a bullet of its own.
        .filter((bullet) => bullet && !/^much more/i.test(bullet));
      return { bullets, image, title };
    })
    .filter((feature) => feature.title && feature.bullets.length > 0);
}
