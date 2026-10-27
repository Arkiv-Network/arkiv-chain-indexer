import { describe, expect, test } from "bun:test";
import { completions, SYSTEM_ATTRIBUTES } from "./src/queryLanguage";

describe("query editor completions", () => {
  test("offer the node's queryable system attributes and no payload-era ones", () => {
    expect(Object.keys(SYSTEM_ATTRIBUTES).sort()).toEqual(["$createdAt", "$creator", "$expiresAt", "$key", "$owner"]);
    const labels = completions.map((completion) => completion.label);
    for (const gone of ["$payload", "$contentType", "$updatedAt", "$creationFlags"]) expect(labels).not.toContain(gone);
    expect(labels).toContain("arkiv.schema");
    expect(labels).not.toContain("bytes()");
  });
});
