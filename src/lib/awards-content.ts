import { htmlToPlainText, toText } from "../services/wordpress.js";

export type AwardProgram = {
  body: string;
  link: string;
  slug: string;
  title: string;
  winnersLink: string | null;
};

type WordPressPageFields = {
  content?: { rendered?: string };
  link?: string;
  title?: { rendered?: string };
};

/**
 * Finds the nearest anchor immediately before the word "winners" - the
 * pattern every announced programme page uses is `<a href="...">Click
 * here</a> to view all winners of...`, so the word sits just *after* the
 * closing tag, not inside the anchor's own text. Run before
 * htmlToPlainText, which strips tags (and the href with them).
 */
const winnersLinkProximityChars = 250;

function extractWinnersLink(html = ""): string | null {
  const winnerIndex = html.search(/winner/i);
  if (winnerIndex === -1) return null;

  const anchorPattern = /<a[^>]+href="([^"]+)"[^>]*>/gi;
  let match: RegExpExecArray | null;
  let nearestHref: string | null = null;
  let nearestIndex = -1;

  while ((match = anchorPattern.exec(html)) !== null) {
    if (match.index > winnerIndex) break;
    nearestHref = match[1] ?? null;
    nearestIndex = match.index;
  }

  return nearestHref && winnerIndex - nearestIndex <= winnersLinkProximityChars ? nearestHref : null;
}

/**
 * Two of the three award-programme pages return real body copy over REST
 * (content.rendered) - parse those directly, same shape as parseGalaxyIntro.
 */
export function parseAwardProgramFromRest(
  page: WordPressPageFields,
  slug: string
): AwardProgram | null {
  if (!page.link) return null;

  const rawContent = page.content?.rendered ?? "";

  return {
    body: htmlToPlainText(rawContent),
    link: page.link,
    slug,
    title: toText(page.title?.rendered) || "IBSi Awards",
    winnersLink: extractWinnersLink(rawContent)
  };
}

/**
 * The Global FinTech Innovation Awards page is built from a custom PHP
 * template (page-template-templateInnovationAwards) - its copy never passes
 * through the_content(), so content.rendered is always empty over REST, same
 * situation as the Galaxy page's feature accordion (see galaxy-content.ts)
 * and the Journal about/why sections (journal-about-content.ts). Scraped
 * from the rendered page instead: the lead copy sits in the first
 * `<div class="mainTitle">...</div>` block, immediately followed by an HTML
 * comment marking the next (currently unused) section. Coupled to this
 * template's markup on purpose - degrades to an empty body rather than
 * failing the seed if the template changes.
 */
const mainTitleStart = '<div class="mainTitle">';
const sectionEndMarker = "<!--";
const headingPattern = /<h3[^>]*>[\s\S]*?<\/h3>/;

export function parseAwardProgramFromHtml(
  pageHtml: string,
  link: string,
  slug: string,
  title: string
): AwardProgram {
  const startIndex = pageHtml.indexOf(mainTitleStart);
  if (startIndex === -1) {
    return { body: "", link, slug, title, winnersLink: null };
  }

  const endIndex = pageHtml.indexOf(sectionEndMarker, startIndex);
  const section = endIndex === -1 ? pageHtml.slice(startIndex) : pageHtml.slice(startIndex, endIndex);
  // The REST title field already carries the heading; drop it here so it
  // doesn't repeat as the first line of body text.
  const withoutHeading = section.replace(headingPattern, "");

  return {
    body: htmlToPlainText(withoutHeading),
    link,
    slug,
    title,
    winnersLink: extractWinnersLink(section)
  };
}

/**
 * The Sales League Table hub page also returns empty REST content - same
 * situation as GFIA above, but built from Bootstrap accordion markup instead
 * (the same component journal-about-content.ts already scrapes for the
 * Journal "About"/"Why" sections, and galaxy-content.ts for the Galaxy
 * feature list). The page's first accordion body is its own lead copy; later
 * ones are an unrelated FAQ section further down the page.
 */
const accordionBodyStart = '<div class="accordion-body">';
const accordionItemMarker = '<div class="accordion-item">';

export function parseAwardProgramFromAccordionHtml(
  pageHtml: string,
  link: string,
  slug: string,
  title: string
): AwardProgram {
  const bodyStart = pageHtml.indexOf(accordionBodyStart);
  if (bodyStart === -1) {
    return { body: "", link, slug, title, winnersLink: null };
  }

  const sectionStart = bodyStart + accordionBodyStart.length;
  const sectionEnd = pageHtml.indexOf(accordionItemMarker, sectionStart);
  const section =
    sectionEnd === -1 ? pageHtml.slice(sectionStart) : pageHtml.slice(sectionStart, sectionEnd);

  return {
    body: htmlToPlainText(section),
    link,
    slug,
    title,
    winnersLink: extractWinnersLink(section)
  };
}
