import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const required = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["run", "package"], { stdio: "inherit" });

const zipPath = resolve("bundle/xp-thermal-service.zip");
const installerPath = resolve("bundle/win/install.ps1");
if (!existsSync(zipPath) || !existsSync(installerPath)) {
  throw new Error("Release artifact or bundle/win/install.ps1 does not exist.");
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const prefix = (process.env.R2_PREFIX ?? "thermal-service").replace(/^\/+|\/+$/g, "");
const version = JSON.parse(readFileSync(resolve("package.json"), "utf-8")).version;

async function upload(filePath, contentType, extraKey) {
  const keys = [`${prefix}/${basename(filePath)}`];
  if (extraKey) keys.push(extraKey);
  const body = readFileSync(filePath);
  for (const key of keys) {
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
    console.log(`uploaded ${key} (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
  }
}

function versionedKey(filePath) {
  const base = basename(filePath, extname(filePath));
  const ext = extname(filePath);
  return `${prefix}/${version}/${base}-${version}${ext}`;
}

await upload(zipPath, "application/zip", versionedKey(zipPath));
await upload(installerPath, "text/plain; charset=utf-8", versionedKey(installerPath));
