import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  BridgeAssetPresentation,
  BridgeAssetPreview,
  BridgeAssetResourceType,
  BridgeAssetSemanticType,
} from "./types.js";

export interface BridgeAssetDirectiveAsset {
  kind: BridgeAssetResourceType;
  path: string;
  fileName?: string;
  caption?: string;
  presentation?: BridgeAssetPresentation;
  preview?: BridgeAssetPreview;
}

export interface ParsedBridgeAssetDirective {
  cleanedText: string;
  assets: BridgeAssetDirectiveAsset[];
  errors: string[];
}

export interface BridgeImageDirectiveImage {
  localPath: string;
  caption?: string;
}

export interface ParsedBridgeImageDirective {
  cleanedText: string;
  images: BridgeImageDirectiveImage[];
  errors: string[];
}

export interface ValidatedBridgeAsset {
  kind: BridgeAssetResourceType;
  localPath: string;
  fileName?: string;
  caption?: string;
  mimeType?: string;
  fileSize?: number;
  semanticType?: BridgeAssetSemanticType;
  presentation?: BridgeAssetPresentation;
  preview?: BridgeAssetPreview;
}

export interface ValidatedBridgeImage {
  localPath: string;
  caption?: string;
}

export type BridgeAssetPathValidationResult =
  | { ok: true; asset: ValidatedBridgeAsset }
  | { ok: false; errorText: string };

export type BridgeImagePathValidationResult =
  | { ok: true; image: ValidatedBridgeImage }
  | { ok: false; errorText: string };

export type FeishuBridgeFileType = "pdf" | "doc" | "xls" | "ppt" | "mp4" | "opus" | "stream";

export const DEFAULT_BRIDGE_ASSET_ROOT_DIR = path.join(tmpdir(), "coding-anywhere");

export function parseBridgeAssetsDirective(text: string): ParsedBridgeAssetDirective {
  return parseBridgeDirectiveText(text, {
    includeAssetsDirective: true,
    includeLegacyImageDirective: false,
  });
}

export function parseBridgeAssetDirectives(text: string): ParsedBridgeAssetDirective {
  return parseBridgeDirectiveText(text, {
    includeAssetsDirective: true,
    includeLegacyImageDirective: true,
  });
}

export function parseBridgeImageDirective(text: string): ParsedBridgeImageDirective {
  const parsed = parseBridgeDirectiveText(text, {
    includeAssetsDirective: false,
    includeLegacyImageDirective: true,
  });

  return {
    cleanedText: parsed.cleanedText,
    images: parsed.assets.map(asset => ({
      localPath: asset.path,
      caption: asset.caption,
    })),
    errors: parsed.errors,
  };
}

export function validateBridgeAssetPath(input: {
  kind: BridgeAssetResourceType;
  candidatePath: string;
  cwd: string;
  managedAssetRootDir?: string;
  fileName?: string;
  caption?: string;
  mimeType?: string | null;
  presentation?: BridgeAssetPresentation;
  preview?: BridgeAssetPreview;
}): BridgeAssetPathValidationResult {
  const resolvedPath = resolveCandidatePath(input.cwd, input.candidatePath);
  const managedRootDir = input.managedAssetRootDir ?? DEFAULT_BRIDGE_ASSET_ROOT_DIR;
  const allowedRoots = collectExistingAllowedRoots([input.cwd, managedRootDir]);

  let fileSize: number;
  try {
    const stat = statSync(resolvedPath);
    const realPath = realpathSync(resolvedPath);
    if (!allowedRoots.some(root => isPathAllowed(realPath, root.realPath))) {
      return {
        ok: false,
        errorText: `[ca] asset unavailable: disallowed path ${resolvedPath}`,
      };
    }
    if (!stat.isFile()) {
      return {
        ok: false,
        errorText: `[ca] asset unavailable: not a file ${resolvedPath}`,
      };
    }
    if (stat.size === 0) {
      return {
        ok: false,
        errorText: `[ca] asset unavailable: empty file ${resolvedPath}`,
      };
    }
    fileSize = stat.size;
  } catch {
    if (!allowedRoots.some(root => isPathAllowed(resolvedPath, root.rootPath))) {
      return {
        ok: false,
        errorText: `[ca] asset unavailable: disallowed path ${resolvedPath}`,
      };
    }

    return {
      ok: false,
      errorText: `[ca] asset unavailable: file not found ${resolvedPath}`,
    };
  }

  const fileName = trimOptional(input.fileName) ?? path.basename(resolvedPath);
  const mimeType = trimOptional(input.mimeType ?? undefined);
  const asset: ValidatedBridgeAsset = {
    kind: input.kind,
    localPath: resolvedPath,
    fileName,
    fileSize,
    semanticType: classifyBridgeAssetSemanticType({
      localPath: resolvedPath,
      fileName,
      mimeType,
    }),
  };
  if (input.caption) {
    asset.caption = input.caption;
  }
  if (mimeType) {
    asset.mimeType = mimeType;
  }
  if (input.presentation) {
    asset.presentation = input.presentation;
  }
  if (input.preview) {
    asset.preview = input.preview;
  }

  return {
    ok: true,
    asset,
  };
}

