// ──────────────────────────────────────────────
// Service: RunPod Serverless ComfyUI
// ──────────────────────────────────────────────
// Communicates with RunPod serverless endpoints running ComfyUI workflows.
// Uses the RunPod async job API:
//   POST /v2/{endpoint_id}/run  →  receive { id }
//   GET  /v2/{endpoint_id}/status/{job_id}  →  poll until COMPLETED
//   Extract images from output.images[n].data (raw base64)
//
// API format (confirmed via testing):
//   Input:  { "input": { "workflow": <full ComfyUI workflow JSON> } }
//   Output: { "output": { "images": [{ "data": "<base64>", "filename": "...", "type": "base64" }] } }
//
// The prompt is embedded in the workflow JSON (e.g. CLIPTextEncode node text),
// so placeholder substitution (%prompt%, %seed%, etc.) must happen BEFORE sending.

import type { ImageGenRequest, ImageGenResult } from "./image-generation.js";

const RUNPOD_POLL_INTERVAL_MS = Number(process.env.RUNPOD_POLL_INTERVAL_MS ?? 2_000);
const RUNPOD_MAX_POLLS = 90; // 90 × 2s = 3 minutes max
const RUNPOD_API_BASE = process.env.RUNPOD_API_BASE_URL ?? "https://api.runpod.ai/v2";

interface RunPodRunResponse {
  id: string;
}

interface RunPodStatusResponse {
  id: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED";
  output?: {
    images?: Array<Record<string, unknown>>;
  };
  error?: string;
}

/**
 * Generate an image via a RunPod Serverless ComfyUI endpoint.
 *
 * The endpoint ID comes from the dedicated `image_endpoint_id` connection field.
 * The workflow JSON (with placeholders already substituted) comes from
 * the connection's `comfyui_workflow` field.
 *
 * @param baseUrl     - RunPod API base URL (e.g. "https://api.runpod.ai/v2" or test URL)
 * @param endpointId  - RunPod endpoint ID (e.g. "abc123def456")
 * @param apiKey      - RunPod API Bearer token
 * @param request     - Image gen request with comfyWorkflow containing prompt
 */
