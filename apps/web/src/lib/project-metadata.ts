import type { ProjectMetadata } from "@fair/shared";

export type PublishMetadataResponse = {
  uri: string;
  hash: string;
  gatewayUrl: string;
};

export async function publishProjectMetadata(metadata: ProjectMetadata, imageFile?: File | null): Promise<PublishMetadataResponse> {
  const formData = new FormData();
  if (imageFile) {
    formData.append("file", imageFile);
  }
  formData.append("name", metadata.name);
  formData.append("symbol", metadata.symbol);
  formData.append("description", metadata.longDescription || metadata.shortPitch);
  formData.append("twitter", metadata.x ?? "");
  formData.append("telegram", metadata.telegram ?? "");
  formData.append("website", metadata.website ?? "");
  formData.append("showName", "true");
  formData.append("metadata", JSON.stringify(metadata));

  const response = await fetch("/api/ipfs/project", {
    method: "POST",
    body: formData
  });

  const json = await response.json() as PublishMetadataResponse | { error: string };
  if (!response.ok) {
    throw new Error("error" in json ? json.error : "Failed to publish project metadata");
  }
  return json as PublishMetadataResponse;
}

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("File preview failed."));
      }
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("File preview failed.")));
    reader.readAsDataURL(file);
  });
}

export async function publishProjectAsset(file: File): Promise<PublishMetadataResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/ipfs/asset", {
    method: "POST",
    body: formData
  });

  const json = await response.json() as PublishMetadataResponse | { error: string };
  if (!response.ok) {
    throw new Error("error" in json ? json.error : "Failed to upload project asset");
  }
  return json as PublishMetadataResponse;
}
