const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ejs = require("ejs");

const root = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", ".vercel", "node_modules"]);
const files = [];

function collectFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(file);
    } else if (entry.isFile() && /\.(js|ejs)$/.test(entry.name)) {
      files.push(file);
    }
  }
}

collectFiles(root);

let failures = 0;
let javascriptFiles = 0;
let ejsFiles = 0;

for (const file of files.sort()) {
  if (file.endsWith(".js")) {
    javascriptFiles += 1;
    const result = spawnSync(process.execPath, ["--check", file], {
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`Could not check ${path.relative(root, file)}:`, result.error);
      failures += 1;
    } else if (result.status !== 0) {
      failures += 1;
    }
  } else {
    ejsFiles += 1;
    try {
      ejs.compile(fs.readFileSync(file, "utf8"), { filename: file });
    } catch (error) {
      console.error(`Could not compile ${path.relative(root, file)}:`, error);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`Validation failed with ${failures} error(s).`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${javascriptFiles} JavaScript files and ${ejsFiles} EJS templates.`);
}
