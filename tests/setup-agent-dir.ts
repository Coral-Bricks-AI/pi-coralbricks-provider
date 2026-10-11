// Every test file runs against a throwaway agent dir, never ~/.pi/agent: model
// caches, sync sidecars, locks and settings all resolve under PI_CODING_AGENT_DIR.
// Tests that need their own dir stub it per test; unstubbing returns to this one.
import { afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coralbricks-agent-"));
process.env.PI_CODING_AGENT_DIR = dir;
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
