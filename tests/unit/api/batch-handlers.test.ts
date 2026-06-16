import { describe, expect, it, vi, afterEach } from "vitest";
import { handleBatchSubmitJob } from "../../../src/api/batch-handlers.js";
import {
  generateBatchJobInfo,
  generateBatchJobRequest,
} from "../../fixtures/mock-data.js";

describe("batch API handlers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("runs zero-cost preflight before submitting a batch job", async () => {
    const request = generateBatchJobRequest();
    const jobInfo = generateBatchJobInfo();
    const metadataClient = {
      getCost: vi.fn().mockResolvedValue({ total_cost: "0" }),
    };
    const batchClient = {
      submitJob: vi.fn().mockResolvedValue(jobInfo),
    };

    const result = await handleBatchSubmitJob(
      batchClient as any,
      metadataClient,
      request
    );

    expect(metadataClient.getCost).toHaveBeenCalledWith(
      expect.objectContaining({
        dataset: request.dataset,
        symbols: request.symbols,
        schema: request.schema,
        start: request.start,
        end: request.end,
      })
    );
    expect(batchClient.submitJob).toHaveBeenCalledWith(request);
    expect(result.content[0].text).toContain('"status": "submitted"');
  });

  it("refuses billable batch estimates before submit", async () => {
    const request = generateBatchJobRequest();
    const metadataClient = {
      getCost: vi.fn().mockResolvedValue({ total_cost: "0.01" }),
    };
    const batchClient = {
      submitJob: vi.fn(),
    };

    await expect(
      handleBatchSubmitJob(batchClient as any, metadataClient, request)
    ).rejects.toThrow("Databento estimated this covered Standard CME request as billable");

    expect(batchClient.submitJob).not.toHaveBeenCalled();
  });

  it("fails closed when called without a metadata getCost client", async () => {
    const request = generateBatchJobRequest();
    const batchClient = {
      submitJob: vi.fn(),
    };

    await expect(
      (handleBatchSubmitJob as any)(batchClient, request)
    ).rejects.toThrow("metadataClient with getCost is required for batch cost preflight");

    expect(batchClient.submitJob).not.toHaveBeenCalled();
  });
});
