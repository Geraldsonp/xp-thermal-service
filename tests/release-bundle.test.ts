/**
 * Guards two release-packaging bugs that shipped:
 *  - the WinSW descriptor's <workingdirectory> must be exactly %BASE%
 *    (the pkg build resolves packaged public/ and data/ from that cwd)
 *  - install.ps1 must define $DashboardUrl before using it, from the
 *    port that actually answered /health (never a hardcoded 9100)
 * Reads the tracked source files directly; no build or packaging involved.
 */
import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..");

describe("release bundle sources", () => {
  test("bundle/win descriptor sets <workingdirectory> to exactly %BASE%", () => {
    const xml = readFileSync(join(root, "bundle/win/xpthermalprintservice.xml"), "utf8");
    expect(xml).toMatch(/<workingdirectory>%BASE%<\/workingdirectory>/);
    expect(xml).not.toMatch(/<workingdirectory>%BASE%\\/);
    expect(xml).not.toMatch(/<arguments>/);
  });

  test("install.ps1 defines $DashboardUrl before using it, from the scanned health port", () => {
    const ps1 = readFileSync(join(root, "bundle/win/install.ps1"), "utf8");
    const firstUse = ps1.indexOf("$DashboardUrl");
    expect(firstUse).toBeGreaterThanOrEqual(0);
    // The port must come from the /health scan: when 9100 is busy the
    // service falls back to 9101+ and a hardcoded 9100 opens a dead page.
    expect(ps1.slice(firstUse)).toMatch(/^\$DashboardUrl\s*=\s*"http:\/\/127\.0\.0\.1:\$healthPort\/dashboard"/);
    expect(ps1).not.toMatch(/\$DashboardUrl\s*=\s*"[^"]*:9100\//);
  });

  test("install.ps1 defaults to the published bundle and self-elevates", () => {
    const ps1 = readFileSync(join(root, "bundle/win/install.ps1"), "utf8");
    expect(ps1).toContain('https://posfiles.geraldsonperez.dev/thermal-service/xp-thermal-service.zip');
    expect(ps1).toContain("-Verb RunAs");
    expect(ps1).toContain("-ExecutionPolicy Bypass");
  });

  test("install.ps1 resolves WinSW paths before registration", () => {
    const ps1 = readFileSync(join(root, "bundle/win/install.ps1"), "utf8");
    expect(ps1).toContain("$xml = $xml.Replace('%BASE%', $InstallPath)");
  });

  test("`npm run package` wires in the release zip step", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["package"]).toContain("package:zip");
    expect(pkg.scripts["package:zip"]).toContain("scripts/package.js");
  });

  test("release packaging ships a ready-to-run config.json", () => {
    const script = readFileSync(join(root, "scripts/package.js"), "utf8");
    expect(script).toContain('["config.example.json", "config.json"]');
  });
});
