import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function GET() {
  return readFile(join(process.cwd(), "public", "favicon.png")).then((file) => {
    return new Response(file, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=0, must-revalidate"
      }
    }
    );
  });
}
