//   ONS-3 live proof — READS ONLY, no key, no fee. Runs against the real deployed registry on
//   esmeralda via the public indexer. Run: `npx -y tsx demo/resolve-okz.ts` (from client/).

import { createOnsClient } from "../src/index.js";

const COMPONENT = "component_0e70f16ad20e1c1b92f035d1e6f4b69c6c4c774ed309c2eb9e2c42c01279994a";
const EXPECTED_NPUB = "npub1f80mhkkj8hw2ay8xpqwn3c742ptuldvpxlk68k92el5hs22xllpqsknttt";

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

check('resolveToNostr("okz")', await ons.resolveToNostr("okz"), EXPECTED_NPUB);
check('isRegistered("okz")', await ons.isRegistered("okz"), true);
check('isRegistered("this-name-should-not-exist-9284")', await ons.isRegistered("this-name-should-not-exist-9284"), false);
check('getRecord("okz","nostr")', await ons.getRecord("okz", "nostr"), EXPECTED_NPUB);
check('getRecord("okz","nonexistent")', await ons.getRecord("okz", "nonexistent"), null);

const rec = await ons.resolveName("okz");
console.log(`\nresolveName("okz") → ${JSON.stringify(rec)}`);

console.log(`\n${fail === 0 ? "✅ ALL READ TESTS PASSED" : "❌ SOME TESTS FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
