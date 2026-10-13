import type { PreparedTelegramPollAnswer } from "./poll-answer-context.js";

export type TelegramSpooledUpdatePayload = {
  version: number;
  updateId: number;
  receivedAt: number;
  update: unknown;
  preparedPollAnswer?: PreparedTelegramPollAnswer;
};

export const TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION = 1;

/**
 * Non-Telegram marker carrying the spool's receipt time onto the in-memory
 * update so handlers can distinguish it from the dispatch time. Never
 * persisted: it is added after deserialization and stripped from wire JSON.
 */
export const TELEGRAM_UPDATE_RECEIVED_AT_MS_KEY = "__openclawReceivedAtMs";

export function withTelegramUpdateReceivedAt(
  update: object | null | undefined,
  receivedAt: number | undefined,
): object | null | undefined {
  if (update && typeof receivedAt === "number" && Number.isFinite(receivedAt)) {
    (update as Record<string, unknown>)[TELEGRAM_UPDATE_RECEIVED_AT_MS_KEY] = receivedAt;
  }
  return update;
}

export function readTelegramUpdateReceivedAtMs(
  update: object | null | undefined,
): number | undefined {
  if (!update) {
    return undefined;
  }
  const value = (update as Record<string, unknown>)[TELEGRAM_UPDATE_RECEIVED_AT_MS_KEY];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class TelegramIngressPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TelegramIngressPayloadError";
  }
}
