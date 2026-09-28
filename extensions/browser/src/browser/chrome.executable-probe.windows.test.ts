import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readBrowserVersion } from "./chrome.executable-probe.js";

describe.runIf(process.platform === "win32")("Windows browser version probe", () => {
  let fixtureRoot = "";
  let executablePath = "";

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-probe-"));
    const installDir = path.join(fixtureRoot, "Program Files", "Google Chrome", "Application");
    fs.mkdirSync(installDir, { recursive: true });
    // node.exe carries real PE version metadata, like an installed browser.
    executablePath = path.join(installDir, "chrome.exe");
    fs.copyFileSync(process.execPath, executablePath);
    // Pay PowerShell's cold start outside the probe's production timeout.
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
      timeout: 60_000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("reads PE metadata from an install path with spaces without writing to stderr", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write");

    const version = readBrowserVersion(executablePath);

    expect(stderrWrite).not.toHaveBeenCalled();
    expect(version).toContain(process.versions.node);
  });
});
