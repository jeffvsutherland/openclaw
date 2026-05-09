import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { createCronStoreHarness } from "./service.test-harness.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const { makeStoreKey } = createCronStoreHarness({ prefix: "openclaw-cron-failure-alert-" });

function createFailureAlertCron(params: {
  cronConfig?: CronServiceParams["cronConfig"];
  storeKey: string;
  runIsolatedAgentJob: NonNullable<CronServiceParams["runIsolatedAgentJob"]>;
  sendCronFailureAlert: NonNullable<CronServiceParams["sendCronFailureAlert"]>;
}) {
  return new CronService({
    cronEnabled: true,
    storeKey: params.storeKey,
    cronConfig: params.cronConfig,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
    sendCronFailureAlert: params.sendCronFailureAlert,
  });
}

describe("CronService failure alerts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("alerts after configured consecutive failures and honors cooldown", async () => {
    const { storeKey } = await makeStoreKey();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "wrong model id",
    }));

    const cron = createFailureAlertCron({
      storeKey,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "daily report",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id }),
        channel: "telegram",
        to: "19098680",
        text: expect.stringContaining('Cron job "daily report" failed 2 times'),
      }),
    );

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Cron job "daily report" failed 4 times'),
      }),
    );

    cron.stop();
  });

  it("supports per-job failure alert override when global alerts are disabled", async () => {
    const { storeKey } = await makeStoreKey();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "timeout",
    }));

    const cron = createFailureAlertCron({
      storeKey,
      cronConfig: {
        failureAlert: {
          enabled: false,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "job with override",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: {
        after: 1,
        channel: "telegram",
        to: "12345",
        cooldownMs: 1,
      },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "12345",
      }),
    );

    cron.stop();
  });

  it("respects per-job failureAlert=false and suppresses alerts", async () => {
    const { storeKey } = await makeStoreKey();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "auth error",
    }));

    const cron = createFailureAlertCron({
      storeKey,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "disabled alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: false,
    });

    await cron.run(job.id, "force");
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    cron.stop();
  });

  it("preserves includeSkipped through failure alert updates", async () => {
    const { storeKey } = await makeStoreKey();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "skipped" as const,
      error: "requests-in-flight",
    }));

    const cron = createFailureAlertCron({
      storeKey,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "updated skipped alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: {
        after: 1,
        channel: "telegram",
        to: "12345",
      },
    });

    const updated = await cron.update(job.id, {
      failureAlert: {
        includeSkipped: true,
      },
    });
    expect(updated?.failureAlert).toEqual(
      expect.objectContaining({
        after: 1,
        channel: "telegram",
        to: "12345",
        includeSkipped: true,
      }),
    );

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "12345",
        text: expect.stringContaining('Cron job "updated skipped alert job" skipped 1 times'),
      }),
    );

    cron.stop();
  });

  it("threads failure alert mode/accountId and skips best-effort jobs", async () => {
    const { storeKey } = await makeStoreKey();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "temporary upstream error",
    }));

    const cron = createFailureAlertCron({
      storeKey,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          accountId: "global-account",
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const normalJob = await cron.add({
      name: "normal alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });
    const bestEffortJob = await cron.add({
      name: "best effort alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "19098680",
        bestEffort: true,
      },
    });

    await cron.run(normalJob.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "webhook",
        accountId: "global-account",
        to: undefined,
      }),
    );

    await cron.run(bestEffortJob.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    cron.stop();
  });

  it("alerts for repeated skipped runs only when opted in", async () => {
    const { storeKey } = await makeStoreKey();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "skipped" as const,
      error: "disabled",
    }));

    const cron = createFailureAlertCron({
      storeKey,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
          includeSkipped: true,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "gateway restart",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "restart gateway if needed" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "19098680",
        text: expect.stringMatching(
          /Cron job "gateway restart" skipped 2 times\nSkip reason: disabled/,
        ),
      }),
    );

    const skippedJob = cron.getJob(job.id);
    expect(skippedJob?.state.consecutiveSkipped).toBe(2);
    expect(skippedJob?.state.consecutiveErrors).toBe(0);

    cron.stop();
  });

  it("tracks skipped runs without alerting or affecting error backoff when includeSkipped is off", async () => {
    const { storeKey } = await makeStoreKey();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "skipped" as const,
      error: "requests-in-flight",
    }));

    const cron = createFailureAlertCron({
      storeKey,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "busy heartbeat",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    await cron.run(job.id, "force");

    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    const skippedJob = cron.getJob(job.id);
    expect(skippedJob?.state.consecutiveSkipped).toBe(2);
    expect(skippedJob?.state.consecutiveErrors).toBe(0);

    cron.stop();
  });
});
