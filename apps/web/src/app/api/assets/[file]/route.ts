import { NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  const contentType = contentTypeForFile(file);
  if (!contentType) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }

  try {
    const bytes = await readFile(path.join(assetStorageDir(), file));
    return new Response(bytes, {
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=31536000, immutable"
      }
    });
  } catch {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
}

export async function HEAD(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  const contentType = contentTypeForFile(file);
  if (!contentType) {
    return new Response(null, { status: 404 });
  }

  try {
    const fileStat = await stat(path.join(assetStorageDir(), file));
    return new Response(null, {
      headers: {
        "content-type": contentType,
        "content-length": String(fileStat.size),
        "cache-control": "public, max-age=31536000, immutable"
      }
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function contentTypeForFile(file: string) {
  if (!/^[a-f0-9-]+-[a-f0-9]{16}\.(png|jpg|webp|gif)$/i.test(file)) {
    return null;
  }
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? null;
}

function assetStorageDir() {
  return process.env.ASSET_STORAGE_DIR ?? path.join(process.cwd(), ".stick-assets");
}
