#!/usr/bin/env node
/**
 * setup-https.js
 * Generates a trusted localhost SSL certificate using mkcert.
 *
 * Prerequisites:
 *   - mkcert must be installed (winget install FiloSottile.mkcert)
 *
 * Usage:
 *   node scripts/setup-https.js
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const CERT_DIR = path.join(__dirname, "..", "certs");
const MKCERT_PATHS = [
  "mkcert", // if on PATH after shell restart
  "C:\\Users\\BRUK\\AppData\\Local\\Microsoft\\WinGet\\Packages\\FiloSottile.mkcert_Microsoft.Winget.Source_8wekyb3d8bbwe\\mkcert.exe",
];

// Find mkcert
let mkcert = null;
for (const p of MKCERT_PATHS) {
  try {
    execSync(`"${p}" -version`, { stdio: "ignore" });
    mkcert = p;
    break;
  } catch (_) {}
}

if (!mkcert) {
  console.error(
    "❌ mkcert not found. Install it with:\n" +
    "   winget install FiloSottile.mkcert\n" +
    "Then restart your terminal and run this script again."
  );
  process.exit(1);
}

// Create certs directory
fs.mkdirSync(CERT_DIR, { recursive: true });

console.log("📋 Installing local CA (may need UAC approval)...");
try {
  execSync(`"${mkcert}" -install`, { stdio: "inherit" });
} catch (e) {
  console.warn("⚠️  CA install may have failed — continuing anyway.");
}

console.log("🔑 Generating certificates for localhost & 127.0.0.1...");
execSync(
  `"${mkcert}" -key-file "${path.join(CERT_DIR, "localhost-key.pem")}" -cert-file "${path.join(CERT_DIR, "localhost.pem")}" localhost 127.0.0.1`,
  { stdio: "inherit" }
);

console.log("\n✅ Done! Certificates saved to ./certs/");
console.log("   Restart your server to use HTTPS: node app.js");
console.log("   Then open: https://localhost:3003");

