export const MAX_MERMAID_SOURCE_LENGTH = 20_000;
export const MAX_MERMAID_EDGES = 500;

export type MermaidThemeMode = "light" | "dark";

export class MermaidSourceTooLargeError extends Error {
  constructor() {
    super("Mermaid source exceeds the renderer limit");
    this.name = "MermaidSourceTooLargeError";
  }
}

let renderQueue: Promise<void> = Promise.resolve();

/** Mermaid configuration is global, so theme-specific renders must not overlap. */
function enqueueRender<T>(render: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(render, render);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function isClosedFencedCodeBlock(raw: string): boolean {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*$/.exec(lines[0] ?? "");
  if (!opening) return false;

  const marker = opening[1][0];
  const minimumLength = opening[1].length;
  let lastContentLine = lines.length - 1;
  while (lastContentLine >= 0 && !lines[lastContentLine].trim()) {
    lastContentLine -= 1;
  }
  if (lastContentLine <= 0) return false;

  const closing = new RegExp(
    `^ {0,3}${marker === "`" ? "`" : "~"}{${minimumLength},}[ \\t]*$`,
  );
  return closing.test(lines[lastContentLine]);
}

export async function renderMermaidSvg({
  id,
  source,
  theme,
}: {
  id: string;
  source: string;
  theme: MermaidThemeMode;
}): Promise<string> {
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
    throw new MermaidSourceTooLargeError();
  }

  return enqueueRender(async () => {
    const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([
      import("mermaid"),
      import("dompurify"),
    ]);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "htmlLabels",
        "theme",
        "themeVariables",
        "themeCSS",
        "fontFamily",
        "suppressErrorRendering",
      ],
      suppressErrorRendering: true,
      maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
      maxEdges: MAX_MERMAID_EDGES,
      htmlLabels: false,
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "var(--font-sans)",
      deterministicIds: true,
      deterministicIDSeed: id,
      logLevel: "fatal",
    });

    const { svg } = await mermaid.render(id, source);
    const sanitized = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: [
        "a",
        "audio",
        "embed",
        "foreignObject",
        "iframe",
        "image",
        "object",
        "script",
        "video",
      ],
      FORBID_ATTR: ["href", "target", "xlink:href"],
      ALLOW_DATA_ATTR: false,
    });
    const output = String(sanitized).trim();
    if (!/^<svg(?:\s|>)/i.test(output)) {
      throw new Error("Mermaid did not produce a safe SVG root");
    }
    return output;
  });
}
