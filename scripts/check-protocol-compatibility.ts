import { readFileSync } from "node:fs";

import { checkProtocolCompatibility } from "./protocol-compatibility.ts";

const fixtureUrl = new URL("../tests/protocol-fixtures/frozen-client.json", import.meta.url);
const fixture: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
const summary = checkProtocolCompatibility(fixture);
process.stdout.write(`${JSON.stringify(summary)}\n`);
