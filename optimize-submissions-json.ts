import fs from "fs";
import path from "path";
import crypto from "crypto";

const SUBMISSIONS_DIR = path.join(process.cwd(), "data");
const SUBMISSIONS_FILE = path.join(SUBMISSIONS_DIR, "submissions.json");
const UPLOADS_DIR = path.join(SUBMISSIONS_DIR, "uploads");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function saveBase64ImageToDisk(base64Data: string, prefix = "img"): string {
  try {
    if (!base64Data || typeof base64Data !== "string" || !base64Data.startsWith("data:image")) {
      return base64Data;
    }
    const matches = base64Data.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!matches || matches.length < 3) return base64Data;

    let ext = matches[1].toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    if (ext.includes("svg")) ext = "svg";
    const rawData = matches[2];
    const buffer = Buffer.from(rawData, "base64");

    const hash = crypto.createHash("md5").update(buffer).digest("hex").slice(0, 16);
    const filename = `${prefix}_${hash}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    fs.writeFileSync(filePath, buffer);
    return `/api/uploads/${filename}`;
  } catch (err) {
    console.error("Lỗi lưu ảnh lên đĩa:", err);
    return base64Data;
  }
}

async function run() {
  console.log("Reading data/submissions.json...");
  const raw = fs.readFileSync(SUBMISSIONS_FILE, "utf-8");
  const items = JSON.parse(raw);
  console.log(`Read ${items.length} items. Extracting base64 images...`);

  let convertedCount = 0;
  for (const item of items) {
    if (Array.isArray(item.content)) {
      item.content = item.content.map((c: any) => {
        if (typeof c === "string" && c.startsWith("data:image")) {
          convertedCount++;
          return saveBase64ImageToDisk(c, `hs${item.studentId || "sub"}`);
        }
        return c;
      });
    }
  }

  console.log(`Converted ${convertedCount} base64 images to static files in data/uploads/`);
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(items, null, 2), "utf-8");
  const stats = fs.statSync(SUBMISSIONS_FILE);
  console.log(`New size of data/submissions.json: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
}

run();
