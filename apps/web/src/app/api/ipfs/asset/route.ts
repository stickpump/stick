import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Image file is required." }, { status: 400 });
  }
  const extension = ALLOWED_IMAGE_TYPES.get(file.type);
  if (!extension) {
    return NextResponse.json({ error: "Only PNG, JPG, WebP and GIF images are supported." }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "Image file must be 5MB or smaller." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const hash = createHash("sha256").update(buffer).digest("hex");
  const filename = `${randomUUID()}-${hash.slice(0, 16)}.${extension}`;
  const storageDir = assetStorageDir();
  await mkdir(storageDir, { recursive: true });
  await writeFile(path.join(storageDir, filename), buffer, { flag: "wx" });

  const assetUrl = `${publicOrigin(request)}/api/assets/${filename}`;

  return NextResponse.json({
    uri: assetUrl,
    hash,
    gatewayUrl: assetUrl
  });
}

function assetStorageDir() {
  return process.env.ASSET_STORAGE_DIR ?? path.join(process.cwd(), ".stick-assets");
}

function publicOrigin(request: Request) {
  const configured =
    process.env.PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (configured) {
    const withProtocol = configured.startsWith("http") ? configured : `https://${configured}`;
    return new URL(withProtocol).origin;
  }

  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (forwardedHost) {
    const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
    return `${forwardedProto}://${forwardedHost}`;
  }

  return new URL(request.url).origin;
}
