/**
 * Installed system font families for the Settings font picker.
 *
 * Implemented with platform tooling only (no native modules) so the main
 * process bundles cleanly:
 *   - macOS: `osascript` JXA bridging `CTFontManagerCopyAvailableFontFamilyNames`
 *     (the same CoreText query font_kit's `all_families()` uses, so it is fast
 *     and returns canonical CSS family names); `system_profiler` is kept as a
 *     slow fallback when osascript is unavailable
 *   - Windows: PowerShell `[Windows.Media.Fonts]::SystemFontFamilies`
 *   - Linux: `fc-list` family output
 * The Windows and Linux approaches mirror the MIT-licensed `font-list`
 * package (https://github.com/oldj/font-list). Callers cache the result.
 */
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

async function darwinFontFamilies(): Promise<string[]> {
  // CoreText family enumeration via the JXA ObjC bridge completes in tens of
  // milliseconds, where system_profiler takes seconds on the same machine.
  const script = [
    'ObjC.import("CoreText")',
    "const cf = $.CTFontManagerCopyAvailableFontFamilyNames()",
    "const ns = ObjC.castRefToObject(cf)",
    'ObjC.deepUnwrap(ns).join("\\n")',
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
    );
    const names = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (names.length > 0) return names;
  } catch {
    // Fall through to the system_profiler fallback below.
  }
  const { stdout } = await execFileAsync(
    "system_profiler",
    ["SPFontsDataType", "-json"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as {
    SPFontsDataType?: Array<{ typefaces?: Array<{ family?: string }> }>;
  };
  const families = new Set<string>();
  for (const item of data.SPFontsDataType ?? []) {
    for (const typeface of item.typefaces ?? []) {
      const family = typeface.family?.trim();
      if (family) families.add(family);
    }
  }
  return [...families];
}

async function win32FontFamilies(): Promise<string[]> {
  const command =
    "chcp 65001|powershell -NoProfile -Command \"chcp 65001|Out-Null;Add-Type -AssemblyName PresentationCore;$families=[Windows.Media.Fonts]::SystemFontFamilies;foreach($family in $families){$name='';if(!$family.FamilyNames.TryGetValue([Windows.Markup.XmlLanguage]::GetLanguage('zh-cn'),[ref]$name)){$name=$family.FamilyNames[[Windows.Markup.XmlLanguage]::GetLanguage('en-us')]}echo $name}\"";
  const { stdout } = await execAsync(command, {
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function linuxFontFamilies(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "fc-list",
    ["-f", "%{family[0]}\n"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Installed system font families, deduplicated and sorted. */
export async function listInstalledFonts(): Promise<string[]> {
  let families: string[];
  switch (process.platform) {
    case "darwin":
      families = await darwinFontFamilies();
      break;
    case "win32":
      families = await win32FontFamilies();
      break;
    case "linux":
      families = await linuxFontFamilies();
      break;
    default:
      families = [];
  }
  return [...new Set(families)]
    .map((family) => family.trim())
    // Hidden/system-reserved families (".Apple Color Emoji UI", ".Al Bayan PUA")
    // are not meaningful choices for a UI font.
    .map((family) => family.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ""))
    .filter((family) => family.length > 0 && !family.startsWith("."))
    .sort((a, b) => a.localeCompare(b));
}
