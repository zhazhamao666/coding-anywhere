import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface BridgeImageDirectiveImage {
  localPath: string;
  caption?: string;
}

export interface ParsedBridgeImageDirective {
  cleanedText: string;
  images: BridgeImageDirectiveImage[];
  errors: string[];
}

export interface ValidatedBridgeImage {
  localPath: string;
  caption?: string;
}

export const DEFAULT_BRIDGE_ASSET_ROOT_DIR = path.join(tmpdir(), "coding-anywhere");

export function parseBridgeImageDirective(text: string): ParsedBridgeImageDirective {
  const images: BridgeImageDirectiveImage[] = [];
  const errors: string[] = [];

  const cleanedText = text
    .replace(BRIDGE_IMAGE_DIRECTIVE_PATTERN, (_match, rawPayload: string) => {
      const payload = rawPayload.trim();
      if (!payload) {
        errors.push("[ca] image unavailable: empty bridge-image directive");
        return "";
      }

      try {
        const parsed = JSON.parse(payload) as {
          images?: Array<{
            path?: string;
            caption?: string;
          }>;
        };

        if (!Array.isArray(parsed.images) || parsed.images.length === 0) {
          errors.push("[ca] image unavailable: bridge-image directive has no images");
          return "";
        }

        for (const item of parsed.images) {
          const localPath = typeof item?.path === "string" ? item.path.trim() : "";
          if (!localPath) {
            errors.push("[ca] image unavailable: bridge-image item missing path");
            continue;
          }

          images.push({
            localPath,
            caption: typeof item.caption === "string" ? item.caption.trim() || undefined : undefined,
          });
        }
      } catch {
        errors.push("[ca] image unavailable: invalid bridge-image directive");
      }

      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    cleanedText,
    images,
    errors,
  };
}

export function validateBridgeImagePath(input: {
  candidatePath: string;
  cwd: string;
  managedAssetRootDir?: string;
}): { ok: true; image: ValidatedBridgeImage } | { ok: false; errorText: string } {
  const resolvedPath = resolveCandidatePath(input.cwd, input.candidatePath);
  if (!isPathAllowed(resolvedPath, input.cwd) &&
      !isPathAllowed(resolvedPath, input.managedAssetRootDir ?? DEFAULT_BRIDGE_ASSET_ROOT_DIR)) {
    return {
      ok: false,
      errorText: `[ca] image unavailable: disallowed path ${resolvedPath}`,
    };
  }

  try {
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
      return {
        ok: false,
        errorText: `[ca] image unavailable: not a file ${resolvedPath}`,
      };
    }
  } catch {
    return {
      ok: false,
      errorText: `[ca] image unavailable: file not found ${resolvedPath}`,
    };
  }

  return {
    ok: true,
    image: {
      localPath: resolvedPath,
    },
  };
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

function normalizePathKey(value: string): string {
  return value
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

const BRIDGE_IMAGE_DIRECTIVE_PATTERN = /\[bridge-image\]\s*([\s\S]*?)\s*\[\/bridge-image\]/g;
