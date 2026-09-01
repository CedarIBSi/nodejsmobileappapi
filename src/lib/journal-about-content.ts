import { htmlToPlainText, toText } from "../services/wordpress.js";

export type JournalAboutFeature = { body: string; title: string };
export type JournalAboutEdition = {
  body: string;
  features: JournalAboutFeature[];
  title: string;
};

/**
 * "About the Journal" and "Why IBSi FinTech Journal" live only in the page's
 * PHP template (globalibsintelligence.com/journal/ and
 * .../ibsi-india-fintech-journal/), not in the REST `content` field - same
 * situation as the Galaxy page's feature accordion (see
 * src/lib/galaxy-content.ts). Scraped from the rendered page between these
 * markers; degrades to empty rather than failing the seed if the template
 * changes.
 */
const aboutHeading = "About the Journal";
const accordionBodyStart = '<div class="accordion-body">';
const accordionItemMarker = '<div class="accordion-item">';
const featureItemPattern =
  /<div class="jurTtlCon">\s*<p class="jtcTtl">([\s\S]*?)<\/p>\s*<p>([\s\S]*?)<\/p>\s*<\/div>/g;

export function parseJournalAboutBody(pageHtml: string): string {
  const headingIndex = pageHtml.indexOf(aboutHeading);
  if (headingIndex === -1) return "";

  const bodyStart = pageHtml.indexOf(accordionBodyStart, headingIndex);
  if (bodyStart === -1) return "";

  const sectionEnd = pageHtml.indexOf(accordionItemMarker, bodyStart);
  const section =
    sectionEnd === -1
      ? pageHtml.slice(bodyStart + accordionBodyStart.length)
      : pageHtml.slice(bodyStart + accordionBodyStart.length, sectionEnd);

  return htmlToPlainText(section);
}

export function parseJournalWhyFeatures(pageHtml: string): JournalAboutFeature[] {
  return Array.from(pageHtml.matchAll(featureItemPattern)).map((match) => ({
    body: toText(match[2]),
    title: toText(match[1])
  }));
}

export function parseJournalAboutEdition(pageHtml: string): JournalAboutEdition {
  return {
    body: parseJournalAboutBody(pageHtml),
    features: parseJournalWhyFeatures(pageHtml),
    title: "About the Journal"
  };
}
