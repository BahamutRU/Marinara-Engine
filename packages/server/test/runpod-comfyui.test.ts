import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import { test } from "node:test";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const WORKFLOW_JSON = JSON.stringify({
  "3": {
    class_type: "KSampler",
    inputs: { seed: 42, steps: 5, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1 },
  },
  "268": {
    class_type: "CLIPTextEncode",
    inputs: { text: "a cat", clip: ["39", 0] },
  },
});

const { generateRunPodComfyUI } = await import(
  "../src/services/image/runpod-comfyui.service.js"
);

test("RunPod — rejects missing workflow", async () => {
  await assert.rejects(
    () => generateRunPodComfyUI("http://localhost:9999", "ep-id", "key", { prompt: "test" }),
    /requires a workflow/,
  );
});

test("RunPod — rejects invalid workflow JSON", async () => {
  await assert.rejects(
    () => generateRunPodComfyUI("http://localhost:9999", "ep-id", "key", {
      prompt: "test",
      comfyWorkflow: "not-json{{{",
    }),
    /Invalid ComfyUI workflow JSON/,
  );
});

test("RunPod — successful, completes on first poll", async () => {
  const endpointId = "ep-pass-1";
  const jobId = "job-001";
  let pollCount = 0;

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === `/v2/${endpointId}/run`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId }));
      return;
    }
    if (req.method === "GET" && req.url === `/v2/${endpointId}/status/${jobId}`) {
      pollCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: jobId,
          status: "COMPLETED",
          output: { images: [{ data: PNG_1X1_BASE64, filename: "img.png", type: "base64" }] },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  process.env.RUNPOD_POLL_INTERVAL_MS = "10";
  const result = await generateRunPodComfyUI(`http://127.0.0.1:${port}/v2`, endpointId, "key", {
    prompt: "a cat",
    comfyWorkflow: WORKFLOW_JSON,
  });

  assert.equal(pollCount, 1);
  assert.ok(result.base64.length > 10); // 1x1 PNG is ~86 chars; any non-empty image passes
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.ext, "png");
  server.close();
  delete process.env.RUNPOD_POLL_INTERVAL_MS;
});

test("RunPod — multiple polls before completion", async () => {
  const endpointId = "ep-poll-2";
  const jobId = "job-002";
  let pollCount = 0;

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === `/v2/${endpointId}/run`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId }));
      return;
    }
    if (req.method === "GET" && req.url === `/v2/${endpointId}/status/${jobId}`) {
      pollCount++;
      const status = pollCount <= 2 ? "IN_PROGRESS" : "COMPLETED";
      const output =
        status === "COMPLETED"
          ? { images: [{ data: PNG_1X1_BASE64, filename: "img.png", type: "base64" }] }
          : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId, status, output }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  process.env.RUNPOD_POLL_INTERVAL_MS = "10";
  const result = await generateRunPodComfyUI(`http://127.0.0.1:${port}/v2`, endpointId, "key", {
    prompt: "a cat",
    comfyWorkflow: WORKFLOW_JSON,
  });
  delete process.env.RUNPOD_POLL_INTERVAL_MS;

  assert.equal(pollCount, 3);
  assert.ok(result.base64.length > 10);
  server.close();
});

test("RunPod — rejects FAILED status", async () => {
  const endpointId = "ep-fail-3";
  const jobId = "job-003";

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === `/v2/${endpointId}/run`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId }));
      return;
    }
    if (req.method === "GET" && req.url === `/v2/${endpointId}/status/${jobId}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId, status: "FAILED", error: "Out of memory" }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  process.env.RUNPOD_POLL_INTERVAL_MS = "10";
  await assert.rejects(
    () =>
      generateRunPodComfyUI(`http://127.0.0.1:${port}/v2`, endpointId, "key", {
        prompt: "test",
        comfyWorkflow: WORKFLOW_JSON,
      }),
    /Out of memory/,
  );
  delete process.env.RUNPOD_POLL_INTERVAL_MS;
  server.close();
});

test("RunPod — rejects CANCELLED status", async () => {
  const endpointId = "ep-cancel-4";
  const jobId = "job-004";

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === `/v2/${endpointId}/run`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId }));
      return;
    }
    if (req.method === "GET" && req.url === `/v2/${endpointId}/status/${jobId}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId, status: "CANCELLED" }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  process.env.RUNPOD_POLL_INTERVAL_MS = "10";
  await assert.rejects(
    () =>
      generateRunPodComfyUI(`http://127.0.0.1:${port}/v2`, endpointId, "key", {
        prompt: "test",
        comfyWorkflow: WORKFLOW_JSON,
      }),
    /cancelled/i,
  );
  delete process.env.RUNPOD_POLL_INTERVAL_MS;
  server.close();
});

test("RunPod — rejects HTTP 401 on submit", async () => {
  const endpointId = "ep-401-5";

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === `/v2/${endpointId}/run`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  await assert.rejects(
    () =>
      generateRunPodComfyUI(`http://127.0.0.1:${port}/v2`, endpointId, "bad-key", {
        prompt: "test",
        comfyWorkflow: WORKFLOW_JSON,
      }),
    /401/,
  );
  server.close();
});

test("RunPod — empty output.images throws clear error", async () => {
  const endpointId = "ep-noimg-6";
  const jobId = "job-006";

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === `/v2/${endpointId}/run`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId }));
      return;
    }
    if (req.method === "GET" && req.url === `/v2/${endpointId}/status/${jobId}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId, status: "COMPLETED", output: { images: [] } }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  process.env.RUNPOD_POLL_INTERVAL_MS = "10";
  await assert.rejects(
    () =>
      generateRunPodComfyUI(`http://127.0.0.1:${port}/v2`, endpointId, "key", {
        prompt: "test",
        comfyWorkflow: WORKFLOW_JSON,
      }),
    /empty or missing/,
  );
  delete process.env.RUNPOD_POLL_INTERVAL_MS;
  server.close();
});
