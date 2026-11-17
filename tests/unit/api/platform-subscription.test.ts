import {createHash} from "node:crypto";
import {describe,expect,it} from "vitest";
import {isStandardCmeHistoricalCovered,validatePlatformSubscription} from "../../../src/api/platform-subscription.js";

const apiKey="db-subscription-fixture";
const subscription={plan:"cme_standard" as const,policy_version:1 as const,
  credential_sha256:createHash("sha256").update(apiKey).digest("hex")};
const now=new Date("2026-11-17T14:18:33.123Z");
const request={dataset:"GLBX.MDP3",schema:"trades",start:"2026-11-16",end:"2026-11-17"};

describe("authenticated CME Standard historical subscription",()=>{
  it("binds the exact versioned assertion to this credential and historical tools only",()=>{
    expect(validatePlatformSubscription(subscription,apiKey,"timeseries_get_range")).toEqual(subscription);
    expect(validatePlatformSubscription(undefined,undefined,"get_session_info")).toBeUndefined();
    for(const value of [null,[],{}, {...subscription,plan:"cme_plus"},{...subscription,policy_version:2},
      {...subscription,credential_sha256:subscription.credential_sha256.toUpperCase()},
      {...subscription,credential_sha256:"0".repeat(64)},{...subscription,active:true}])
      expect(()=>validatePlatformSubscription(value,apiKey,"timeseries_get_range")).toThrow();
    for(const tool of ["get_live_futures_quote","metadata_get_cost","get_session_info","batch_submit_job"])
      expect(()=>validatePlatformSubscription(subscription,apiKey,tool)).toThrow();
    expect(()=>validatePlatformSubscription(subscription,"db-rotated-key","timeseries_get_range")).toThrow();
    expect(()=>validatePlatformSubscription(subscription,undefined,"timeseries_get_range")).toThrow();
  });
  it.each(["ohlcv-1s","ohlcv-1m","ohlcv-1h","ohlcv-1d","definition","statistics","status"])(
    "covers all available old L0 %s history with a closed nonfuture interval",schema=>{
      expect(isStandardCmeHistoricalCovered({...request,schema,start:"2010-01-01"},now)).toBe(true);
    });
  it.each(["trades","mbp-1","tbbo","bbo-1s","bbo-1m"])("uses an exact 12-month boundary for %s",schema=>{
    expect(isStandardCmeHistoricalCovered({...request,schema,start:"2025-11-17T14:18:33.123000000Z"},now)).toBe(true);
    expect(isStandardCmeHistoricalCovered({...request,schema,start:"2025-11-17T14:18:33.122999999Z"},now)).toBe(false);
    expect(isStandardCmeHistoricalCovered({...request,schema,start:"2025-11-17"},now)).toBe(false);
  });
  it.each(["mbp-10","mbo"])("uses an exact calendar month for %s",schema=>{
    expect(isStandardCmeHistoricalCovered({...request,schema,start:"2026-10-17T14:18:33.123Z"},now)).toBe(true);
    expect(isStandardCmeHistoricalCovered({...request,schema,start:"2026-10-17T14:18:33.122999999Z"},now)).toBe(false);
    expect(isStandardCmeHistoricalCovered({...request,schema,start:"2026-02-28T15:00:00Z",end:"2026-03-01"},
      new Date("2026-03-31T15:00:00Z"))).toBe(true);
  });
  it("normalizes timezone offsets without discarding sub-millisecond precision",()=>{
    expect(isStandardCmeHistoricalCovered({...request,start:"2025-11-17T17:18:33.123+03:00"},now)).toBe(true);
    expect(isStandardCmeHistoricalCovered({...request,start:"2025-11-17T17:18:33.122999999+03:00"},now)).toBe(false);
    expect(isStandardCmeHistoricalCovered({...request,start:"2025-11-17T14:18:33.123"},now)).toBe(true);
  });
  it("classifies internal unsigned nanosecond ranges exactly without Number precision loss",()=>{
    const boundary=BigInt(Date.parse("2025-11-17T14:18:33.123Z"))*1_000_000n;
    const end=(BigInt(now.getTime())*1_000_000n).toString();
    expect(isStandardCmeHistoricalCovered({...request,start:boundary.toString(),end},now)).toBe(true);
    expect(isStandardCmeHistoricalCovered({...request,start:(boundary-1n).toString(),end},now)).toBe(false);
    for(const start of ["-1","+1790000000000000000","1e18","18446744073709551616","1".repeat(5000)])
      expect(isStandardCmeHistoricalCovered({...request,start,end},now)).toBe(false);
  });
  it("covers the documented date-only forward-filled day but not an unbounded or future interval",()=>{
    expect(isStandardCmeHistoricalCovered({...request,schema:"ohlcv-1d",start:"2010-01-01",end:undefined},now)).toBe(true);
    expect(isStandardCmeHistoricalCovered({...request,end:undefined},now)).toBe(true);
    expect(isStandardCmeHistoricalCovered({...request,start:"2026-11-17",end:undefined},now)).toBe(false);
    expect(isStandardCmeHistoricalCovered({...request,start:"2026-11-16T00:00:00Z",end:undefined},now)).toBe(false);
  });
  it("fails closed on unknown datasets/schemas, omitted end, malformed and future intervals",()=>{
    for(const changes of [{dataset:"XNAS.ITCH"},{dataset:" GLBX.MDP3"},{schema:"cmbp-1"},{schema:"unknown"},
      {start:"2026-11-16T00:00:00Z",end:undefined},{end:"2026-11-17T14:18:33.123000001Z"},{start:"2027-01-01"},
      {start:"2026-02-30"},{end:"2026-11-15"},{start:"1790000000000000000",end:undefined},
      {start:"2026-11-16T00:00:00.0000000001Z"},{start:"2026-11-16T25:00:00Z"}])
      expect(isStandardCmeHistoricalCovered({...request,...changes},now)).toBe(false);
    expect(isStandardCmeHistoricalCovered(request,new Date(NaN))).toBe(false);
  });
});
