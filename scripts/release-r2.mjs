import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const required = ["R2_SERVICE_URL", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_INSTALLER_PATH"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["run", "package"], { stdio: "inherit" });

const zipPath = resolve("bundle/xp-thermal-service.zip");
const installerPath = resolve(process.env.R2_INSTALLER_PATH);
if (!existsSync(zipPath) || !existsSync(installerPath)) {
  throw new Error("Release artifact or R2_INSTALLER_PATH does not exist.");
}

const client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_SERVICE_URL,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const prefix = (process.env.R2_PREFIX ?? "thermal-service").replace(/^\/+|\/+$/g, "");

async function upload(filePath, contentType) {
  const key = `${prefix}/${basename(filePath)}`;
  const body = readFileSync(filePath);
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  console.log(`uploaded ${key} (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
}

await upload(zipPath, "application/zip");
await upload(installerPath, "text/plain; charset=utf-8");