export async function generateRunPodComfyUI(
  baseUrl: string,
  endpointId: string,
  apiKey: string,
  request: ImageGenRequest,
): Promise<ImageGenResult> {
  const endpointUrl = `${baseUrl}/${endpointId}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // The workflow JSON should already be substituted by the caller
  // (see generateImage() switch case → placeholder replacement happens earlier).
  // If there's no workflow, this is an error — RunPod needs the workflow.
  if (!request.comfyWorkflow) {
    throw new Error(
      "RunPod ComfyUI requires a workflow JSON. " +
      "Paste your ComfyUI workflow (API format) in the connection's workflow field.",
    );
  }

  // ── Substitute placeholders (%prompt%, %seed%, etc.) ──
  // The workflow JSON string contains placeholders like %prompt% and %seed%.
  // Replace them before parsing, matching the local ComfyUI handler behaviour.
  const seed = request.imageDefaults?.seed ?? -1;
  const resolvedSeed = seed === -1 ? Math.floor(Math.random() * 2_147_483_647) : seed;

  let wfStr = request.comfyWorkflow;
  wfStr = wfStr.replace(/%prompt%/g, escapeJsonStr(request.prompt || ""));
  wfStr = wfStr.replace(/%negative_prompt%/g, escapeJsonStr(request.negativePrompt || ""));
  wfStr = wfStr.replace(/%width%/g, String(request.width ?? 512));
  wfStr = wfStr.replace(/%height%/g, String(request.height ?? 768));
  wfStr = wfStr.replace(/%seed%/g, String(resolvedSeed));

  let workflow: Record<string, unknown>;
  try {
    workflow = JSON.parse(wfStr) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid ComfyUI workflow JSON for RunPod endpoint");
  }

  // ── Step 1: Submit the job ──
  const jobResp = await fetch(`${endpointUrl}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: { workflow } }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!jobResp.ok) {
    const errText = await jobResp.text().catch(() => "Unknown error");
    throw new Error(
      `RunPod job submission failed (${jobResp.status}): ${sanitizeRunPodError(errText)}`,
    );
  }

  const { id: jobId } = (await jobResp.json()) as RunPodRunResponse;
  if (!jobId) {
    throw new Error("RunPod did not return a job ID");
  }

  // ── Step 2: Poll for completion ──
  for (let attempt = 0; attempt < RUNPOD_MAX_POLLS; attempt++) {
    await new Promise((r) => setTimeout(r, RUNPOD_POLL_INTERVAL_MS));

    const statusResp = await fetch(`${endpointUrl}/status/${jobId}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!statusResp.ok) {
      const errText = await statusResp.text().catch(() => "Unknown error");
      throw new Error(
        `RunPod status check failed (${statusResp.status}): ${sanitizeRunPodError(errText)}`,
      );
    }

    const status = (await statusResp.json()) as RunPodStatusResponse;

    switch (status.status) {
      case "COMPLETED":
        return extractRunPodImage(status, endpointId);
      case "FAILED":
        throw new Error(`RunPod generation failed: ${status.error || "Unknown error"}`);
      case "CANCELLED":
        throw new Error("RunPod generation was cancelled");
      // IN_QUEUE / IN_PROGRESS → keep polling
    }
  }

  throw new Error("RunPod generation timed out after 3 minutes");
}

/**
 * Extract the first image from a COMPLETED RunPod response.
 *
 * Expected format:
 *   { output: { images: [{ data: "<base64>", filename: "...", type: "base64" }] } }
 */
function extractRunPodImage(
  status: RunPodStatusResponse,
  endpointId: string,
): ImageGenResult {
  const output = status.output;

  if (!output) {
    throw new Error(
      `RunPod returned COMPLETED but no output data (endpoint: ${endpointId})`,
    );
  }

  const images = output.images;
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error(
      `RunPod returned COMPLETED but output.images was empty or missing. ` +
      `Check that your workflow has a SaveImage node connected to the output.`,
    );
  }

  // Try each image in order, take the first valid one
  for (const item of images) {
    if (!item || typeof item !== "object") continue;
    const img = item as Record<string, unknown>;

    // Main field is "data" containing raw base64
    const data = typeof img.data === "string" ? img.data : null;
    if (data && data.length > 0) {
      const trimmed = data.trim();
      // Could be data URL or raw base64
      if (trimmed.startsWith("data:")) {
        return decodeDataUrl(trimmed);
      }
      // Raw base64 (most common for RunPod)
      if (/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) {
        const mimeType = detectImageMimeType(trimmed);
        return {
          base64: trimmed,
          mimeType,
          ext: imageExtensionFromMimeType(mimeType),
        };
      }
    }

    // Also try "base64" or "image" keys (defensive fallback)
    const fallbackBase64 =
      typeof img.base64 === "string"
        ? img.base64
        : typeof img.image === "string"
          ? img.image
          : null;

    if (fallbackBase64) {
      const trimmed = fallbackBase64.trim();
      const mimeType = detectImageMimeType(trimmed);
      return {
        base64: trimmed,
        mimeType,
        ext: imageExtensionFromMimeType(mimeType),
      };
    }
  }

  throw new Error(
    `Could not extract image from RunPod output. ` +
    `Found ${images.length} image(s) but none had valid base64 data. ` +
    `Output preview: ${JSON.stringify(output).slice(0, 300)}`,
  );
}

// ── Helpers ──

function sanitizeRunPodError(text: string): string {
  if (!text.includes("<")) return text.slice(0, 300);
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function detectImageMimeType(base64: string): string {
  const bytes = Buffer.from(base64.slice(0, 64), "base64");
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/png";
}

function imageExtensionFromMimeType(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

function decodeDataUrl(dataUrl: string): ImageGenResult {
  const match = dataUrl.trim().match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([\s\S]+)$/i);
  if (!match) throw new Error("Invalid image data URL from RunPod output");

  const declaredMimeType = match[1]!.toLowerCase().replace("image/jpg", "image/jpeg");
  const encoded = match[2]!.replace(/\s+/g, "");
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.byteLength === 0) throw new Error("Empty image data from RunPod");

  const base64 = buffer.toString("base64");
  const mimeType = detectImageMimeType(base64) || declaredMimeType;
  return { base64, mimeType, ext: imageExtensionFromMimeType(mimeType) };
}

/** Escape a string for safe insertion into a JSON string value (backslash + quote escaping). */
function escapeJsonStr(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
