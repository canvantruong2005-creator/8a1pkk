import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";
import fs from "fs";

const cfg = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));
console.log("Connecting to Firestore:", cfg.projectId);

const app = initializeApp(cfg);
const db = getFirestore(app);

async function sync() {
  try {
    console.log("Fetching all documents from submissions collection...");
    const snap = await getDocs(collection(db, "submissions"));
    console.log(`Fetched ${snap.size} submissions from Firestore.`);

    const items: any[] = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      if (data && data.studentId !== undefined && data.subject) {
        items.push({
          ...data,
          id: data.id || docSnap.id,
          studentId: Number(data.studentId),
          classId: data.classId || "8a1",
        });
      }
    });

    console.log(`Processed ${items.length} valid submissions.`);
    if (items.length > 0) {
      if (!fs.existsSync("./data")) {
        fs.mkdirSync("./data", { recursive: true });
      }
      fs.writeFileSync("./data/submissions.json", JSON.stringify(items, null, 2), "utf-8");
      console.log(`Successfully wrote ${items.length} submissions to ./data/submissions.json!`);
    }
  } catch (err: any) {
    console.error("Sync error:", err);
  }
}

sync().then(() => process.exit(0));
