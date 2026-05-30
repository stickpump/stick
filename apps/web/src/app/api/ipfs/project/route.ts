import { NextResponse } from "next/server";
import type { ProjectMetadata } from "@fair/shared";

export const runtime = "nodejs";

const PUMP_METADATA_ENDPOINT = "https://pump.fun/api/ipfs";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const formData = await request.formData();
  const metadata = parseMetadata(formData);
  const error = validateProjectMetadata(metadata);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  const file = formData.get("file");
  if (file !== null && !(file instanceof File)) {
    return NextResponse.json({ error: "Image file is invalid." }, { status: 400 });
  }
  if (file instanceof File && !file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Only image files are supported." }, { status: 400 });
  }
  if (file instanceof File && file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "Image file must be 5MB or smaller." }, { status: 400 });
  }

  const upload = new FormData();
  upload.append("file", file instanceof File ? file : fallbackImage(), file instanceof File ? file.name : "blank.png");
  upload.append("name", metadata.name);
  upload.append("symbol", metadata.symbol);
  upload.append("description", metadata.longDescription || metadata.shortPitch);
  upload.append("twitter", metadata.x ?? "");
  upload.append("telegram", metadata.telegram ?? "");
  upload.append("website", metadata.website ?? "");
  upload.append("showName", "true");

  const response = await fetch(PUMP_METADATA_ENDPOINT, {
    method: "POST",
    body: upload
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json({ error: `Pump metadata upload failed: HTTP ${response.status} ${text}` }, { status: 502 });
  }

  const json = await response.json() as {
    metadataUri?: string;
    metadata?: { metadataUri?: string };
  };
  const metadataUri = json.metadataUri ?? json.metadata?.metadataUri;
  if (!metadataUri) {
    return NextResponse.json({ error: "Pump metadata upload did not return metadataUri." }, { status: 502 });
  }

  return NextResponse.json({
    uri: metadataUri,
    hash: metadataUri,
    gatewayUrl: metadataUri
  });
}

function parseMetadata(formData: FormData): ProjectMetadata {
  const raw = formData.get("metadata");
  if (typeof raw === "string" && raw.trim()) {
    return JSON.parse(raw) as ProjectMetadata;
  }

  return {
    name: String(formData.get("name") ?? ""),
    symbol: String(formData.get("symbol") ?? ""),
    logoUrl: "",
    bannerUrl: "",
    shortPitch: String(formData.get("description") ?? ""),
    longDescription: String(formData.get("description") ?? ""),
    website: String(formData.get("website") ?? ""),
    x: String(formData.get("twitter") ?? ""),
    telegram: String(formData.get("telegram") ?? ""),
    discord: "",
    docs: "",
    tags: [],
    category: "",
    riskNotes: [],
    tokenomics: {
      presaleBps: 0,
      devbuyBps: 0,
      rewardsBps: 0,
      buybackBps: 0,
      liquidityBps: 0
    }
  };
}

function fallbackImage() {
  const transparentPng1x1Base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Y5NQAAAAASUVORK5CYII=";
  const bytes = Buffer.from(transparentPng1x1Base64, "base64");
  return new File([bytes], "blank.png", { type: "image/png" });
}

function validateProjectMetadata(metadata: ProjectMetadata): string | null {
  if (!metadata.name || metadata.name.length > 64) {
    return "Project name is required and must be <= 64 chars.";
  }
  if (!metadata.symbol || metadata.symbol.length > 12) {
    return "Ticker is required and must be <= 12 chars.";
  }
  if (!metadata.shortPitch || metadata.shortPitch.length > 180) {
    return "Short pitch is required and must be <= 180 chars.";
  }
  if (!metadata.longDescription || metadata.longDescription.length > 4_000) {
    return "Description is required and must be <= 4000 chars.";
  }
  return null;
}
