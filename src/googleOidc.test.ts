import { beforeAll, describe, expect, test, setSystemTime } from "bun:test";
import * as oidc from "openid-client";
import { GoogleOidcProvider } from "./googleOidc";
import { TEST_AUTH_CONFIG } from "./testAuth";
import type { LoginAttempt } from "./authStorage";

let keys: CryptoKeyPair;
let rotated: CryptoKeyPair;
beforeAll(async () => {
  const algorithm = {name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"};
  [keys,rotated] = await Promise.all([crypto.subtle.generateKey(algorithm,true,["sign","verify"]),crypto.subtle.generateKey(algorithm,true,["sign","verify"])]) as CryptoKeyPair[] as [CryptoKeyPair,CryptoKeyPair];
});
const attempt: LoginAttempt = {stateHash:"",bindingHash:"",verifier:"a".repeat(43),nonce:"expected-nonce",returnTo:"/",expiresAt:Date.now()+600_000};
const callback = new URL(`${TEST_AUTH_CONFIG.publicOrigin}/api/auth/google/callback?state=state&code=code`);
function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
async function fixture(overrides: Record<string,unknown> = {}, badSignature = false) {
  let currentKeys = keys;
  let kid = "first";
  let jwksRequests = 0;
  const customFetch: NonNullable<oidc.DiscoveryRequestOptions[typeof oidc.customFetch]> = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({
      issuer:"https://accounts.google.com",authorization_endpoint:"https://accounts.google.com/authorize",
      token_endpoint:"https://oauth2.googleapis.com/token",jwks_uri:"https://www.googleapis.com/jwks",
      response_types_supported:["code"],subject_types_supported:["public"],id_token_signing_alg_values_supported:["RS256"],
    });
    if (url === "https://www.googleapis.com/jwks") {
      jwksRequests++;
      return Response.json({keys:[{...await crypto.subtle.exportKey("jwk",currentKeys.publicKey),kid,alg:"RS256",use:"sig"}]});
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const now = Math.floor(Date.now()/1000);
      const claims = {iss:"https://accounts.google.com",aud:TEST_AUTH_CONFIG.clientId,sub:"google-sub",iat:now,exp:now+300,
        nonce:attempt.nonce,email:"sieciech.czajka@golem.network",email_verified:true,hd:"golem.network",name:"Test Admin",...overrides};
      const signingInput = `${encode({alg:"RS256",kid})}.${encode(claims)}`;
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5",badSignature ? rotated.privateKey : currentKeys.privateKey,new TextEncoder().encode(signingInput));
      return Response.json({access_token:"discarded-access-token",token_type:"Bearer",expires_in:300,id_token:`${signingInput}.${Buffer.from(signature).toString("base64url")}`});
    }
    throw new Error("Unexpected outbound request in offline OIDC test");
  };
  return {provider:new GoogleOidcProvider(TEST_AUTH_CONFIG,{[oidc.customFetch]:customFetch}),
    rotate() {currentKeys=rotated;kid="second";},jwksRequests:() => jwksRequests};
}

describe("real OIDC validation with offline discovery and signed tokens", () => {
  test("constructs PKCE, state and nonce authorization and validates signed Google identity", async () => {
    const {provider} = await fixture();
    const url = new URL(await provider.authorizationUrl("state",attempt));
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe(attempt.nonce);
    expect(url.searchParams.get("redirect_uri")).toBe(`${TEST_AUTH_CONFIG.publicOrigin}/api/auth/google/callback`);
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect((await provider.authenticate(callback,"state",attempt)).hostedDomain).toBe("golem.network");
  });
  for (const [name,overrides] of Object.entries({issuer:{iss:"https://evil.test"},audience:{aud:"another-client"},
    expiry:{exp:1},nonce:{nonce:"wrong"},subject:{sub:""},azp:{azp:"another-client"},missingNonce:{nonce:undefined}})) {
    test(`rejects invalid ${name}`, async () => {
      const {provider} = await fixture(overrides);
      await expect(provider.authenticate(callback,"state",attempt)).rejects.toThrow();
    });
  }
  test("rejects invalid cryptographic signature even for TLS token endpoint responses", async () => {
    const {provider} = await fixture({},true);
    await expect(provider.authenticate(callback,"state",attempt)).rejects.toThrow();
  });
  test("refreshes JWKS when Google rotates signing keys", async () => {
    const f = await fixture();
    await f.provider.authenticate(callback,"state",attempt);
    f.rotate();
    // oauth4webapi throttles unknown-kid refreshes for 60 seconds to resist JWKS-fetch abuse.
    setSystemTime(new Date(Date.now()+61_000));
    try {
      await f.provider.authenticate(callback,"state",attempt);
      expect(f.jwksRequests()).toBe(2);
    } finally { setSystemTime(); }
  });
});
