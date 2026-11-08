import fs from "fs";
import path from "path";
import JSZip from "jszip";

async function createZip() {
  const distDir = path.join(process.cwd(), "dist");
  const outputZipPath = path.join(process.cwd(), "public", "edumaster-cloudflare.zip");

  if (!fs.existsSync(distDir)) {
    console.error("Dist folder does not exist! Run npm run build first.");
    process.exit(1);
  }

  const zip = new JSZip();

  function addFolderToZip(currentDir: string, zipFolder: JSZip) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      // Skip server.cjs bundles and map files - Cloudflare Pages only hosts static client files
      if (entry.name.startsWith("server.cjs") || entry.name.endsWith(".zip")) {
        continue;
      }
      if (entry.isDirectory()) {
        const subFolder = zipFolder.folder(entry.name);
        if (subFolder) {
          addFolderToZip(fullPath, subFolder);
        }
      } else {
        const fileData = fs.readFileSync(fullPath);
        zipFolder.file(entry.name, fileData);
      }
    }
  }

  console.log("Packaging static distribution files from dist/...");
  addFolderToZip(distDir, zip);

  const content = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });

  fs.writeFileSync(outputZipPath, content);
  const stats = fs.statSync(outputZipPath);
  console.log(`Successfully generated public/edumaster-cloudflare.zip (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
}

createZip().catch(console.error);
