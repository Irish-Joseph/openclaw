import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { renderUpdateRunNotice } from "../infra/update-run-report.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createUpdateRunNotifier } from "./update-run-notice.runtime.js";

const confirmGatewayReachable = vi.hoisted(() =>
  vi.fn<typeof import("../cli/daemon-cli/restart-health-probe.js").confirmGatewayReachable>(),
);
vi.mock("../cli/daemon-cli/restart-health-probe.js", () => ({ confirmGatewayReachable }));

describe("host-owned update notices", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-update-notice-" });
  });
  afterEach(async () => {
    await state.cleanup();
  });

  it("delivers failed-update advice as superseded history after the Gateway answers", async () => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "update-session",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const advice =
      "Managed gateway remains stopped. Keep the gateway stopped until the update succeeds.";
    const initial = createUpdateRun({
      trigger: "chat",
      origin: { sessionKey: target.sessionKey, nextAction: advice },
    });
    recordUpdateRunVerification(initial.runId, { port: 19123, versionMatch: false });
    const finished = finishUpdateRun(initial.runId, {
      status: "failed",
      reason: "restart-unhealthy",
    });
    if (!finished) {
      throw new Error("Missing failed update");
    }
    confirmGatewayReachable.mockResolvedValue({
      reachable: true,
      gatewayVersion: "2026.9.4",
      gatewayBuildId: undefined,
      activatedPluginErrors: [],
      unavailablePlugins: [],
      channelProbeErrors: [],
    });

    const notify = await createUpdateRunNotifier(initial, () => ({}), {});
    expect(await notify(finished, "finished")).toEqual({
      delivered: true,
      owned: true,
    });

    const transcript = JSON.stringify(await loadTranscriptEvents(target));
    expect(transcript).toContain("service identity unavailable");
    expect(transcript).toContain("Historical recovery advice:");
    expect(transcript).toContain("supersedes saved claims that the Gateway is stopped");
    expect(transcript).toContain("Gateway answered on the recorded port (2026.9.4)");
    expect(getUpdateRun(initial.runId)?.origin.nextAction).toBe(advice);
    expect(getUpdateRun(initial.runId)?.status).toBe("failed");
  });

  it.each([false, true])(
    "outlives the requesting attempt while honoring session replacement (%s)",
    async (replaced) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "update-session",
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        lifecycleRevision: "admitted-session",
        updatedAt: 1,
      });
      const run = createUpdateRun({ trigger: "chat", origin: { sessionKey: target.sessionKey } });
      const notify = await createUpdateRunNotifier(run, () => ({}), {});
      if (replaced) {
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          lifecycleRevision: "replacement-session",
          updatedAt: 2,
        });
      }
      const result = await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          withTranscriptWrite: async () => {
            throw new Error("attempt disposed before transcript write");
          },
        },
        () => notify(run, "parking"),
      );
      expect(result).toEqual({ delivered: !replaced, owned: !replaced });
      const events = await loadTranscriptEvents(target);
      const messages = events.filter((event) => asOptionalRecord(event)?.type === "message");
      expect(messages).toHaveLength(replaced ? 0 : 1);
      if (!replaced) {
        expect(messages[0]).toMatchObject({
          message: {
            role: "assistant",
            content: [{ type: "text", text: renderUpdateRunNotice(run, "parking") }],
          },
        });
        expect(getUpdateRun(run.runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "notice:activating", status: "completed" }),
        );
      }
      expect(getUpdateRun(run.runId)?.phase).toBe("requested");
    },
  );

  it("treats an idempotency conflict with verified stored content as delivered", async () => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "update-session-idem",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const initial = createUpdateRun({
      trigger: "chat",
      origin: { sessionKey: target.sessionKey },
    });
    // Pre-admit a message with the same delivery intent key that contains
    // recognizable update-run notice content (includes the run ID).
    const deliveryIntentId = `update-run-finished:${initial.runId}`;
    const priorNotice = `⬆️ Update completed for run ${initial.runId}. Gateway is healthy.`;
    await appendAssistantMessageToSessionTranscript({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      expectedSessionId: target.sessionId,
      expectedLifecycleRevision: null,
      storePath: target.storePath,
      text: priorNotice,
      idempotencyKey: deliveryIntentId,
    });
    const finished = finishUpdateRun(initial.runId, { status: "succeeded" });
    if (!finished) {
      throw new Error("Missing finished update");
    }
    const notify = await createUpdateRunNotifier(initial, () => ({}), {});
    const result = await notify(finished, "finished");
    // The conflict is verified: stored content contains the run ID → delivered.
    expect(result).toEqual({ delivered: true, owned: true });
    expect(getUpdateRun(initial.runId)?.verification.noticeDelivered).toBe(true);
  });

  it("does not treat a conflict with unrecognized stored content as delivered", async () => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "update-session-unrec",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const initial = createUpdateRun({
      trigger: "chat",
      origin: { sessionKey: target.sessionKey },
    });
    // Pre-admit a message with the same key but content that is NOT an
    // update-run notice (no run ID, no known markers).
    const deliveryIntentId = `update-run-finished:${initial.runId}`;
    await appendAssistantMessageToSessionTranscript({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      expectedSessionId: target.sessionId,
      expectedLifecycleRevision: null,
      storePath: target.storePath,
      text: "x", // minimal content that won't match any notice markers
      idempotencyKey: deliveryIntentId,
    });
    const finished = finishUpdateRun(initial.runId, { status: "succeeded" });
    if (!finished) {
      throw new Error("Missing finished update");
    }
    const notify = await createUpdateRunNotifier(initial, () => ({}), {});
    const result = await notify(finished, "finished");
    // Unrecognized content → not marked as delivered.
    expect(result.delivered).toBe(false);
    expect(getUpdateRun(initial.runId)?.verification.noticeDelivered).toBeUndefined();
  });
});
