import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Guards the rule that matters most for publishing this repo: no real client
 * content. Fixtures are invented and stay invented.
 *
 * It cannot prove the absence of real data — only a person reading the diff can
 * do that. What it can do is catch the obvious slips: a real phone number, an
 * email address, a leaked key.
 */
const PATTERNS = [
  { name: "API key (OpenRouter)", re: /\bsk-or-v1-[A-Za-z0-9]{8,}/ },
  { name: "API key (Anthropic)", re: /\bsk-ant-[A-Za-z0-9-]{8,}/ },
  { name: "API key (OpenAI)", re: /\bsk-proj-[A-Za-z0-9]{8,}/ },
  { name: "email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "E.164 phone number", re: /(?<![\w.])\+\d{10,15}(?![\w.])/ },
];

// The example's fake WhatsApp id and the placeholder in .env.example are the
// shapes this check would otherwise flag every run.
const ALLOWED = [/5491100000000/, /sk-or-v1-\.\.\./, /noreply@anthropic\.com/];

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !/^(package-lock\.json|LICENSE)$/.test(f));

let failures = 0;

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // binary
  }

  content.split("\n").forEach((line, i) => {
    if (ALLOWED.some((allowed) => allowed.test(line))) return;
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        console.error(`${file}:${i + 1}  possible ${name}`);
        console.error(`  ${line.trim().slice(0, 120)}`);
        failures++;
      }
    }
  });
}

if (failures > 0) {
  console.error(`\n${failures} possible leak(s). Review before publishing.`);
  process.exit(1);
}

console.log(`checked ${files.length} tracked files: no obvious real data`);
