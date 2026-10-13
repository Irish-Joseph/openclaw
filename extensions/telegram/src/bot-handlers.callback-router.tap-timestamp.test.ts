// Model command callbacks stamp the tap time, not the date of the card that
// carries the button (#169881).
import { Bot } from "grammy";
import type { Message, Update } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramCallbackMessageRuntime } from "./bot-handlers.callback-router-controls.js";
import { createTelegramCallbackRouter } from "./bot-handlers.callback-router.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { withTelegramUpdateReceivedAt } from "./telegram-ingress-spool.payload.js";

const CARD_DATE = 1_786_404_800;
// A tap ~20 minutes after the card was sent.
const TAP_EPOCH_MS = CARD_DATE * 1000 + 20 * 60 * 1000;
// Processing happens 30 minutes after the queued callback was received.
const PROCESSING_EPOCH_MS = TAP_EPOCH_MS + 30 * 60 * 1000;

describe("model command callback timestamps", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the tap time on the synthetic inbound message instead of the card date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TAP_EPOCH_MS);
    const card: Message.TextMessage = {
      message_id: 77,
      date: CARD_DATE,
      chat: { id: 42, type: "private", first_name: "Ada" },
      from: telegramBotInfoForTest,
      text: "Ship it?",
    };
    const processMessageWithReplyChain = vi.fn(async () => undefined);
    const bot = new Bot("123456:tap-time-token", { botInfo: telegramBotInfoForTest });
    vi.spyOn(bot.api, "answerCallbackQuery").mockResolvedValue(true);
    const router = createTelegramCallbackRouter({
      params: {
        accountId: "default",
        bot,
        runtime: { log: () => {}, error: () => {} },
        telegramDeps: { getRuntimeConfig: () => ({}) },
        shouldSkipUpdate: () => false,
      } as never,
      message: {
        processMessageWithReplyChain,
      } as unknown as TelegramCallbackMessageRuntime,
      authorization: {
        resolveTelegramEventAuthorizationContext: async () => ({
          threadSpec: { scope: "none" },
          dmThreadId: undefined,
          storeAllowFrom: [],
          groupConfig: undefined,
        }),
        authorizeTelegramEventSender: async () => true,
        isTelegramModelCallbackAuthorized: async () => true,
      } as unknown as TelegramHandlerAuthorization,
    });

    bot.on("callback_query", async (context) => {
      await router.route(context);
    });
    const update: Update.CallbackQueryUpdate = {
      update_id: 5,
      callback_query: {
        id: "tap-1",
        chat_instance: "tap-chat",
        from: { id: 7, is_bot: false, first_name: "Ada" },
        message: card,
        data: "/status",
      },
    };
    await bot.handleUpdate(update);

    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
    const captured = processMessageWithReplyChain.mock.calls[0]?.[0] as { msg: Message };
    expect(captured.msg.date).toBe(TAP_EPOCH_MS / 1000);
    expect(captured.msg.date).not.toBe(CARD_DATE);
  });

  it("keeps the spool receipt time when a queued callback is processed later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(PROCESSING_EPOCH_MS);
    const card: Message.TextMessage = {
      message_id: 78,
      date: CARD_DATE,
      chat: { id: 42, type: "private", first_name: "Ada" },
      from: telegramBotInfoForTest,
      text: "Ship it?",
    };
    const processMessageWithReplyChain = vi.fn(async () => undefined);
    const bot = new Bot("123456:tap-time-token", { botInfo: telegramBotInfoForTest });
    vi.spyOn(bot.api, "answerCallbackQuery").mockResolvedValue(true);
    const router = createTelegramCallbackRouter({
      params: {
        accountId: "default",
        bot,
        runtime: { log: () => {}, error: () => {} },
        telegramDeps: { getRuntimeConfig: () => ({}) },
        shouldSkipUpdate: () => false,
      } as never,
      message: {
        processMessageWithReplyChain,
      } as unknown as TelegramCallbackMessageRuntime,
      authorization: {
        resolveTelegramEventAuthorizationContext: async () => ({
          threadSpec: { scope: "none" },
          dmThreadId: undefined,
          storeAllowFrom: [],
          groupConfig: undefined,
        }),
        authorizeTelegramEventSender: async () => true,
        isTelegramModelCallbackAuthorized: async () => true,
      } as unknown as TelegramHandlerAuthorization,
    });

    // The ingress spool stamps the update with the admission time; the clock
    // advances between admission and this (re)dispatch.
    const update: Update.CallbackQueryUpdate = {
      update_id: 6,
      callback_query: {
        id: "tap-2",
        chat_instance: "tap-chat",
        from: { id: 7, is_bot: false, first_name: "Ada" },
        message: card,
        data: "/status",
      },
    };
    withTelegramUpdateReceivedAt(update, TAP_EPOCH_MS);
    bot.on("callback_query", async (context) => {
      await router.route(context);
    });
    await bot.handleUpdate(update);

    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
    const captured = processMessageWithReplyChain.mock.calls[0]?.[0] as { msg: Message };
    expect(captured.msg.date).toBe(TAP_EPOCH_MS / 1000);
    expect(captured.msg.date).not.toBe(PROCESSING_EPOCH_MS / 1000);
  });
});
