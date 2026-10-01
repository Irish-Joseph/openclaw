import { createDefaultDeps } from "../cli/deps.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/config.js";
import { findTranscriptEvent } from "../config/sessions/session-transcript-match.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureDeliveryQueueStateContext,
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-state-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { readUpdateRunReportHealth } from "../infra/update-run-report-health.js";
import { renderUpdateRunNotice, type UpdateRunNoticeKind } from "../infra/update-run-report.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sendGatewayLifecycleNotice } from "./server-restart-sentinel-notice.js";
import {
  authorizeUpdateRunNoticeTarget,
  recordUpdateRunNoticeSkipped,
  resolveUpdateRunNoticeTarget,
} from "./update-run-notice-target.js";

const log = createSubsystemLogger("gateway/update-run");

/** Prepare routing before an update can replace lazily loaded channel modules. */
export async function createUpdateRunNotifier(
  initial: UpdateRunRecord,
  getConfig: () => OpenClawConfig = getRuntimeConfig,
  deps: CliDeps = createDefaultDeps(),
  target?: Awaited<ReturnType<typeof resolveUpdateRunNoticeTarget>>,
  context: DeliveryQueueStateContext = captureDeliveryQueueStateContext(),
) {
  const env = context.workerContext.environment;
  const noticeTarget =
    target ??
    (await resolveUpdateRunNoticeTarget({
      cfg: getConfig(),
      sessionKey: initial.origin.sessionKey,
      explicitDeliveryContext: initial.origin.deliveryContext,
      threadId: initial.origin.deliveryContext?.threadId,
      env,
    }));
  const { sessionKey } = initial.origin;
  // Update delivery belongs to the host and can outlive the requesting attempt.
  return (run: UpdateRunRecord, kind: UpdateRunNoticeKind) =>
    runWithoutOwnedSessionTranscriptWrites(async () => {
      // Pre-park and later activation share one durable notice, never a fifth milestone.
      const milestone = kind === "parking" ? "activating" : kind;
      const recorded =
        kind === "finished"
          ? run.verification.noticeDelivered === true
          : run.steps.some(
              (step) => step.step === `notice:${milestone}` && step.status === "completed",
            );
      if (recorded) {
        return { delivered: false, owned: recorded };
      }
      const message = renderUpdateRunNotice(
        run,
        kind,
        kind === "finished" && run.status === "failed"
          ? {
              currentHealth: await readUpdateRunReportHealth(run.verification, {
                env: resolveDeliveryQueueStateEnv(undefined, context),
              }),
            }
          : {},
      );
      if (!message) {
        return { delivered: false, owned: false };
      }
      const cfg = getConfig();
      const currentTarget = authorizeUpdateRunNoticeTarget(cfg, noticeTarget);
      if (currentTarget.kind === "none") {
        recordUpdateRunNoticeSkipped(run.runId, currentTarget.reason, env);
        return { delivered: false, owned: false };
      }
      // Admission, the watcher, and successor startup share permanent delivery
      // ownership. A repeated phase or sentinel revision cannot send a fifth message.
      const deliveryIntentId = `update-run-${milestone}:${run.runId}`;
      let delivered: boolean;
      if (currentTarget.kind === "route") {
        delivered = await sendGatewayLifecycleNotice(
          {
            ...currentTarget.route,
            cfg,
            deps,
            sessionKey,
            message,
            deliveryIntentId,
          },
          context,
        );
      } else {
        const internal = currentTarget.session;
        const notice = await appendAssistantMessageToSessionTranscript({
          agentId: internal.agentId,
          sessionKey: internal.canonicalKey,
          expectedSessionId: internal.entry.sessionId,
          expectedLifecycleRevision: internal.entry.lifecycleRevision ?? null,
          storePath: internal.storePath,
          text: message,
          idempotencyKey: deliveryIntentId,
        }).catch(async (error: unknown) => {
          // An idempotency conflict means the stored message differs from the
          // proposed one. Verify the stored content is actually our update-run
          // notice before recording delivery.
          if (
            error instanceof Error &&
            error.name === "TranscriptTurnAdmissionConflictError" &&
            error.message.includes(deliveryIntentId)
          ) {
            try {
              // Worker-backed keyed lookup (P2: avoids synchronous
              // full-transcript SQLite read on the Gateway thread).
              const found = await findTranscriptEvent(
                {
                  agentId: internal.agentId,
                  sessionKey: internal.canonicalKey,
                  sessionId: internal.entry.sessionId,
                  ...(internal.storePath ? { storePath: internal.storePath } : {}),
                },
                { kind: "idempotency", key: deliveryIntentId },
              );
              const storedText =
                (found?.event?.message as Record<string, unknown> | undefined)?.content != null
                  ? (((
                      (found!.event!.message as Record<string, unknown>).content as Array<
                        Record<string, unknown>
                      >
                    ).find((b) => b.type === "text")?.text as string | undefined) ?? "")
                  : "";
              // Recognize production finished-report output (P1: the renderer
              // never embeds run.runId; it produces headlines like
              // "✅ OpenClaw updated to …", "⚠️ OpenClaw update failed: …",
              // "ℹ️ OpenClaw update skipped: …", "↩️ OpenClaw update rolled back").
              const isFinishedReport = /OpenClaw (updated|update|abandoned update)/.test(
                storedText,
              );
              if (isFinishedReport) {
                log.info(
                  `update run notice already delivered (verified stored finished report for key ${deliveryIntentId})`,
                );
                return { ok: true as const };
              }
              log.warn(
                `update run notice conflict for key ${deliveryIntentId} but stored content is not a recognized update-run finished report; not marking as delivered`,
              );
              return {
                ok: false as const,
                reason: "conflicting stored content is not an update-run finished report",
              };
            } catch {
              // If we cannot read the transcript, fail closed.
              return { ok: false as const, reason: formatErrorMessage(error) };
            }
          }
          return { ok: false as const, reason: formatErrorMessage(error) };
        });
        delivered = notice.ok;
        if (!notice.ok) {
          log.warn(`update run notice append failed: ${notice.reason}`);
        }
      }
      if (delivered && kind === "finished") {
        recordUpdateRunVerification(run.runId, { noticeDelivered: true }, { env });
      }
      const custody =
        currentTarget.kind === "route"
          ? await findDeliveryIntentOwner(deliveryIntentId, undefined, context)
          : null;
      const owned = delivered || custody?.status === "pending" || custody?.status === "completed";
      if (owned && kind !== "finished") {
        recordUpdateRunStep(
          run.runId,
          {
            step: `notice:${milestone}`,
            status: "completed",
            endedAtMs: Date.now(),
          },
          { env },
        );
      }
      return { delivered, owned };
    });
}

export async function notifyUpdateRunPhase(run: UpdateRunRecord): Promise<void> {
  if (run.phase === "activating" || run.phase === "finished") {
    const notify = await createUpdateRunNotifier(run);
    await notify(run, run.phase);
  }
}
