import { afterEach, expect, test } from "bun:test";
import { pinRange, rangeExamples, validateRangeResponse, verifyRange, RANGE_PROFILE } from "./src/rangeProofApi";
const identity = { sourceId: "source", runId: "run", genesisHash: "0x" + "11".repeat(32), chainId: "9009" };
const request = rangeExamples("100")[0].request;
const response = {
  identity, query: request, snapshot: {height:"100", hash: "0x"+"22".repeat(32), stateRoot: "0x"+"33".repeat(32)},
  verification: "proof verified against authenticated single-proposer header", verificationStatus: {status:"verified", profile:RANGE_PROFILE},
  certificateBytes:"0x1234", complete:true, proofProfile:RANGE_PROFILE, termCount:1, postingCount:1,
  rows:[{namespaceId:"1",recordId:"1",recordKey:"0x"+"44".repeat(32), expiresAtHeight:"1000",attributes:[{name:"$createdAt",type:"u64",value:"99"}],fields:[{name:"$payload",type:"bytes",byteLength:"10"}]}],
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("range examples pin exact bigint heights and boundary choices", () => {
  const examples = rangeExamples("9007199254740995");
  expect(examples[0].request.lower?.value).toBe("9007199254740993");
  expect(examples[1].request.lower?.value).toBe("9007199254740996");
  expect(examples[2].request.upper?.inclusive).toBe(false);
  expect(rangeExamples("1")[0].request.lower?.value).toBe("0");
  expect(pinRange({...request,height:"latest",lower:undefined},"120").height).toBe("120");
  expect(() => pinRange({...request,lower:undefined,upper:undefined},"100")).toThrow();
  expect(() => pinRange({...request,lower:{value:"-1",inclusive:true}},"100")).toThrow();
  expect(() => pinRange({...request,height:"101"},"100")).toThrow();
  expect(pinRange({...request,valueType:"dec",lower:{value:"-0001.200",inclusive:false}},"100").lower?.value).toBe("-1.2");
});
test("only bound complete responses and well-formed ordered metadata are shown", () => {
  expect(validateRangeResponse(response,identity,request).rows).toHaveLength(1);
  const changes: Array<(r:any)=>void> = [
    r=>r.identity.runId="other", r=>r.snapshot.height="99", r=>r.query.lower.inclusive=false,
    r=>r.query.upper.value="101", r=>r.query.attribute="other", r=>r.complete=false,
    r=>r.proofProfile="eq-page-v2", r=>r.verificationStatus.status="unverified", r=>r.termCount=0,
    r=>r.postingCount=2, r=>r.continuation="next", r=>r.certificateBytes="no",
    r=>r.rows[0].namespaceId="2", r=>r.rows[0].attributes=[null], r=>r.rows[0].fields=[{name:"x",type:"bytes",byteLength:{}}],
    r=>{r.rows.push({...r.rows[0]});r.postingCount=2;},
  ];
  for (const change of changes) { const next=structuredClone(response); change(next); expect(()=>validateRangeResponse(next,identity,request)).toThrow(); }
  expect(validateRangeResponse({...response,rows:[],termCount:0,postingCount:0},identity,request).complete).toBe(true);
});
test("range uses credential-free same-origin route and exact non-paged request", async () => {
  globalThis.fetch = (async (url:unknown, init:RequestInit) => {
    expect(url).toBe("/node-sim/v1/query/range/verified");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(JSON.parse(String(init.body))).not.toHaveProperty("limit");
    return Response.json(response);
  }) as typeof fetch;
  expect((await verifyRange(identity,request,new AbortController().signal)).complete).toBe(true);
});
