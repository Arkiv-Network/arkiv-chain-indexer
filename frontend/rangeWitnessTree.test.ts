import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PatriciaProofVisualizer } from "./src/PatriciaProofVisualizer";
import { rangeChildExplanation, rangeNodeExplanation, rangeTreeWindow, rangeWitnessNodes, type ProofInspection, type RangePathNode, type RangeProofInspection } from "./src/patriciaProof";
import equality from "./fixtures/patricia/inclusion.json";
const hash = "0x"+"11".repeat(32);
const node = (index:number, changes:Partial<RangePathNode>={}):RangePathNode => ({index,proofIndex:index,depth:1,source:"hash",hash,rlp:"0xc0",kind:"leaf",compressedPath:"00",selectedNibble:null,children:[],valueBytes:"40",parentIndex:0,parentSlot:index.toString(16),prefix:index.toString(16),leaf:null,...changes});
// Synthetic graph to exercise presentation semantics; this is not a cryptographic fixture.
const nodes:RangePathNode[] = [
  node(0,{kind:"branch",depth:0,parentIndex:null,parentSlot:null,source:"root",prefix:"",compressedPath:"",children:Array.from({length:16},(_,i)=>({slot:i.toString(16),kind:i<3?"hash":"empty",...(i<3?{hash}:{}),decision:i<2?"open":i===2?"outside":"empty",childIndex:i<2?i+1:null}))}),
  node(1,{parentSlot:"0",prefix:"0",leaf:{key:"0x01",attribute:"score",valueType:"u64",value:"11",included:true,postingRoot:hash,postingCount:1}}),
  node(2,{parentSlot:"1",prefix:"1",leaf:{key:"0x10",attribute:"score",valueType:"u64",value:"20",included:false,postingRoot:hash,postingCount:1}}),
];
const fixture:RangeProofInspection = {...equality as ProofInspection,proofProfile:"range-complete-v1",postingSet:null,postingSets:[{method:"complete-set-reconstruction",termNodeIndex:1,termKey:"0x01",termValue:"11",termType:"u64",authenticatedRoot:hash,reconstructedRoot:hash,count:1,recordIds:["7"],selectedRecordIds:["7"],termPresent:true}],interval:{id:"terms:range",map:"terms",namespaceId:"1",root:hash,lowerKey:"0x01",upperKey:"0x09",lowerKeyNibbles:"01",upperKeyNibbles:"09",suppliedNodeCount:3,emptyReason:null,nodes}};
const render=(inspection:RangeProofInspection)=>renderToStaticMarkup(createElement(PatriciaProofVisualizer,{inspection}));
test("range visualizer extends state composition and defaults to true forks with linked witness labels",()=>{
  const html=render(fixture);
  expect(html).toContain("State commitment");
  expect(html).toContain("Catalog, rows &amp; keys");
  expect(html).toContain("Branching range proof tree");
  expect(html).toContain("Locate witness W0");
  expect(html).toContain("Locate witness W2");
  expect(html).toContain("slot 0 · open · hash");
  expect(html).toContain("slot 1 · open · hash");
  expect(html).toContain("Committed · not opened");
  expect(html).toContain("Boundary leaf · excluded");
  expect(html).toContain("u64(20)");
  expect(html).toContain("Inside range · included");
  expect(html).not.toContain("Equality completeness");
  expect(html).not.toContain('class="pv-path-node ');
});
test("inline nodes are visible but never gain a separate supplied W entry",()=>{
  const inline=node(1,{...nodes[1],source:"inline",proofIndex:0});
  const trace={...fixture,interval:{...fixture.interval,suppliedNodeCount:2,nodes:[nodes[0],inline,nodes[2]]}};
  expect(rangeWitnessNodes(trace.interval.nodes).map(n=>n.index)).toEqual([0,2]);
  const html=render(trace);
  expect(html).toContain("Inline in W0");
  expect(html).not.toContain("Locate witness W1");
});
test("empty and reversed intervals render no invented root node",()=>{
  for(const emptyReason of ["empty-root","reversed-bounds"] as const){
    const html=render({...fixture,postingSets:[],interval:{...fixture.interval,emptyReason,nodes:[],suppliedNodeCount:0}});
    expect(html).not.toContain("Locate witness W0");
    expect(html).not.toContain('class="rw-tree-node ');
    expect(html).toContain(emptyReason==="empty-root"?"canonical empty root":"lower encoded key exceeds the upper key");
  }
});
test("tree view keeps actual references and limits depth and visited-node count",()=>{
  const chain=Array.from({length:100},(_,i)=>node(i,{kind:"extension",children:i===99?[]:[{slot:null,kind:"hash",hash,decision:"open",childIndex:i+1}]}));
  expect([...rangeTreeWindow(chain,0)]).toEqual([0,1,2,3]);
  expect([...rangeTreeWindow(chain,40,100,12)]).toEqual(Array.from({length:12},(_,i)=>40+i));
  expect([...rangeTreeWindow(nodes,0)]).toEqual([0,1,2]);
  expect(rangeChildExplanation(nodes[0].children[2])).toContain("cannot intersect");
  expect(rangeChildExplanation(nodes[0].children[3])).toContain("different from an unopened hash");
  expect(rangeNodeExplanation(nodes[2])).toContain("contributes no result");
});

test("real inspected price witness opens 10 and 15 plus excluded 20 and starts at their fork",async()=>{
  const live = (await import("./fixtures/range-inspection/price.json")).default;
  const inspection = live.inspection as RangeProofInspection;
  const html = render(inspection);
  expect(html).toContain("Subtree at W7");
  expect(html).toContain("Locate witness W0");
  expect(html).toContain("Inspect range leaf W9");
  expect(html).toContain("Inspect range leaf W10");
  expect(html).toContain("Inspect range leaf W12");
  expect(html).toContain("Boundary u64(20) · excluded");
  expect(inspection.postingSets.map(term=>term.termValue)).toEqual(["10","15"]);
  expect(inspection.interval.nodes.find(node=>node.leaf?.value==="20")?.leaf?.included).toBe(false);
  expect(html).not.toContain("Inspect range branch W0");
});
