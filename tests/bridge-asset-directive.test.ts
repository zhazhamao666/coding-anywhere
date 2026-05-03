import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BRIDGE_ASSET_ROOT_DIR,
  classifyBridgeAssetSemanticType,
  isBridgeAssetPathWithinRoot,
  mapBridgeAssetToFeishuFileType,
  parseBridgeAssetDirectives,
  parseBridgeAssetsDirective,
  validateBridgeAssetPath,
} from "../src/bridge-asset-directive.js";

const CAN_CREATE_DIRECTORY_LINK = canCreateDirectoryLink();

describe("bridge asset directives", () => {
  let rootDir: string;
  let extraDirs: string[];

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-assets-test-"));
    extraDirs = [];
  });

  afterEach(() => {
    for (const dir of extraDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("parses bridge-assets image, file, markdown, and drawio examples", () => {
    const text = [
      "Here are the generated assets.",
      "[bridge-assets]",
      JSON.stringify({
        assets: [
          {
            kind: "image",
            path: "out/chart.png",
            file_name: "chart.png",
            caption: "Chart preview",
          },
          {
            kind: "file",
            path: "notes.md",
            file_name: "notes.md",
            presentation: "markdown_preview",
            preview: { format: "png" },
          },
          {
            kind: "file",
            path: "workflow.drawio",
            file_name: "workflow.drawio",
            caption: "Architecture diagram",
            presentation: "drawio_with_preview",
            preview: { format: "svg" },
          },
          {
            kind: "file",
            path: "report.pdf",
            file_name: "report.pdf",
            presentation: "attachment",
            preview: { format: "pdf" },
          },
        ],
      }),
      "[/bridge-assets]",
      "Use whichever one fits.",
    ].join("\n");

    const parsed = parseBridgeAssetsDirective(text);

    expect(parsed.cleanedText).toBe("Here are the generated assets.\n\nUse whichever one fits.");
    expect(parsed.errors).toEqual([]);
    expect(parsed.assets).toEqual([
      {
        kind: "image",
        path: "out/chart.png",
        fileName: "chart.png",
        caption: "Chart preview",
      },
      {
        kind: "file",
        path: "notes.md",
        fileName: "notes.md",
        presentation: "markdown_preview",
        preview: { format: "png" },
      },
      {
        kind: "file",
        path: "workflow.drawio",
        fileName: "workflow.drawio",
        caption: "Architecture diagram",
        presentation: "drawio_with_preview",
        preview: { format: "svg" },
      },
      {
        kind: "file",
        path: "report.pdf",
        fileName: "report.pdf",
        presentation: "attachment",
        preview: { format: "pdf" },
      },
    ]);
  });

  it("returns readable bridge-assets errors", () => {
    const parsed = parseBridgeAssetsDirective([
      "[bridge-assets]   [/bridge-assets]",
      "[bridge-assets]{not-json[/bridge-assets]",
      "[bridge-assets]{}[/bridge-assets]",
      "[bridge-assets]{\"assets\":[]}[/bridge-assets]",
      "[bridge-assets]{\"assets\":[{\"kind\":\"image\"}]}[/bridge-assets]",
      "[bridge-assets]{\"assets\":[{\"kind\":\"video\",\"path\":\"movie.mp4\"}]}[/bridge-assets]",
      "[bridge-assets]{\"assets\":[{\"kind\":\"file\",\"path\":\"notes.md\",\"presentation\":\"inline\"}]}[/bridge-assets]",
      "[bridge-assets]{\"assets\":[{\"kind\":\"file\",\"path\":\"notes.md\",\"preview\":{\"format\":\"jpg\"}}]}[/bridge-assets]",
    ].join("\n"));

    expect(parsed.assets).toEqual([]);
    expect(parsed.errors).toEqual([
      "[ca] asset unavailable: empty bridge-assets directive",
      "[ca] asset unavailable: invalid bridge-assets directive",
      "[ca] asset unavailable: bridge-assets directive has no assets",
      "[ca] asset unavailable: bridge-assets directive has no assets",
      "[ca] asset unavailable: bridge-assets item missing path",
      "[ca] asset unavailable: bridge-assets item has invalid kind",
      "[ca] asset unavailable: bridge-assets item has invalid presentation",
      "[ca] asset unavailable: bridge-assets item has invalid preview",
    ]);
  });

  it("keeps legacy bridge-image compatible through the unified helper", () => {
    const parsed = parseBridgeAssetDirectives([
      "Before",
      "[bridge-image]",
      JSON.stringify({
        images: [
          {
            path: "legacy/result.png",
            caption: "Legacy image",
          },
        ],
      }),
      "[/bridge-image]",
      "After",
    ].join("\n"));

    expect(parsed.cleanedText).toBe("Before\n\nAfter");
    expect(parsed.errors).toEqual([]);
    expect(parsed.assets).toEqual([
      {
        kind: "image",
        path: "legacy/result.png",
        caption: "Legacy image",
      },
    ]);
  });

  it("validates cwd and managed asset paths and rejects unsafe or unusable paths", () => {
    const cwd = path.join(rootDir, "repo");
    const managedRoot = path.join(rootDir, "managed");
    const outsideRoot = path.join(rootDir, "outside");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(managedRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(path.join(cwd, "result.txt"), "hello", "utf8");
    writeFileSync(path.join(managedRoot, "asset.png"), "png", "utf8");
    writeFileSync(path.join(cwd, "empty.txt"), "", "utf8");
    writeFileSync(path.join(outsideRoot, "secret.txt"), "secret", "utf8");
    mkdirSync(path.join(cwd, "dir"), { recursive: true });

    expect(validateBridgeAssetPath({
      kind: "file",
      candidatePath: "result.txt",
      cwd,
      managedAssetRootDir: managedRoot,
    })).toEqual({
      ok: true,
      asset: {
        kind: "file",
        localPath: path.join(cwd, "result.txt"),
        fileName: "result.txt",
        fileSize: 5,
        semanticType: "generic",
      },
    });

    expect(validateBridgeAssetPath({
      kind: "image",
      candidatePath: path.join(managedRoot, "asset.png"),
      cwd,
      managedAssetRootDir: managedRoot,
      caption: "Managed preview",
    })).toEqual({
      ok: true,
      asset: {
        kind: "image",
        localPath: path.join(managedRoot, "asset.png"),
        fileName: "asset.png",
        fileSize: 3,
        caption: "Managed preview",
        semanticType: "generic",
      },
    });

    mkdirSync(DEFAULT_BRIDGE_ASSET_ROOT_DIR, { recursive: true });
    const defaultManagedRoot = mkdtempSync(path.join(DEFAULT_BRIDGE_ASSET_ROOT_DIR, "default-root-"));
    extraDirs.push(defaultManagedRoot);
    writeFileSync(path.join(defaultManagedRoot, "asset.txt"), "managed", "utf8");
    expect(validateBridgeAssetPath({
      kind: "file",
      candidatePath: path.join(defaultManagedRoot, "asset.txt"),
      cwd,
    })).toMatchObject({
      ok: true,
      asset: {
        localPath: path.join(defaultManagedRoot, "asset.txt"),
      },
    });

    expect(validateBridgeAssetPath({
      kind: "file",
      candidatePath: path.join(outsideRoot, "secret.txt"),
      cwd,
      managedAssetRootDir: managedRoot,
    })).toEqual({
      ok: false,
      errorText: `[ca] asset unavailable: disallowed path ${path.join(outsideRoot, "secret.txt")}`,
    });
    expect(validateBridgeAssetPath({
      kind: "file",
      candidatePath: "dir",
      cwd,
      managedAssetRootDir: managedRoot,
    })).toEqual({
      ok: false,
      errorText: `[ca] asset unavailable: not a file ${path.join(cwd, "dir")}`,
    });
    expect(validateBridgeAssetPath({
      kind: "file",
      candidatePath: "missing.txt",
      cwd,
      managedAssetRootDir: managedRoot,
    })).toEqual({
      ok: false,
      errorText: `[ca] asset unavailable: file not found ${path.join(cwd, "missing.txt")}`,
    });
    expect(validateBridgeAssetPath({
      kind: "file",
      candidatePath: "empty.txt",
      cwd,
      managedAssetRootDir: managedRoot,
    })).toEqual({
      ok: false,
      errorText: `[ca] asset unavailable: empty file ${path.join(cwd, "empty.txt")}`,
    });
  });

  it("treats POSIX asset path prefixes as case-sensitive", () => {
    expect(isBridgeAssetPathWithinRoot({
      candidatePath: "/tmp/repo/secret.txt",
      rootPath: "/tmp/Repo",
      platform: "linux",
    })).toBe(false);

    expect(isBridgeAssetPathWithinRoot({
      candidatePath: "C:/Temp/Repo/asset.txt",
      rootPath: "c:/temp/repo",
      platform: "win32",
    })).toBe(true);
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)(
    "rejects cwd links that resolve outside allowed roots (requires directory link support)",
    () => {
    const cwd = path.join(rootDir, "repo");
    const managedRoot = path.join(rootDir, "managed");
    const outsideRoot = path.join(rootDir, "outside");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(managedRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(path.join(outsideRoot, "secret.txt"), "secret", "utf8");

    const linkPath = path.join(cwd, "outside-link");
    symlinkSync(outsideRoot, linkPath, process.platform === "win32" ? "junction" : "dir");

    expect(validateBridgeAssetPath({
      kind: "file",
      candidatePath: path.join("outside-link", "secret.txt"),
      cwd,
      managedAssetRootDir: managedRoot,
    })).toEqual({
      ok: false,
      errorText: `[ca] asset unavailable: disallowed path ${path.join(cwd, "outside-link", "secret.txt")}`,
    });
    },
  );

  it("does not allow missing managed roots to participate in path checks", () => {
    const cwd = path.join(rootDir, "repo");
    const missingManagedRoot = path.join(rootDir, "missing-managed");
    const candidatePath = path.join(missingManagedRoot, "ghost.txt");
    mkdirSync(cwd, { recursive: true });

    expect(validateBridgeAssetPath({
      kind: "file",
      candidatePath,
      cwd,
      managedAssetRootDir: missingManagedRoot,
    })).toEqual({
      ok: false,
      errorText: `[ca] asset unavailable: disallowed path ${candidatePath}`,
    });
  });

  it("classifies markdown and drawio assets and maps Feishu file types", () => {
    expect(classifyBridgeAssetSemanticType({ fileName: "README.md" })).toBe("markdown");
    expect(classifyBridgeAssetSemanticType({ fileName: "notes.txt", mimeType: "text/markdown" })).toBe("markdown");
    expect(classifyBridgeAssetSemanticType({ fileName: "workflow.drawio.xml" })).toBe("drawio");
    expect(classifyBridgeAssetSemanticType({
      fileName: "workflow-drawio.xml",
      mimeType: "application/xml",
    })).toBe("drawio");
    expect(classifyBridgeAssetSemanticType({ fileName: "report.pdf" })).toBe("generic");

    expect(mapBridgeAssetToFeishuFileType({ fileName: "README.md" })).toBe("stream");
    expect(mapBridgeAssetToFeishuFileType({ fileName: "workflow.drawio" })).toBe("stream");
    expect(mapBridgeAssetToFeishuFileType({ fileName: "workflow.drawio.xml" })).toBe("stream");
    expect(mapBridgeAssetToFeishuFileType({ fileName: "report.pdf" })).toBe("pdf");
    expect(mapBridgeAssetToFeishuFileType({ fileName: "brief.docx" })).toBe("doc");
    expect(mapBridgeAssetToFeishuFileType({ fileName: "data.csv" })).toBe("xls");
    expect(mapBridgeAssetToFeishuFileType({ fileName: "slides.pptx" })).toBe("ppt");
    expect(mapBridgeAssetToFeishuFileType({ fileName: "clip.mp4" })).toBe("mp4");
    expect(mapBridgeAssetToFeishuFileType({ fileName: "audio.opus" })).toBe("opus");
    expect(mapBridgeAssetToFeishuFileType({ fileName: "archive.zip" })).toBe("stream");
  });
});

function canCreateDirectoryLink(): boolean {
  const probeRoot = mkdtempSync(path.join(tmpdir(), "bridge-assets-link-probe-"));
  try {
    const target = path.join(probeRoot, "target");
    const link = path.join(probeRoot, "link");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}
