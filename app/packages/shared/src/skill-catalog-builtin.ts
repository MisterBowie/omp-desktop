/**
 * The skill catalog that ships inside the app.
 *
 * Deliberately a small floor, not the shelf: a handful of high-signal,
 * zero-setup skills so the market is useful offline. The main volume comes
 * from configured sources (e.g. GitHub repos auto-scanned for SKILL.md).
 * Documents are served via jsDelivr — raw.githubusercontent.com is
 * TLS-flaky from some networks while the CDN edge reaches them reliably.
 *
 * Names and descriptions are English (ADR 0009). Locale catalogs translate
 * chrome around the market, not these upstream document titles.
 */
import type { SkillCatalogFile } from "./skill-catalog.js";

const ANTHROPIC = "https://cdn.jsdelivr.net/gh/anthropics/skills@main/skills";
const homepageFor = (slug: string) => `https://github.com/anthropics/skills/tree/main/skills/${slug}`;

export const BUILTIN_SKILL_CATALOG: SkillCatalogFile = {
  schemaVersion: 1,
  updatedAt: "2026-09-12",
  source: "builtin",
  skills: [
    {
      id: "docx",
      name: "Word documents",
      description: "Create, read, and edit Word (.docx) files with tracked changes and comments",
      author: "anthropic",
      homepage: homepageFor("docx"),
      url: `${ANTHROPIC}/docx/SKILL.md`,
      categories: ["docs"],
      verified: true,
    },
    {
      id: "pdf",
      name: "PDF files",
      description: "Read, extract, merge, split, and generate PDF files",
      author: "anthropic",
      homepage: homepageFor("pdf"),
      categories: ["docs"],
      verified: true,
      url: `${ANTHROPIC}/pdf/SKILL.md`,
    },
    {
      id: "pptx",
      name: "PowerPoint decks",
      description: "Create, edit, and analyze PowerPoint (.pptx) presentations",
      author: "anthropic",
      homepage: homepageFor("pptx"),
      categories: ["docs"],
      verified: true,
      url: `${ANTHROPIC}/pptx/SKILL.md`,
    },
    {
      id: "xlsx",
      name: "Excel spreadsheets",
      description: "Work with spreadsheets: formulas, charts, pivots, and multiple sheets",
      author: "anthropic",
      homepage: homepageFor("xlsx"),
      categories: ["docs", "data"],
      verified: true,
      url: `${ANTHROPIC}/xlsx/SKILL.md`,
    },
    {
      id: "frontend-design",
      name: "Frontend Design",
      description: "Make distinctive, intentional visual design when building or restyling UI",
      author: "anthropic",
      homepage: homepageFor("frontend-design"),
      categories: ["coding"],
      verified: true,
      url: `${ANTHROPIC}/frontend-design/SKILL.md`,
    },
    {
      id: "webapp-testing",
      name: "Webapp Testing",
      description: "Drive and verify a local web app with Playwright",
      author: "anthropic",
      homepage: homepageFor("webapp-testing"),
      categories: ["coding"],
      verified: true,
      url: `${ANTHROPIC}/webapp-testing/SKILL.md`,
    },
    {
      id: "mcp-builder",
      name: "MCP Builder",
      description: "Create high-quality MCP servers that connect LLMs to tools and data",
      author: "anthropic",
      homepage: homepageFor("mcp-builder"),
      categories: ["coding"],
      verified: true,
      url: `${ANTHROPIC}/mcp-builder/SKILL.md`,
    },
    {
      id: "skill-creator",
      name: "Skill Creator",
      description: "Create new skills, improve existing ones, and measure how well they work",
      author: "anthropic",
      homepage: homepageFor("skill-creator"),
      categories: ["coding", "workflow"],
      verified: true,
      url: `${ANTHROPIC}/skill-creator/SKILL.md`,
    },
  ],
};
