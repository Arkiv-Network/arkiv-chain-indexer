import { afterAll, describe, expect, test } from "bun:test";
import { AuthStorage } from "./authStorage";
import { openDb, type Db } from "./db";
import { TEST_ADMIN } from "./testAuth";
import { hasPostgresForTests, TEST_DATABASE_URL } from "./testPostgres";

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {for (const close of cleanup.reverse()) await close();});
async function isolated(): Promise<{store:AuthStorage;second:AuthStorage;db:Db;schema:string}> {
  const db = openDb(TEST_DATABASE_URL!,{max:4});
  const schema = `auth_test_${crypto.randomUUID().replaceAll("-","")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  const store = new AuthStorage(db,schema);await store.initialize();
  const secondDb = openDb(TEST_DATABASE_URL!,{max:2});
  cleanup.push(async () => {await secondDb.close();await db.query(`DROP SCHEMA "${schema}" CASCADE`);await db.close();});
  return {store,second:new AuthStorage(secondDb,schema),db,schema};
}

describe.skipIf(!hasPostgresForTests())("Postgres auth sessions (TEST_DATABASE_URL only)", () => {
  test("stable subjects, cross-instance sessions, revocation, disabled users and cleanup", async () => {
    const {store,second,db,schema} = await isolated();const now=Date.now();
    const user = await store.createSession(TEST_ADMIN,"hash-one","csrf",now+10000,null);
    const again = await second.createSession({...TEST_ADMIN,email:"renamed@golem.network"},"hash-two","csrf2",now+10000,"hash-one");
    expect(again?.id).toBe(user?.id);expect(again?.email).toBe("renamed@golem.network");
    expect(await store.getSession("hash-one",now)).toBeNull();
    expect((await store.getSession("hash-two",now))?.user.id).toBe(user?.id);
    await second.revokeSession("hash-two");expect(await store.getSession("hash-two",now)).toBeNull();
    await store.createSession(TEST_ADMIN,"expired","csrf",now-1,null);
    expect(await second.getSession("expired",now)).toBeNull();
    await second.cleanup(now);
    expect((await db.query(`SELECT * FROM "${schema}".auth_sessions`)).rowCount).toBe(0);
    await db.query(`UPDATE "${schema}".auth_users SET disabled_at=now()`);
    expect(await store.createSession(TEST_ADMIN,"disabled","csrf",now+1000,null)).toBeNull();
  });
  test("attempt consumption is atomic across backend instances and shared creation rates are bounded", async () => {
    const {store,second} = await isolated();const now=Date.now();
    const a={stateHash:"state",bindingHash:"browser",verifier:"verifier",nonce:"nonce",returnTo:"/data",expiresAt:now+1000};
    expect(await store.createAttempt(a,now)).toBe(true);
    expect(await second.consumeAttempt("state","wrong",now)).toBeNull();
    const results=await Promise.all([store.consumeAttempt("state","browser",now),second.consumeAttempt("state","browser",now)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await store.createAttempt({...a,stateHash:"expired",expiresAt:now-1},now);
    expect(await second.consumeAttempt("expired","browser",now)).toBeNull();
    const created=await Promise.all(Array.from({length:125},(_,i) => store.createAttempt({...a,stateHash:`rate-${i}`},now)));
    expect(created.filter(Boolean).length).toBe(118); // first two attempts share this minute
    await store.cleanup(now+1001);
  });
});

describe.skipIf(!hasPostgresForTests())("Postgres token login", () => {
  test("persists provider and token fingerprint across instances, keeps Google identities separate and migration is repeatable", async () => {
    const {store,second} = await isolated();const now=Date.now();
    const google = await store.createSession(TEST_ADMIN,"google","csrf",now+10000,null);
    await store.initialize();
    expect((await second.getSession("google",now))?.user.provider).toBe("google");
    const identity = {...TEST_ADMIN,provider:"token" as const,sub:"token:email-hash",emailVerified:false,hostedDomain:null};
    const token = await store.createSession(identity,"token-session","csrf",now+10000,null,"deployment-hash");
    expect(token?.id).not.toBe(google?.id);
    expect(await second.getSession("token-session",now)).toMatchObject({tokenLoginKeyHash:"deployment-hash",user:{provider:"token",emailVerified:false}});
    expect(await store.createSession({...identity,sub:TEST_ADMIN.sub},"collision","csrf",now+10000,null,"deployment-hash")).toBeNull();
    expect((await second.getSession("google",now))?.user.provider).toBe("google");
  });
  test("token and Google login share a rate limit across instances", async () => {
    const {store,second} = await isolated();const now=Date.now();
    const results = await Promise.all(Array.from({length:125},(_,i) => (i%2 ? store : second).allowTokenLoginAttempt(now)));
    expect(results.filter(Boolean)).toHaveLength(120);
    expect(await store.createAttempt({stateHash:"s",bindingHash:"b",verifier:"v",nonce:"n",returnTo:"/",expiresAt:now+60000},now)).toBe(false);
    expect(await second.allowTokenLoginAttempt(now+60000)).toBe(true);
  });
});

describe.skipIf(!hasPostgresForTests())("Postgres temporary access tokens", () => {
  test("stores only hashes, enforces 30 days, and shares revocation and owner state across instances",async()=>{
    const {store,second,db,schema}=await isolated(); const now=Date.now();
    const user=(await store.createSession(TEST_ADMIN,"session-hash","csrf",now+10000,null))!;
    const token={id:crypto.randomUUID(),name:"Scraper",createdAt:now,expiresAt:now+30*86400000,revokedAt:null};
    await store.createAccessToken(user.id,"access-hash",token,null);
    expect((await second.getAccessToken("access-hash",now))?.user.id).toBe(user.id);
    expect((await second.getAccessToken("access-hash",now))?.name).toBe("Scraper");
    expect(await second.listAccessTokens(user.id)).toEqual([token]);
    expect(await second.listAccessTokens(crypto.randomUUID())).toEqual([]);
    await second.revokeAccessToken(crypto.randomUUID(),token.id,now);
    expect(await store.getAccessToken("access-hash",now)).not.toBeNull();
    expect(await store.getAccessToken("access-hash",token.expiresAt)).toBeNull();
    await expect(store.createAccessToken(user.id,"too-long",{...token,id:crypto.randomUUID(),expiresAt:now+31*86400000},null)).rejects.toThrow();
    await db.query(`UPDATE "${schema}".auth_users SET disabled_at=now()`);
    expect(await second.getAccessToken("access-hash",now)).toBeNull();
    await db.query(`UPDATE "${schema}".auth_users SET disabled_at=NULL`);
    await second.revokeAccessToken(user.id,token.id,now);
    expect(await store.getAccessToken("access-hash",now)).toBeNull();
    expect((await store.listAccessTokens(user.id))[0]?.revokedAt).toBe(now);
    await store.initialize();
  });
});
