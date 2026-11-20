import {describe,it,expect} from "vitest";
import {validateCostControl,validateCostSummary,COST_BASIS} from "../../../src/api/platform-cost.js";
const control={reservation_id:"a".repeat(32),allowance_usd:10};
describe("private cost report contract",()=>{
  it("rejects unsupported allowance ranges",()=>{
    for(const allowance_usd of [1_000_000.000001,Infinity,NaN,-1])
      expect(()=>validateCostControl({...control,allowance_usd})).toThrow();
    expect(validateCostControl({...control,allowance_usd:1_000_000})).toBeDefined();
  });
  it("requires a bounded amount strictly over the lease when approval is required",()=>{
    const summary={reservation_id:control.reservation_id,estimated_spent_usd:0,approval_required:true,basis:COST_BASIS};
    for(const required_allowance_usd of [undefined,0,10,1_000_000.000001,Infinity,NaN])
      expect(()=>validateCostSummary({...summary,required_allowance_usd},control)).toThrow();
    expect(validateCostSummary({...summary,required_allowance_usd:11},control).required_allowance_usd).toBe(11);
  });
  it("distinguishes subscription-covered requests from monetary estimates",()=>{
    const summary={reservation_id:control.reservation_id,estimated_spent_usd:0,approval_required:false,basis:COST_BASIS};
    expect(validateCostSummary({...summary,subscription_covered_requests:2},control).subscription_covered_requests).toBe(2);
    for(const subscription_covered_requests of [-1,1.5,NaN,Infinity,10001,"1",null])
      expect(()=>validateCostSummary({...summary,subscription_covered_requests},control)).toThrow();
  });
});
