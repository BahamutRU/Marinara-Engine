import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { test } from "node:test";
import { generateImage } from "../src/services/image/image-generation.js";

const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

test("ComfyUI image generation collects animated WebP outputs from Video Combine", async () => {
  const promptId = "prompt-video-combine";
  let port = 0;
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/prompt") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ prompt_id: promptId }));
      return;
    }

    if (req.method === "GET" && req.url === `/history/${promptId}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          [promptId]: {
            outputs: {
              "42": {
                gifs: [{ filename: "marinara_loop_00001.webp", subfolder: "", type: "output" }],
              },
            },
          },
        }),
      );
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/view?")) {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      assert.equal(url.searchParams.get("filename"), "marinara_loop_00001.webp");
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(WEBP_BYTES);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addressInfo = server.address();
  assert.ok(addressInfo && typeof addressInfo === "object");
  port = addressInfo.port;

  try {
    const result = await generateImage("comfyui", `http://localhost:${port}`, "", "comfyui", {
      prompt: "looping character selfie",
      width: 512,
      height: 512,
    });

    assert.equal(result.mimeType, "image/webp");
    assert.equal(result.ext, "webp");
    assert.equal(result.base64, WEBP_BYTES.toString("base64"));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
