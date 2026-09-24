import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PatriciaProofVisualizer } from "./src/PatriciaProofVisualizer";
import { describeTerminal, nodeNibbleSpan, PATRICIA_NODE_PAGE_SIZE, siblingCommitments, type PatriciaPointPath, type ProofInspection } from "./src/patriciaProof";
import inclusionFixture from "./fixtures/patricia/inclusion.json";
import absenceFixture from "./fixtures/patricia/absence.json";

// Real canonical witnesses from arkiv-db's strict verifier via examples/inspect_eq.
// These are inspection output only: the UI must not perform a second, weaker verifier.
const inclusion = inclusionFixture as ProofInspection;
const absence = absenceFixture as ProofInspection;
const render = (inspection: ProofInspection) => renderToStaticMarkup(createElement(PatriciaProofVisualizer, { inspection }));

describe("actual Patricia witness presentation", () => {
  test("renders only visited nodes and clearly separates equality completeness", () => {
    const terms = inclusion.pointPaths.find((path) => path.map === "terms")!;
    const html = render(inclusion);
    expect((html.match(/class="pv-path-node /g) ?? []).length).toBe(terms.nodes.length);
    expect(html).toContain(inclusion.stateComposition.stateRoot);
    expect(html).toContain(inclusion.postingSet!.reconstructedRoot);
    expect(html).toContain("Complete posting set");
    expect(html).toContain("Point inclusion alone cannot establish");
    expect(html).toContain("their undisclosed subtrees are not drawn");
    expect(html).toContain("Source: node&#x27;s strict verifier trace");
  });

  test("branch sibling references exclude the selected child and do not invent nodes", () => {
    const path = inclusion.pointPaths.find((path) => path.map === "terms")!;
    const branch = path.nodes.find((node) => node.kind === "branch")!;
    expect(branch.children).toHaveLength(16);
    const siblings = siblingCommitments(branch);
    expect(siblings).toHaveLength(1);
    expect(siblings[0].slot).toBe("0");
    expect(siblings[0].hash).toBe(branch.children[0].hash);
    expect(path.nodes.some((node) => node.hash === siblings[0].hash)).toBe(false);
    expect(nodeNibbleSpan(branch)).toBe(1);
  });

  test("retains inline visited nodes without counting them as separately supplied witness bytes", () => {
    const path = inclusion.pointPaths.find((item) => item.nodes.some((node) => node.source === "inline"))!;
    expect(path).toBeDefined();
    const html = render({ ...inclusion, pointPaths: [path] });
    expect(html).toContain("embedded RLP");
    expect(html).toContain(`${path.nodes.length} visited · ${path.suppliedNodeCount} supplied`);
    expect((html.match(/class="pv-path-node /g) ?? []).length).toBe(path.nodes.length);
    expect(path.nodes.length).toBeGreaterThan(path.suppliedNodeCount);
  });

  test("renders authenticated divergence as absence, including the empty posting set", () => {
    const html = render(absence);
    expect(html).toContain("Divergent leaf · absence");
    expect(html).toContain("authenticated divergence proves absence");
    expect(html).toContain("Term absence path");
    expect(html).toContain("The complete posting set is empty");
    expect(html).not.toContain("Matching leaf · inclusion");
  });

  test("empty roots render no invented root or leaf node", () => {
    const original = absence.pointPaths[0];
    const path: PatriciaPointPath = {
      ...original,
      nodes: [],
      suppliedNodeCount: 0,
      root: absence.stateComposition.host.root,
      terminal: { kind: "absence", reason: "empty-root" },
    };
    const html = render({ ...absence, stateComposition: { ...absence.stateComposition, namespace: null }, pointPaths: [path], postingSet: null });
    expect(html).toContain("No nodes to traverse");
    expect(html).toContain("namespace absence path terminates");
    expect(html).not.toContain('class="pv-path-node ');
    expect(html).not.toContain("Term index");
  });

  test("all genuine terminal reasons have explicit inclusion or absence explanations", () => {
    const path = absence.pointPaths[1];
    for (const reason of ["empty-root", "empty-branch-slot", "divergent-leaf", "divergent-extension"] as const) {
      expect(describeTerminal({ ...path, terminal: { kind: "absence", reason } })).toContain("absence");
    }
    expect(describeTerminal({ ...path, terminal: { kind: "inclusion", reason: "leaf-match" } })).toContain("included");
  });

  test("large trace DOM is paged and explicitly labels the visible window", () => {
    const path = inclusion.pointPaths[1];
    // Synthetic repetition exercises rendering bounds, not cryptographic validity.
    const nodes = Array.from({ length: 130 }, (_, index) => ({ ...path.nodes[0], index }));
    const html = render({ ...inclusion, pointPaths: [{ ...path, nodes }] });
    expect((html.match(/class="pv-path-node /g) ?? []).length).toBe(PATRICIA_NODE_PAGE_SIZE);
    expect(html).toContain(`Nodes 1–${PATRICIA_NODE_PAGE_SIZE} of 130`);
    expect(html).not.toContain("Matching leaf · inclusion");
  });
});
