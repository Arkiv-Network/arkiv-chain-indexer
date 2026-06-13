import { describe, expect, test } from "bun:test";
import { readBaseloadCreatedEntityKeyFromReceipt } from "./baseloadRuntime";

const TX_HASH = `0x${"aa".repeat(32)}` as `0x${string}`;
const ENTITY_KEY = `0x${"11".repeat(32)}` as `0x${string}`;
const ARKIV_ADDRESS = "0x00000000000000000000000000000061726b6976";
const ARKIV_ENTITY_CREATED_UINT_TOPIC =
  "0x73dc52f9255c70375a8835a75fca19be3d9f6940536cccf5a7bc414368b389fa";
const ARKIV_ENTITY_CREATED_BYTES32_TOPIC =
  "0x5abeb37cae25ff8919c8348d9eebadaccd3166c8ac55d8dfa7afc70f3cce7d19";

describe("baseload runtime receipt parsing", () => {
  test("reads the created entity key from the Arkiv create event", () => {
    expect(
      readBaseloadCreatedEntityKeyFromReceipt(
        {
          logs: [
            {
              address: "0x0000000000000000000000000000000000000001",
              topics: [`0x${"00".repeat(32)}`],
            },
            {
              address: ARKIV_ADDRESS,
              topics: [ARKIV_ENTITY_CREATED_UINT_TOPIC, ENTITY_KEY],
            },
          ],
        },
        TX_HASH,
      ),
    ).toBe(ENTITY_KEY);
  });

  test("accepts the bytes32 create event signature used by some networks", () => {
    expect(
      readBaseloadCreatedEntityKeyFromReceipt(
        {
          logs: [
            {
              address: ARKIV_ADDRESS,
              topics: [ARKIV_ENTITY_CREATED_BYTES32_TOPIC, ENTITY_KEY],
            },
          ],
        },
        TX_HASH,
      ),
    ).toBe(ENTITY_KEY);
  });

  test("rejects receipts without an Arkiv create event", () => {
    expect(() =>
      readBaseloadCreatedEntityKeyFromReceipt(
        {
          logs: [
            {
              address: ARKIV_ADDRESS,
              topics: [`0x${"00".repeat(32)}`, ENTITY_KEY],
            },
          ],
        },
        TX_HASH,
      ),
    ).toThrow(/no ArkivEntityCreated event/);
  });

  test("rejects Arkiv create events without a bytes32 entity key topic", () => {
    expect(() =>
      readBaseloadCreatedEntityKeyFromReceipt(
        {
          logs: [
            {
              address: ARKIV_ADDRESS,
              topics: [ARKIV_ENTITY_CREATED_UINT_TOPIC],
            },
          ],
        },
        TX_HASH,
      ),
    ).toThrow(/topic\[1\] is missing or invalid/);
  });

  test("rejects ambiguous create receipts", () => {
    expect(() =>
      readBaseloadCreatedEntityKeyFromReceipt(
        {
          logs: [
            {
              address: ARKIV_ADDRESS,
              topics: [ARKIV_ENTITY_CREATED_UINT_TOPIC, ENTITY_KEY],
            },
            {
              address: ARKIV_ADDRESS,
              topics: [ARKIV_ENTITY_CREATED_BYTES32_TOPIC, `0x${"22".repeat(32)}`],
            },
          ],
        },
        TX_HASH,
      ),
    ).toThrow(/2 ArkivEntityCreated events/);
  });
});
