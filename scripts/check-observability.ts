import {
  buildDryRunPlan,
  loadObservabilityConfig,
  validateObservabilityConfig,
} from "./observability-config.ts";

const args = process.argv.slice(2);
const forbidden = args.find((arg) =>
  ["--apply", "--execute", "--provision", "--write"].includes(arg),
);
if (forbidden !== undefined) {
  throw new Error(
    `${forbidden} is intentionally unsupported: this repository command never mutates Cloudflare resources.`,
  );
}
if (args.some((arg) => arg !== "--plan")) {
  throw new Error("Usage: npm run observability:check or npm run observability:plan");
}

const config = loadObservabilityConfig();
const output = args.includes("--plan")
  ? buildDryRunPlan(config)
  : validateObservabilityConfig(config);
process.stdout.write(`${JSON.stringify(output, null, args.includes("--plan") ? 2 : 0)}\n`);