export function validateBridgeImagePath(input: {
  candidatePath: string;
  cwd: string;
  managedAssetRootDir?: string;
}): BridgeImagePathValidationResult {
  const validation = validateBridgeAssetPath({
    kind: "image",
    candidatePath: input.candidatePath,
    cwd: input.cwd,
    managedAssetRootDir: input.managedAssetRootDir,
  });

  if (!validation.ok) {
    return {
      ok: false,
      errorText: validation.errorText.replace("[ca] asset unavailable:", "[ca] image unavailable:"),
    };
  }

  return {
    ok: true,
    image: {
      localPath: validation.asset.localPath,
    },
  };
}

export function classifyBridgeAssetSemanticType(input: {
  localPath?: string;
  fileName?: string;
  mimeType?: string | null;
}): BridgeAssetSemanticType {
  const fileName = getAssetFileName(input).toLowerCase();
  const mimeType = normalizeMimeType(input.mimeType);

  if (fileName.endsWith(".md") || fileName.endsWith(".markdown") || mimeType === "text/markdown") {
    return "markdown";
  }

  if (fileName.endsWith(".drawio") || fileName.endsWith(".drawio.xml")) {
    return "drawio";
  }

  if (fileName.includes("drawio") &&
      (mimeType === "application/vnd.jgraph.mxfile" ||
        mimeType === "application/xml" ||
        mimeType === "text/xml")) {
    return "drawio";
  }

  return "generic";
}

export function mapBridgeAssetToFeishuFileType(input: {
  localPath?: string;
  fileName?: string;
}): FeishuBridgeFileType {
  const fileName = getAssetFileName(input).toLowerCase();
  if (fileName.endsWith(".drawio.xml")) {
    return "stream";
  }

  switch (path.extname(fileName)) {
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
    case ".csv":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    case ".mp4":
      return "mp4";
    case ".opus":
      return "opus";
    default:
      return "stream";
  }
}

function parseBridgeDirectiveText(text: string, options: {
  includeAssetsDirective: boolean;
  includeLegacyImageDirective: boolean;
}): ParsedBridgeAssetDirective {
  const assets: BridgeAssetDirectiveAsset[] = [];
  const errors: string[] = [];

  const cleanedText = text
    .replace(BRIDGE_DIRECTIVE_PATTERN, (match, directiveName: string, rawPayload: string) => {
      if (directiveName === "bridge-assets") {
        if (!options.includeAssetsDirective) {
          return match;
        }
        assets.push(...parseBridgeAssetsPayload(rawPayload, errors));
        return "";
      }

      if (!options.includeLegacyImageDirective) {
        return match;
      }
      assets.push(...parseLegacyBridgeImagePayload(rawPayload, errors));
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    cleanedText,
    assets,
    errors,
  };
}

function parseBridgeAssetsPayload(rawPayload: string, errors: string[]): BridgeAssetDirectiveAsset[] {
  const payload = rawPayload.trim();
  if (!payload) {
    errors.push("[ca] asset unavailable: empty bridge-assets directive");
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    errors.push("[ca] asset unavailable: invalid bridge-assets directive");
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.assets) || parsed.assets.length === 0) {
    errors.push("[ca] asset unavailable: bridge-assets directive has no assets");
    return [];
  }

  const assets: BridgeAssetDirectiveAsset[] = [];
  for (const item of parsed.assets) {
    if (!isRecord(item)) {
      errors.push("[ca] asset unavailable: bridge-assets item has invalid kind");
      errors.push("[ca] asset unavailable: bridge-assets item missing path");
      continue;
    }

    const kind = isBridgeAssetResourceType(item.kind) ? item.kind : undefined;
    const assetPath = typeof item.path === "string" ? item.path.trim() : "";
    const presentation = parsePresentation(item, errors);
    const preview = parsePreview(item, errors);

    if (!kind) {
      errors.push("[ca] asset unavailable: bridge-assets item has invalid kind");
    }
    if (!assetPath) {
      errors.push("[ca] asset unavailable: bridge-assets item missing path");
    }
    if (!kind ||
        !assetPath ||
        presentation === INVALID_PRESENTATION ||
        preview === INVALID_PREVIEW) {
      continue;
    }

    const asset: BridgeAssetDirectiveAsset = {
      kind,
      path: assetPath,
    };
    const fileName = typeof item.file_name === "string" ? item.file_name.trim() : "";
    const caption = typeof item.caption === "string" ? item.caption.trim() : "";
    if (fileName) {
      asset.fileName = fileName;
    }
    if (caption) {
      asset.caption = caption;
    }
    if (presentation) {
      asset.presentation = presentation;
    }
    if (preview) {
      asset.preview = preview;
    }
    assets.push(asset);
  }

  return assets;
}

