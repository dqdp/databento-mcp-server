/**
 * Unit tests for BatchClient
 * Tests batch job submission, listing, and download operations
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BatchClient } from "../../../src/api/batch-client.js";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";
import {
  generateBatchJobRequest,
  generateBatchJobInfo,
  generateJSONResponse,
} from "../../fixtures/mock-data.js";
import type { BatchJobRequest, BatchJobInfo, BatchJobState } from "../../../src/types/batch.js";

describe("BatchClient", () => {
  let mockHTTP: DataBentoHTTP;
  let batchClient: BatchClient;

  beforeEach(() => {
    // Create a real HTTP instance with mocked methods
    mockHTTP = new DataBentoHTTP("db-test-api-key-12345");
    vi.spyOn(mockHTTP, "postForm").mockResolvedValue("");
    vi.spyOn(mockHTTP, "get").mockResolvedValue("");
    vi.spyOn(mockHTTP, "getBaseUrl").mockReturnValue("https://hist.databento.com");

    batchClient = new BatchClient(mockHTTP);
  });

  describe("submitJob", () => {
    it("should submit a valid batch job request", async () => {
      const jobRequest = generateBatchJobRequest();
      const jobInfo = generateBatchJobInfo({ state: "received" });
      const mockResponse = generateJSONResponse(jobInfo);

      vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      const result = await batchClient.submitJob(jobRequest);

      expect(result).toEqual(jobInfo);
      expect(mockHTTP.postForm).toHaveBeenCalledWith(
        "/v0/batch.submit_job",
        expect.objectContaining({
          dataset: jobRequest.dataset,
          symbols: jobRequest.symbols,
          schema: jobRequest.schema,
          start: jobRequest.start,
        }),
        { retry: false }
      );
    });

    it("should include optional parameters when provided", async () => {
      const jobRequest = generateBatchJobRequest({
        end: "2024-01-31",
        encoding: "csv",
        compression: "gzip",
        stype_in: "raw_symbol",
        stype_out: "instrument_id",
        split_duration: "day",
        split_size: 1000000,
        split_symbols: true,
        limit: 5000,
        ts_out: true,
      });
      const jobInfo = generateBatchJobInfo();
      const mockResponse = generateJSONResponse(jobInfo);

      vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await batchClient.submitJob(jobRequest);

      expect(mockHTTP.postForm).toHaveBeenCalledWith(
        "/v0/batch.submit_job",
        expect.objectContaining({
          end: "2024-01-31",
          encoding: "csv",
          compression: "gzip",
          stype_in: "raw_symbol",
          stype_out: "instrument_id",
          split_duration: "day",
          split_size: 1000000,
          split_symbols: true,
          limit: 5000,
          ts_out: true,
        }),
        { retry: false }
      );
    });

    it("should throw error if dataset is missing", async () => {
      const jobRequest = { ...generateBatchJobRequest(), dataset: "" };

      await expect(batchClient.submitJob(jobRequest)).rejects.toThrow(
        "Dataset is required"
      );
    });

    it("should throw error if symbols array is empty", async () => {
      const jobRequest = generateBatchJobRequest({ symbols: [] });

      await expect(batchClient.submitJob(jobRequest)).rejects.toThrow(
        "At least one symbol is required"
      );
    });

    it("should throw error if symbols exceed 2000 limit", async () => {
      const symbols = Array.from({ length: 2001 }, (_, i) => `SYM${i}`);
      const jobRequest = generateBatchJobRequest({ symbols });

      await expect(batchClient.submitJob(jobRequest)).rejects.toThrow(
        "Maximum 2,000 symbols allowed per batch job"
      );
    });

    it("should allow exactly 2000 symbols", async () => {
      const symbols = Array.from({ length: 2000 }, (_, i) => `SYM${i}`);
      const jobRequest = generateBatchJobRequest({ symbols });
      const jobInfo = generateBatchJobInfo();
      const mockResponse = generateJSONResponse(jobInfo);

      vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      const result = await batchClient.submitJob(jobRequest);

      expect(result).toEqual(jobInfo);
    });

    it("should throw error if schema is missing", async () => {
      const jobRequest = { ...generateBatchJobRequest(), schema: "" as any };

      await expect(batchClient.submitJob(jobRequest)).rejects.toThrow(
        "Schema is required"
      );
    });

    it("should throw error if start date is missing", async () => {
      const jobRequest = { ...generateBatchJobRequest(), start: "" };

      await expect(batchClient.submitJob(jobRequest)).rejects.toThrow(
        "Start date is required"
      );
    });

    it("should validate start date format (YYYY-MM-DD)", async () => {
      const jobRequest = generateBatchJobRequest({ start: "invalid-date" });

      await expect(batchClient.submitJob(jobRequest)).rejects.toThrow(
        "Start date must be in YYYY-MM-DD or ISO 8601 format"
      );
    });

    it("should accept ISO 8601 start date format", async () => {
      const jobRequest = generateBatchJobRequest({
        start: "2024-01-01T00:00:00Z",
      });
      const jobInfo = generateBatchJobInfo();
      const mockResponse = generateJSONResponse(jobInfo);

      vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      const result = await batchClient.submitJob(jobRequest);

      expect(result).toEqual(jobInfo);
    });

    it("should validate end date format if provided", async () => {
      const jobRequest = generateBatchJobRequest({ end: "invalid-date" });

      await expect(batchClient.submitJob(jobRequest)).rejects.toThrow(
        "End date must be in YYYY-MM-DD or ISO 8601 format"
      );
    });

    it("should accept valid YYYY-MM-DD end date", async () => {
      const jobRequest = generateBatchJobRequest({ end: "2024-01-31" });
      const jobInfo = generateBatchJobInfo();
      const mockResponse = generateJSONResponse(jobInfo);

      vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      const result = await batchClient.submitJob(jobRequest);

      expect(result).toEqual(jobInfo);
    });

    it("should handle form-encoded data correctly", async () => {
      const jobRequest = generateBatchJobRequest({
        symbols: ["ES.FUT", "NQ.FUT", "YM.FUT"],
      });
      const jobInfo = generateBatchJobInfo();
      const mockResponse = generateJSONResponse(jobInfo);

      vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await batchClient.submitJob(jobRequest);

      // Verify postForm is called (symbols will be joined by HTTP client)
      expect(mockHTTP.postForm).toHaveBeenCalledWith(
        "/v0/batch.submit_job",
        expect.objectContaining({
          symbols: ["ES.FUT", "NQ.FUT", "YM.FUT"],
        }),
        { retry: false }
      );
    });

    it("should propagate HTTP errors", async () => {
      const jobRequest = generateBatchJobRequest();
      const error = new Error("HTTP 500: Internal Server Error");

      vi.spyOn(mockHTTP, "postForm").mockRejectedValue(error);

      await expect(batchClient.submitJob(jobRequest)).rejects.toThrow(
        "HTTP 500: Internal Server Error"
      );
    });

    it("should not include undefined optional parameters", async () => {
      const jobRequest = generateBatchJobRequest({
        end: undefined,
        encoding: undefined,
        compression: undefined,
      });
      const jobInfo = generateBatchJobInfo();
      const mockResponse = generateJSONResponse(jobInfo);

      const postFormSpy = vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await batchClient.submitJob(jobRequest);

      const callArgs = postFormSpy.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty("end");
      expect(callArgs).not.toHaveProperty("encoding");
      expect(callArgs).not.toHaveProperty("compression");
    });

    it("should include split_symbols when false", async () => {
      const jobRequest = generateBatchJobRequest({ split_symbols: false });
      const jobInfo = generateBatchJobInfo();
      const mockResponse = generateJSONResponse(jobInfo);

      const postFormSpy = vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await batchClient.submitJob(jobRequest);

      const callArgs = postFormSpy.mock.calls[0][1];
      expect(callArgs).toHaveProperty("split_symbols", false);
    });

    it("should include ts_out when false", async () => {
      const jobRequest = generateBatchJobRequest({ ts_out: false });
      const jobInfo = generateBatchJobInfo();
      const mockResponse = generateJSONResponse(jobInfo);

      const postFormSpy = vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await batchClient.submitJob(jobRequest);

      const callArgs = postFormSpy.mock.calls[0][1];
      expect(callArgs).toHaveProperty("ts_out", false);
    });
  });

  describe("listJobs", () => {
    it("should list all jobs when no filters provided", async () => {
      const jobs = [
        generateBatchJobInfo({ state: "done" }),
        generateBatchJobInfo({ state: "processing" }),
        generateBatchJobInfo({ state: "queued" }),
      ];
      const mockResponse = generateJSONResponse(jobs);

      vi.spyOn(mockHTTP, "get").mockResolvedValue(mockResponse);

      const result = await batchClient.listJobs();

      expect(result).toEqual(jobs);
      expect(mockHTTP.get).toHaveBeenCalledWith("/v0/batch.list_jobs", {});
    });

    it("should filter jobs by single state", async () => {
      const jobs = [generateBatchJobInfo({ state: "done" })];
      const mockResponse = generateJSONResponse(jobs);

      vi.spyOn(mockHTTP, "get").mockResolvedValue(mockResponse);

      const result = await batchClient.listJobs({ states: ["done"] });

      expect(result).toEqual(jobs);
      expect(mockHTTP.get).toHaveBeenCalledWith("/v0/batch.list_jobs", {
        states: "done",
      });
    });

    it("should filter jobs by multiple states", async () => {
      const jobs = [
        generateBatchJobInfo({ state: "done" }),
        generateBatchJobInfo({ state: "processing" }),
      ];
      const mockResponse = generateJSONResponse(jobs);

      vi.spyOn(mockHTTP, "get").mockResolvedValue(mockResponse);

      const result = await batchClient.listJobs({
        states: ["done", "processing"],
      });

      expect(result).toEqual(jobs);
      expect(mockHTTP.get).toHaveBeenCalledWith("/v0/batch.list_jobs", {
        states: "done,processing",
      });
    });

    it("should filter jobs by since timestamp", async () => {
      const jobs = [generateBatchJobInfo()];
      const mockResponse = generateJSONResponse(jobs);

      vi.spyOn(mockHTTP, "get").mockResolvedValue(mockResponse);

      const sinceDate = "2024-01-01T00:00:00Z";
      const result = await batchClient.listJobs({ since: sinceDate });

      expect(result).toEqual(jobs);
      expect(mockHTTP.get).toHaveBeenCalledWith("/v0/batch.list_jobs", {
        since: sinceDate,
      });
    });

    it("should filter jobs by both states and since", async () => {
      const jobs = [generateBatchJobInfo({ state: "done" })];
      const mockResponse = generateJSONResponse(jobs);

      vi.spyOn(mockHTTP, "get").mockResolvedValue(mockResponse);

      const sinceDate = "2024-01-01T00:00:00Z";
      const result = await batchClient.listJobs({
        states: ["done"],
        since: sinceDate,
      });

      expect(result).toEqual(jobs);
      expect(mockHTTP.get).toHaveBeenCalledWith("/v0/batch.list_jobs", {
        states: "done",
        since: sinceDate,
      });
    });

    it("should handle empty job list", async () => {
      const mockResponse = generateJSONResponse([]);

      vi.spyOn(mockHTTP, "get").mockResolvedValue(mockResponse);

      const result = await batchClient.listJobs();

      expect(result).toEqual([]);
    });

    it("should not include states parameter when empty array", async () => {
      const jobs = [generateBatchJobInfo()];
      const mockResponse = generateJSONResponse(jobs);

      const getSpy = vi.spyOn(mockHTTP, "get").mockResolvedValue(mockResponse);

      await batchClient.listJobs({ states: [] });

      const callArgs = getSpy.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty("states");
    });

    it("should propagate HTTP errors", async () => {
      const error = new Error("HTTP 401: Unauthorized");

      vi.spyOn(mockHTTP, "get").mockRejectedValue(error);

      await expect(batchClient.listJobs()).rejects.toThrow(
        "HTTP 401: Unauthorized"
      );
    });
  });

  describe("getDownloadInfo", () => {
    it("should return download info for completed job", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "done",
        record_count: 50000,
        file_count: 1,
        package_size: 2048000,
        ts_expiration: "2024-02-01T00:00:00Z",
        encoding: "dbn",
        compression: "zstd",
      });
      const files = [
        {
          filename: "test-job-123.dbn.zst",
          size: 2048000,
          hash: "sha256:test",
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/test-job-123.dbn.zst",
            ftp: "ftp://ftp.databento.com/user/test-job-123/test-job-123.dbn.zst",
          },
        },
      ];

      vi.spyOn(mockHTTP, "get")
        .mockResolvedValueOnce(generateJSONResponse(job))
        .mockResolvedValueOnce(generateJSONResponse(files));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(mockHTTP.get).toHaveBeenNthCalledWith(1, "/v0/batch.get_job_details", {
        job_id: jobId,
      });
      expect(mockHTTP.get).toHaveBeenNthCalledWith(2, "/v0/batch.list_files", {
        job_id: jobId,
      });
      expect(result.job_id).toBe(jobId);
      expect(result.state).toBe("done");
      expect(result.download_info).toBeDefined();
      expect(result.download_info?.id).toBe(jobId);
      expect(result.download_info?.download_url).toBe(
        "https://api.databento.com/v0/batch/download/user/test-job-123/test-job-123.dbn.zst"
      );
      expect(result.download_info?.download_urls).toEqual([
        "https://api.databento.com/v0/batch/download/user/test-job-123/test-job-123.dbn.zst",
      ]);
      expect(result.download_info?.files).toEqual(files);
      expect(result.download_info?.filenames).toEqual(["test-job-123.dbn.zst"]);
      expect(result.download_info?.record_count).toBe(50000);
      expect(result.download_info?.file_count).toBe(1);
      expect(result.download_info?.total_size).toBe(2048000);
      expect(result.message).toContain("completed successfully");
    });

    it("should return status message for received job", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "received",
      });
      vi.spyOn(mockHTTP, "get").mockResolvedValue(generateJSONResponse(job));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.job_id).toBe(jobId);
      expect(result.state).toBe("received");
      expect(result.download_info).toBeUndefined();
      expect(result.message).toContain("received and pending validation");
    });

    it("should return status message for queued job", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "queued",
        ts_queued: "2024-01-01T00:01:00Z",
      });
      vi.spyOn(mockHTTP, "get").mockResolvedValue(generateJSONResponse(job));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.job_id).toBe(jobId);
      expect(result.state).toBe("queued");
      expect(result.download_info).toBeUndefined();
      expect(result.message).toContain("queued for processing");
    });

    it("should return status message for processing job", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "processing",
        ts_process_start: "2024-01-01T00:02:00Z",
      });
      vi.spyOn(mockHTTP, "get").mockResolvedValue(generateJSONResponse(job));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.job_id).toBe(jobId);
      expect(result.state).toBe("processing");
      expect(result.download_info).toBeUndefined();
      expect(result.message).toContain("currently being processed");
    });

    it("should handle job not found", async () => {
      const jobId = "nonexistent-job";

      vi.spyOn(mockHTTP, "get").mockRejectedValue(new Error("HTTP 404: Not Found"));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.job_id).toBe(jobId);
      expect(result.state).toBe("expired");
      expect(result.error).toBe("Job not found");
      expect(result.message).toContain("not found");
    });

    it("should throw error for empty job ID", async () => {
      await expect(batchClient.getDownloadInfo("")).rejects.toThrow(
        "Job ID is required"
      );
    });

    it("should handle split files with multiple file count", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "done",
        file_count: 5,
        encoding: "csv",
        compression: "gzip",
      });
      const files = [
        {
          filename: "actual/ES-20240101.csv.gz",
          size: 1000,
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/ES-20240101.csv.gz",
          },
        },
        {
          filename: "actual/ES-20240102.csv.gz",
          size: 2000,
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/ES-20240102.csv.gz",
          },
        },
        {
          filename: "actual/NQ-20240101.csv.gz",
          size: 3000,
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/NQ-20240101.csv.gz",
          },
        },
        {
          filename: "actual/NQ-20240102.csv.gz",
          size: 4000,
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/NQ-20240102.csv.gz",
          },
        },
        {
          filename: "actual/metadata.json",
          size: 500,
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/metadata.json",
          },
        },
      ];

      vi.spyOn(mockHTTP, "get")
        .mockResolvedValueOnce(generateJSONResponse(job))
        .mockResolvedValueOnce(generateJSONResponse(files));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.download_info?.file_count).toBe(5);
      expect(result.download_info?.filenames).toEqual([
        "actual/ES-20240101.csv.gz",
        "actual/ES-20240102.csv.gz",
        "actual/NQ-20240101.csv.gz",
        "actual/NQ-20240102.csv.gz",
        "actual/metadata.json",
      ]);
      expect(result.download_info?.files).toEqual(files);
      expect(result.message).toContain("5 file(s) ready");
    });

    it("should choose a data file for the primary download URL when metadata is listed first", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "done",
        file_count: 2,
      });
      const files = [
        {
          filename: "metadata.json",
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/metadata.json",
          },
        },
        {
          filename: "actual/ES-20240101.dbn.zst",
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/ES-20240101.dbn.zst",
          },
        },
      ];

      vi.spyOn(mockHTTP, "get")
        .mockResolvedValueOnce(generateJSONResponse(job))
        .mockResolvedValueOnce(generateJSONResponse(files));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.download_info?.download_url).toBe(
        "https://api.databento.com/v0/batch/download/user/test-job-123/ES-20240101.dbn.zst"
      );
      expect(result.download_info?.download_urls).toEqual([
        "https://api.databento.com/v0/batch/download/user/test-job-123/metadata.json",
        "https://api.databento.com/v0/batch/download/user/test-job-123/ES-20240101.dbn.zst",
      ]);
    });

    it("should use listed files count in message when job file_count is absent", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "done",
      });
      delete (job as any).file_count;
      const files = [
        {
          filename: "actual/ES-20240101.csv.gz",
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/ES-20240101.csv.gz",
          },
        },
        {
          filename: "actual/ES-20240102.csv.gz",
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/ES-20240102.csv.gz",
          },
        },
      ];

      vi.spyOn(mockHTTP, "get")
        .mockResolvedValueOnce(generateJSONResponse(job))
        .mockResolvedValueOnce(generateJSONResponse(files));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.download_info?.file_count).toBe(2);
      expect(result.message).toContain("2 file(s) ready");
    });

    it("should handle API errors gracefully", async () => {
      const jobId = "test-job-123";
      const error = new Error("Network error");

      vi.spyOn(mockHTTP, "get").mockRejectedValue(error);

      await expect(batchClient.getDownloadInfo(jobId)).rejects.toThrow("Network error");
    });

    it("should handle expired job status", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "expired",
      });
      vi.spyOn(mockHTTP, "get").mockResolvedValue(generateJSONResponse(job));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(mockHTTP.get).toHaveBeenCalledWith("/v0/batch.get_job_details", {
        job_id: jobId,
      });
      expect(result.state).toBe("expired");
      expect(result.message).toContain("has expired");
    });

    it("should not invent filenames or URLs when list_files returns no files", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "done",
        file_count: 1,
      });

      vi.spyOn(mockHTTP, "get")
        .mockResolvedValueOnce(generateJSONResponse(job))
        .mockResolvedValueOnce(generateJSONResponse([]));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.download_info?.file_count).toBe(1);
      expect(result.download_info?.filenames).toBeUndefined();
      expect(result.download_info?.download_url).toBeUndefined();
      expect(result.download_info?.download_urls).toBeUndefined();
      expect(result.download_info?.files).toEqual([]);
      expect(result.message).toContain("did not return downloadable file URLs");
      expect(result.message).not.toContain("ready for download");
    });

    it("should include all job metadata in download info", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "done",
        record_count: 100000,
        file_count: 3,
        total_size: 5000000,
        ts_expiration: "2024-03-01T00:00:00Z",
      });
      const files = [
        { filename: "part-0.dbn.zst", size: 1000 },
        { filename: "part-1.dbn.zst", size: 2000 },
        { filename: "part-2.dbn.zst", size: 3000 },
      ];

      vi.spyOn(mockHTTP, "get")
        .mockResolvedValueOnce(generateJSONResponse(job))
        .mockResolvedValueOnce(generateJSONResponse(files));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.download_info).toEqual({
        id: jobId,
        state: "done",
        total_size: 5000000,
        ts_expiration: "2024-03-01T00:00:00Z",
        record_count: 100000,
        file_count: 3,
        filenames: ["part-0.dbn.zst", "part-1.dbn.zst", "part-2.dbn.zst"],
        files,
      });
    });

    it("should use actual_size when package_size is absent", async () => {
      const jobId = "test-job-123";
      const job = generateBatchJobInfo({
        id: jobId,
        state: "done",
        actual_size: 4096,
      });
      delete (job as any).package_size;
      delete (job as any).total_size;
      const files = [
        {
          filename: "part-0.dbn.zst",
          urls: {
            https: "https://api.databento.com/v0/batch/download/user/test-job-123/part-0.dbn.zst",
          },
        },
      ];

      vi.spyOn(mockHTTP, "get")
        .mockResolvedValueOnce(generateJSONResponse(job))
        .mockResolvedValueOnce(generateJSONResponse(files));

      const result = await batchClient.getDownloadInfo(jobId);

      expect(result.download_info?.total_size).toBe(4096);
    });
  });

  describe('Job Status Message Edge Cases', () => {
    it('should handle expired job state', () => {
      const job = generateBatchJobInfo({
        id: 'expired-job-123',
        state: 'expired',
      });

      const message = (batchClient as any).getJobStatusMessage(job);

      expect(message).toContain('expired-job-123');
      expect(message).toContain('expired');
      expect(message).toMatch(/no longer available/i);
    });

    it('should handle unknown job state', () => {
      const job = generateBatchJobInfo({
        id: 'unknown-job-456',
        state: 'unknown-state' as any,
      });

      const message = (batchClient as any).getJobStatusMessage(job);

      expect(message).toContain('unknown-job-456');
      expect(message).toContain('unknown-state');
    });

    it('should handle processing state with start time', () => {
      const job = generateBatchJobInfo({
        id: 'processing-job-789',
        state: 'processing',
        ts_process_start: '2024-01-15T10:30:00Z',
      });

      const message = (batchClient as any).getJobStatusMessage(job);

      expect(message).toContain('processing-job-789');
      expect(message).toContain('processing');
      expect(message).toContain('2024-01-15T10:30:00Z');
    });

    it('should handle done state with record and file counts', () => {
      const job = generateBatchJobInfo({
        id: 'done-job-101',
        state: 'done',
        record_count: 1500000,
        file_count: 5,
      });

      const message = (batchClient as any).getJobStatusMessage(job);

      expect(message).toContain('done-job-101');
      expect(message).toContain('completed');
      expect(message).toContain('1500000');
      expect(message).toContain('5');
    });
  });

});
