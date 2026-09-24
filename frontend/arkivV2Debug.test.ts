import { expect, test } from "bun:test";
import fixture from "./fixtures/node-debug/arkiv-v2.json";
import { ARKIV_EXAMPLES, pinSelection, validateInspectedPage } from "./src/nodeDebugApi";
import type { EqSelection, NativeIdentity } from "./src/simulatorApi";
const identity = {...fixture, capabilities:{profile:"arkiv-entity-v2"}} as NativeIdentity;
const request: EqSelection = {height:"3",namespace:"1",attribute:"group",valueType:"u64",value:"1",limit:3,cursor:null};
test("v2 decoded entity projections are bound to rows, snapshot and proof profile", () => {
  expect(validateInspectedPage(fixture,identity,request).entities).toHaveLength(3);
  for (const mutate of [
    (r:any)=>r.inspection.version=1,
    (r:any)=>r.inspection.proofProfile="eq-page-v1",
    (r:any)=>r.profile="generic-v1",
    (r:any)=>r.entities[0].owner="0x"+"b0".repeat(20),
    (r:any)=>r.entities[0].updatedAt="100",
    (r:any)=>r.entities[0].createdAt="3",
    (r:any)=>r.entities[0].expiresAt="3",
    (r:any)=>r.entities[0].creationFlags.raw=4,
    (r:any)=>r.entities[0].creationFlags.readonly=true,
    (r:any)=>r.entities.pop(),
  ]) {const r=structuredClone(fixture);mutate(r);expect(()=>validateInspectedPage(r,identity,request)).toThrow();}
  expect(()=>validateInspectedPage(fixture,{sourceId:fixture.sourceId,runId:fixture.runId,genesisHash:fixture.genesisHash,chainId:fixture.chainId},request)).toThrow("ProofProfileMismatch");
});
test("new numeric types normalize without loss and reject overflows", () => {
  const value=(valueType:EqSelection["valueType"],v:string)=>pinSelection({...request,valueType,value:v},"100").value;
  expect(value("u256",((1n<<256n)-1n).toString())).toBe(((1n<<256n)-1n).toString());
  expect(()=>value("u256",(1n<<256n).toString())).toThrow();
  expect(value("i32","-2147483648")).toBe("-2147483648");
  expect(()=>value("i32","2147483648")).toThrow();
  expect(value("dec","-12.345678901234567890")).toBe("-12.34567890123456789");
  expect(value("dec","-0.000")).toBe("0");
  expect(()=>value("dec","0.1234567890123456789")).toThrow();
  expect(value("addr","0x"+"AB".repeat(20))).toBe("0x"+"ab".repeat(20));
  expect(()=>value("key","0x"+"ab".repeat(20))).toThrow();
  expect(ARKIV_EXAMPLES.every(s=>pinSelection(s.request,"100").height===s.request.height)).toBe(true);
});