function parseLegacyBridgeImagePayload(rawPayload: string, errors: string[]): BridgeAssetDirectiveAsset[] {
  const payload = rawPayload.trim();
  if (!payload) {
    errors.push("[ca] image unavailable: empty bridge-image directive");
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    errors.push("[ca] image unavailable: invalid bridge-image directive");
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.images) || parsed.images.length === 0) {
    errors.push("[ca] image unavailable: bridge-image directive has no images");
    return [];
  }

  const assets: BridgeAssetDirectiveAsset[] = [];
  for (const item of parsed.images) {
    const localPath = isRecord(item) && typeof item.path === "string" ? item.path.trim() : "";
    if (!localPath) {
      errors.push("[ca] image unavailable: bridge-image item missing path");
      continue;
    }

    const caption = isRecord(item) && typeof item.caption === "string" ? item.caption.trim() : "";
    assets.push({
      kind: "image",
      path: localPath,
      caption: caption || undefined,
    });
  }

  return assets;
}

function parsePresentation(
  item: Record<string, unknown>,
  errors: string[],
): BridgeAssetPresentation | typeof INVALID_PRESENTATION | undefined {
  if (!Object.prototype.hasOwnProperty.call(item, "presentation") || item.presentation === undefined) {
    return undefined;
  }
  if (item.presentation === "attachment" ||
      item.presentation === "markdown_preview" ||
      item.presentation === "drawio_with_preview") {
    return item.presentation;
  }
  errors.push("[ca] asset unavailable: bridge-assets item has invalid presentation");
  return INVALID_PRESENTATION;
}

function parsePreview(
  item: Record<string, unknown>,
  errors: string[],
): BridgeAssetPreview | typeof INVALID_PREVIEW | undefined {
  if (!Object.prototype.hasOwnProperty.call(item, "preview") || item.preview === undefined) {
    return undefined;
  }
  if (isRecord(item.preview) &&
      (item.preview.format === "png" || item.preview.format === "svg" || item.preview.format === "pdf")) {
    return {
      format: item.preview.format,
    };
  }
  errors.push("[ca] asset unavailable: bridge-assets item has invalid preview");
  return INVALID_PREVIEW;
}

function resolveCandidatePath(cwd: string, candidatePath: string): string {
  return path.resolve(path.isAbsolute(candidatePath) ? candidatePath : path.join(cwd, candidatePath));
}

function isPathAllowed(candidatePath: string, rootPath: string | undefined): boolean {
  if (!rootPath) {
    return false;
  }

  const normalizedCandidate = normalizePathKey(candidatePath);
  const normalizedRoot = normalizePathKey(path.resolve(rootPath));
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function collectExistingAllowedRoots(rootPaths: Array<string | undefined>): Array<{
  rootPath: string;
  realPath: string;
}> {
  const roots: Array<{
    rootPath: string;
    realPath: string;
  }> = [];

  for (const rootPath of rootPaths) {
    const realPath = tryRealpath(rootPath);
    if (rootPath && realPath) {
      roots.push({
        rootPath: path.resolve(rootPath),
        realPath,
      });
    }
  }

  return roots;
}

function tryRealpath(rootPath: string | undefined): string | undefined {
  if (!rootPath) {
    return undefined;
  }

  try {
    return realpathSync(rootPath);
  } catch {
    return undefined;
  }
}

function normalizePathKey(value: string): string {
  return value
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

function getAssetFileName(input: { localPath?: string; fileName?: string }): string {
  const explicitFileName = trimOptional(input.fileName);
  if (explicitFileName) {
    return explicitFileName;
  }
  return input.localPath ? path.basename(input.localPath) : "";
}

function normalizeMimeType(value?: string | null): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isBridgeAssetResourceType(value: unknown): value is BridgeAssetResourceType {
  return value === "image" || value === "file";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BRIDGE_DIRECTIVE_PATTERN = /\[(bridge-assets|bridge-image)\]\s*([\s\S]*?)\s*\[\/\1\]/g;
const INVALID_PRESENTATION = Symbol("invalid-presentation");
const INVALID_PREVIEW = Symbol("invalid-preview");
