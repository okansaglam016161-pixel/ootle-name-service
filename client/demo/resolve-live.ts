//   ONS live proof — READS ONLY, no key, no fee. Runs against the deployed registry on esmeralda
//   (Ootle 0.43) via the public indexer. Run: `npm run demo` (from client/).

import { createOnsClient } from "../src/index.js";

// The live registry (see the README's deployment section).
const COMPONENT = "component_0109d5287493affc06ec8902fcbf85bd2362832580feeac2a70cba7e5ac6da4d";
// A name registered on it, and the nostr record it carries.
const NAME = "testname4";
const EXPECTED_NPUB = "npub1enf8yq54xu0dvqygwctq8e0yptjxvsx2zgqy0mypjk5ypdv4jewsu4q2g0";

// Default esmeralda indexer, no credentials of any kind.
const ons = createOnsClient({ component: COMPONENT });

let pass = 0;
let fail = 0;
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  →  ${JSON.stringify(got)}`);
  if (ok) pass++;
  else fail++;
}

check(`resolveToNostr("${NAME}")`, await ons.resolveToNostr(NAME), EXPECTED_NPUB);
check(`isRegistered("${NAME}")`, await ons.isRegistered(NAME), true);
check('isRegistered("this-name-should-not-exist-9284")', await ons.isRegistered("this-name-should-not-exist-9284"), false);
check(`getRecord("${NAME}","nostr")`, await ons.getRecord(NAME, "nostr"), EXPECTED_NPUB);
check(`getRecord("${NAME}","nonexistent")`, await ons.getRecord(NAME, "nonexistent"), null);

const rec = await ons.resolveName(NAME);
console.log(`\nresolveName("${NAME}") → ${JSON.stringify(rec)}`);

console.log(`\n${fail === 0 ? "✅ ALL READ TESTS PASSED" : "❌ SOME TESTS FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
