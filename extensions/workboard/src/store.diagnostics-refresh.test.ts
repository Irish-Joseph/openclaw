import { DatabaseSync } from "node:sqlite";
import { describe, expect } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("WorkboardStore diagnostics refresh", () => {
  test("preserves card activity age while keeping diagnostic observations current", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const blocked = await store.create({ title: "Blocked too long", status: "blocked" });
    // Age the card past the blocked threshold so the warning fires on the first sweep.
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare("UPDATE workboard_cards SET updated_at = ? WHERE id = ?").run(aged, blocked.id);
    } finally {
      raw.close();
    }
    const before = (await store.get(blocked.id))!;
    expect(before.updatedAt).toBe(aged);

    // First sweep: the warning is persisted without resetting the activity age.
    await expect(store.refreshDiagnostics()).resolves.toMatchObject({
      count: 1,
      diagnostics: [
        expect.objectContaining({
          card: expect.objectContaining({ id: blocked.id, updatedAt: aged }),
          diagnostics: [expect.objectContaining({ kind: "blocked_too_long", count: 1 })],
        }),
      ],
    });
    const first = (await store.get(blocked.id))!;
    expect(first.updatedAt).toBe(aged);
    expect(first.events).toEqual(before.events);
    expect(first.metadata?.diagnostics?.[0]).toMatchObject({
      kind: "blocked_too_long",
      count: 1,
    });

    // Immediate repeat: the warning stays, observations advance, and no card
    // event is recorded.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    await expect(store.refreshDiagnostics()).resolves.toMatchObject({
      count: 1,
      diagnostics: [
        expect.objectContaining({
          card: expect.objectContaining({ id: blocked.id, updatedAt: aged }),
          diagnostics: [expect.objectContaining({ kind: "blocked_too_long", count: 2 })],
        }),
      ],
    });
    const second = (await store.get(blocked.id))!;
    expect(second.updatedAt).toBe(aged);
    expect(second.events).toEqual(before.events);
    expect(second.metadata?.diagnostics?.[0]).toMatchObject({
      kind: "blocked_too_long",
      count: 2,
      firstSeenAt: first.metadata?.diagnostics?.[0]?.firstSeenAt,
    });
    expect(second.metadata?.diagnostics?.[0]?.lastSeenAt).toBeGreaterThan(
      first.metadata?.diagnostics?.[0]?.lastSeenAt ?? 0,
    );

    // Clearing the condition removes the persisted observations.
    await store.move(blocked.id, "todo", undefined);
    await expect(store.refreshDiagnostics()).resolves.toEqual({ diagnostics: [], count: 0 });
    const cleared = (await store.get(blocked.id))!;
    expect(cleared.metadata?.diagnostics).toBeUndefined();
  });

  test("leaves cards without diagnostics untouched by refresh sweeps", async () => {
    const { store } = createWorkboardSqliteTestHarness({ createStores: createKernelStores });
    const card = await store.create({ title: "Fresh work", status: "todo" });
    const before = await store.get(card.id);
    await expect(store.refreshDiagnostics()).resolves.toEqual({ diagnostics: [], count: 0 });
    await expect(store.refreshDiagnostics()).resolves.toEqual({ diagnostics: [], count: 0 });
    await expect(store.get(card.id)).resolves.toEqual(before);
  });
});
