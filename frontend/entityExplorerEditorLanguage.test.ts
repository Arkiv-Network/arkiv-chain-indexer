import { describe, expect, test } from "bun:test";
import { completions, SYSTEM_ATTRIBUTES } from "./src/entityExplorer/lib/editorLanguage";

describe("query editor completions", () => {
  test("offer the UDC node's queryable system attributes and no payload-era ones", () => {
    expect(Object.keys(SYSTEM_ATTRIBUTES).sort()).toEqual(["$createdAt", "$creator", "$expiresAt", "$key", "$owner"]);
    const labels = completions.map((completion) => completion.label);
    for (const gone of ["$payload", "$contentType", "$updatedAt", "$creationFlags"]) expect(labels).not.toContain(gone);
    expect(labels.filter((label) => label === "arkiv.schema")).toHaveLength(1);
    expect(labels).not.toContain("bytes()");
    // Booleans are written bare: the node refuses bool(true).
    expect(labels).not.toContain("bool()");
    expect(labels).toContain("true");
  });
});
