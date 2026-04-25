import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS,
  LAUNCH_AGENT_UMASK_DECIMAL,
} from "./launchd-plist.js";
import {
  installLaunchAgent,
  isLaunchAgentListed,
  parseLaunchctlPrint,
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
  stopLaunchAgent,
} from "./launchd.js";

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  listOutput: "",
  printOutput: "",
  psOutput: "",
  bootstrapError: "",
  kickstartError: "",
  kickstartFailuresRemaining: 0,
  dirs: new Set<string>(),
  dirModes: new Map<string, number>(),
  files: new Map<string, string>(),
  fileModes: new Map<string, number>(),
}));
const launchdRestartHandoffState = vi.hoisted(() => ({
  isCurrentProcessLaunchdServiceLabel: vi.fn<(label: string) => boolean>(() => false),
  scheduleDetachedLaunchdRestartHandoff: vi.fn((_params: unknown) => ({ ok: true, pid: 7331 })),
}));
const defaultProgramArguments = ["node", "-e", "process.exit(0)"];

function normalizeLaunchctlArgs(file: string, args: string[]): string[] {
  if (file === "launchctl") {
    return args;
  }
  const idx = args.indexOf("launchctl");
  if (idx >= 0) {
    return args.slice(idx + 1);
  }
  return args;
}

vi.mock("./exec-file.js", () => ({
  execFileUtf8: vi.fn(async (file: string, args: string[]) => {
    const call = normalizeLaunchctlArgs(file, args);
    state.launchctlCalls.push(call);
    if (call[0] === "list") {
      return { stdout: state.listOutput, stderr: "", code: 0 };
    }
    if (call[0] === "print") {
      return { stdout: state.printOutput, stderr: "", code: 0 };
    }
    if (call[0] === "-p") {
      // ps -p <pid> -o lstart= call for getPidStartTime
      return { stdout: state.psOutput, stderr: "", code: 0 };
    }
    if (call[0] === "bootstrap" && state.bootstrapError) {
      return { stdout: "", stderr: state.bootstrapError, code: 1 };
    }
    if (call[0] === "kickstart" && state.kickstartError && state.kickstartFailuresRemaining > 0) {
      state.kickstartFailuresRemaining -= 1;
      return { stdout: "", stderr: state.kickstartError, code: 1 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }),
}));

vi.mock("./launchd-restart-handoff.js", () => ({
  isCurrentProcessLaunchdServiceLabel: (label: string) =>
    launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel(label),
  scheduleDetachedLaunchdRestartHandoff: (params: unknown) =>
    launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff(params),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...actual,
    access: vi.fn(async (p: string) => {
      const key = String(p);
      if (state.files.has(key) || state.dirs.has(key)) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory, access '${key}'`);
    }),
    mkdir: vi.fn(async (p: string, opts?: { mode?: number }) => {
      const key = String(p);
      state.dirs.add(key);
      state.dirModes.set(key, opts?.mode ?? 0o777);
    }),
    stat: vi.fn(async (p: string) => {
      const key = String(p);
      if (state.dirs.has(key)) {
        return { mode: state.dirModes.get(key) ?? 0o777 };
      }
      if (state.files.has(key)) {
        return { mode: state.fileModes.get(key) ?? 0o666 };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${key}'`);
    }),
    chmod: vi.fn(async (p: string, mode: number) => {
      const key = String(p);
      if (state.dirs.has(key)) {
        state.dirModes.set(key, mode);
        return;
      }
      if (state.files.has(key)) {
        state.fileModes.set(key, mode);
        return;
      }
      throw new Error(`ENOENT: no such file or directory, chmod '${key}'`);
    }),
    unlink: vi.fn(async (p: string) => {
      state.files.delete(String(p));
    }),
    writeFile: vi.fn(async (p: string, data: string, opts?: { mode?: number }) => {
      const key = String(p);
      state.files.set(key, data);
      state.dirs.add(String(key.split("/").slice(0, -1).join("/")));
      state.fileModes.set(key, opts?.mode ?? 0o666);
    }),
  };
  return { ...wrapped, default: wrapped };
});

beforeEach(() => {
  state.launchctlCalls.length = 0;
  state.listOutput = "";
  state.printOutput = "";
  state.psOutput = "";
  state.bootstrapError = "";
  state.kickstartError = "";
  state.kickstartFailuresRemaining = 0;
  state.dirs.clear();
  state.dirModes.clear();
  state.files.clear();
  state.fileModes.clear();
  launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReset();
  launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReturnValue(false);
  launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReset();
  launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReturnValue({
    ok: true,
    pid: 7331,
  });
  vi.clearAllMocks();
});

describe("launchd runtime parsing", () => {
  it("parses state, pid, and exit status", () => {
    const output = [
      "state = running",
      "pid = 4242",
      "last exit status = 1",
      "last exit reason = exited",
    ].join("\n");
    expect(parseLaunchctlPrint(output)).toEqual({
      state: "running",
      pid: 4242,
      lastExitStatus: 1,
      lastExitReason: "exited",
    });
  });

  it("does not set pid when pid = 0", () => {
    const output = ["state = running", "pid = 0"].join("\n");
    const info = parseLaunchctlPrint(output);
    expect(info.pid).toBeUndefined();
    expect(info.state).toBe("running");
  });

  it("sets pid for positive values", () => {
    const output = ["state = running", "pid = 1234"].join("\n");
    const info = parseLaunchctlPrint(output);
    expect(info.pid).toBe(1234);
  });

  it("does not set pid for negative values", () => {
    const output = ["state = waiting", "pid = -1"].join("\n");
    const info = parseLaunchctlPrint(output);
    expect(info.pid).toBeUndefined();
    expect(info.state).toBe("waiting");
  });

  it("rejects pid and exit status values with junk suffixes", () => {
    const output = [
      "state = waiting",
      "pid = 123abc",
      "last exit status = 7ms",
      "last exit reason = exited",
    ].join("\n");
    expect(parseLaunchctlPrint(output)).toEqual({
      state: "waiting",
      lastExitReason: "exited",
    });
  });
});

describe("launchctl list detection", () => {
  it("detects the resolved label in launchctl list", async () => {
    state.listOutput = "123 0 ai.openclaw.gateway\n";
    const listed = await isLaunchAgentListed({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
    });
    expect(listed).toBe(true);
  });

  it("returns false when the label is missing", async () => {
    state.listOutput = "123 0 com.other.service\n";
    const listed = await isLaunchAgentListed({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
    });
    expect(listed).toBe(false);
  });
});

describe("launchd bootstrap repair", () => {
  it("enables, bootstraps, and kickstarts the resolved label", async () => {
    const env: Record<string, string | undefined> = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
    const repair = await repairLaunchAgentBootstrap({ env });
    expect(repair.ok).toBe(true);

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const plistPath = resolveLaunchAgentPlistPath(env);
    const serviceId = `${domain}/${label}`;

    const enableIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "enable" && c[1] === serviceId,
    );
    const bootstrapIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath,
    );
    const kickstartIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "kickstart" && c[1] === "-k" && c[2] === serviceId,
    );

    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(kickstartIndex).toBeGreaterThanOrEqual(0);
    expect(enableIndex).toBeLessThan(bootstrapIndex);
    expect(bootstrapIndex).toBeLessThan(kickstartIndex);
  });
});

describe("launchd install", () => {
  function createDefaultLaunchdEnv(): Record<string, string | undefined> {
    return {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
  }

  it("enables service before bootstrap (clears persisted disabled state)", async () => {
    const env = createDefaultLaunchdEnv();
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const plistPath = resolveLaunchAgentPlistPath(env);
    const serviceId = `${domain}/${label}`;

    const enableIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "enable" && c[1] === serviceId,
    );
    const bootstrapIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath,
    );
    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(enableIndex).toBeLessThan(bootstrapIndex);
  });

  it("writes TMPDIR to LaunchAgent environment when provided", async () => {
    const env = createDefaultLaunchdEnv();
    const tmpDir = "/var/folders/xy/abc123/T/";
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
      environment: { TMPDIR: tmpDir },
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    const plist = state.files.get(plistPath) ?? "";
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>TMPDIR</key>");
    expect(plist).toContain(`<string>${tmpDir}</string>`);
  });

  it("writes KeepAlive=true policy with restrictive umask", async () => {
    const env = createDefaultLaunchdEnv();
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    const plist = state.files.get(plistPath) ?? "";
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).not.toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<key>Umask</key>");
    expect(plist).toContain(`<integer>${LAUNCH_AGENT_UMASK_DECIMAL}</integer>`);
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain(`<integer>${LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS}</integer>`);
  });

  it("tightens writable bits on launch agent dirs and plist", async () => {
    const env = createDefaultLaunchdEnv();
    state.dirs.add(env.HOME!);
    state.dirModes.set(env.HOME!, 0o777);
    state.dirs.add("/Users/test/Library");
    state.dirModes.set("/Users/test/Library", 0o777);

    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    expect(state.dirModes.get(env.HOME!)).toBe(0o755);
    expect(state.dirModes.get("/Users/test/Library")).toBe(0o755);
    expect(state.dirModes.get("/Users/test/Library/LaunchAgents")).toBe(0o755);
    expect(state.fileModes.get(plistPath)).toBe(0o644);
  });

  it("restarts LaunchAgent: bootout → ensurePidGone → bootstrap → kickstart (no -k)", async () => {
    const env = createDefaultLaunchdEnv();
    const result = await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const plistPath = resolveLaunchAgentPlistPath(env);
    const serviceId = `${domain}/${label}`;
    expect(result).toEqual({ outcome: "completed" });
    // New sequence: bootout first, then bootstrap, then kickstart (no -k).
    expect(state.launchctlCalls.some((call) => call[0] === "bootout")).toBe(true);
    expect(state.launchctlCalls.some((call) => call[0] === "bootstrap")).toBe(true);
    expect(state.launchctlCalls).toContainEqual(["kickstart", serviceId]);
    // Must NOT use kickstart -k (that would start new process before old one exits).
    expect(state.launchctlCalls.some((c) => c[0] === "kickstart" && c[1] === "-k")).toBe(false);
    // Verify ordering: bootout before bootstrap before kickstart.
    const bootoutIdx = state.launchctlCalls.findIndex((c) => c[0] === "bootout");
    const bootstrapIdx = state.launchctlCalls.findIndex((c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath);
    const kickstartIdx = state.launchctlCalls.findIndex((c) => c[0] === "kickstart" && c[1] === serviceId);
    expect(bootoutIdx).toBeLessThan(bootstrapIdx);
    expect(bootstrapIdx).toBeLessThan(kickstartIdx);
  });

  it("kickstart failure in restart path surfaces error after bootout+bootstrap", async () => {
    const env = createDefaultLaunchdEnv();
    state.kickstartError = "Could not find service";
    state.kickstartFailuresRemaining = 1;

    await expect(
      restartLaunchAgent({
        env,
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow("launchctl kickstart failed: Could not find service");

    // bootout and bootstrap are still called (they precede kickstart in the new flow).
    expect(state.launchctlCalls.some((call) => call[0] === "bootout")).toBe(true);
    expect(state.launchctlCalls.some((call) => call[0] === "bootstrap")).toBe(true);
  });

  it("surfaces kickstart failure after bootout+bootstrap; does not retry", async () => {
    const env = createDefaultLaunchdEnv();
    state.kickstartError = "Input/output error";
    state.kickstartFailuresRemaining = 1;

    await expect(
      restartLaunchAgent({
        env,
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow("launchctl kickstart failed: Input/output error");

    // In the new flow, enable and bootstrap are always called before kickstart.
    expect(state.launchctlCalls.some((call) => call[0] === "enable")).toBe(true);
    expect(state.launchctlCalls.some((call) => call[0] === "bootstrap")).toBe(true);
    // No retry after kickstart failure.
    expect(state.launchctlCalls.filter((c) => c[0] === "kickstart")).toHaveLength(1);
  });

  it("hands restart off to a detached helper when invoked from the current LaunchAgent", async () => {
    const env = createDefaultLaunchdEnv();
    launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReturnValue(true);

    const result = await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    expect(result).toEqual({ outcome: "scheduled" });
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff).toHaveBeenCalledWith({
      env,
      mode: "kickstart",
      waitForPid: process.pid,
    });
    expect(state.launchctlCalls).toEqual([]);
  });

  it("shows actionable guidance when launchctl gui domain does not support bootstrap", async () => {
    state.bootstrapError = "Bootstrap failed: 125: Domain does not support specified action";
    const env = createDefaultLaunchdEnv();
    let message = "";
    try {
      await installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("logged-in macOS GUI session");
    expect(message).toContain("wrong user (including sudo)");
    expect(message).toContain("https://docs.openclaw.ai/gateway");
  });

  it("surfaces generic bootstrap failures without GUI-specific guidance", async () => {
    state.bootstrapError = "Operation not permitted";
    const env = createDefaultLaunchdEnv();

    await expect(
      installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      }),
    ).rejects.toThrow("launchctl bootstrap failed: Operation not permitted");
  });
});

describe("resolveLaunchAgentPlistPath", () => {
  it.each([
    {
      name: "uses default label when OPENCLAW_PROFILE is unset",
      env: { HOME: "/Users/test" },
      expected: "/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist",
    },
    {
      name: "uses profile-specific label when OPENCLAW_PROFILE is set to a custom value",
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "jbphoenix" },
      expected: "/Users/test/Library/LaunchAgents/ai.openclaw.jbphoenix.plist",
    },
    {
      name: "prefers OPENCLAW_LAUNCHD_LABEL over OPENCLAW_PROFILE",
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "jbphoenix",
        OPENCLAW_LAUNCHD_LABEL: "com.custom.label",
      },
      expected: "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    },
    {
      name: "trims whitespace from OPENCLAW_LAUNCHD_LABEL",
      env: {
        HOME: "/Users/test",
        OPENCLAW_LAUNCHD_LABEL: "  com.custom.label  ",
      },
      expected: "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    },
    {
      name: "ignores empty OPENCLAW_LAUNCHD_LABEL and falls back to profile",
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "myprofile",
        OPENCLAW_LAUNCHD_LABEL: "   ",
      },
      expected: "/Users/test/Library/LaunchAgents/ai.openclaw.myprofile.plist",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveLaunchAgentPlistPath(env)).toBe(expected);
  });
});

describe("stopLaunchAgent — ensurePidGone integration", () => {
  const testEnv = { HOME: "/Users/test", OPENCLAW_PROFILE: "default" };
  const testPid = 77777;
  let processKillSpy: ReturnType<typeof vi.spyOn>;
  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true as unknown as void);
    nowSpy = null;
  });

  afterEach(() => {
    processKillSpy.mockRestore();
    nowSpy?.mockRestore();
  });

  it("stops successfully when launchctl print shows no PID — skips process.kill entirely", async () => {
    state.printOutput = "state = stopped";

    const stdout = new PassThrough();
    await stopLaunchAgent({ env: testEnv, stdout });

    expect(processKillSpy).not.toHaveBeenCalled();
    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    expect(state.launchctlCalls).toContainEqual(["bootout", `${domain}/${label}`]);
  });

  it("waits for graceful exit when kill(0) immediately throws ESRCH — no SIGKILL needed", async () => {
    state.printOutput = `state = running\npid = ${testPid}`;
    state.psOutput = "Mon Apr 19 09:00:00 2026";

    // kill(pid, 0) → ESRCH: process already gone; kill(pid, "SIGKILL") should not be called
    processKillSpy.mockImplementation((_p: number, sig: number | string) => {
      if (sig === 0) {
        const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        throw err;
      }
      return true as unknown as void;
    });

    const chunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
    await stopLaunchAgent({ env: testEnv, stdout });

    expect(processKillSpy).not.toHaveBeenCalledWith(testPid, "SIGKILL");
    expect(chunks.join("")).not.toContain("Warning:");
  });

  it("sends SIGKILL when the process survives the graceful wait, then confirms gone via ESRCH", async () => {
    state.printOutput = `state = running\npid = ${testPid}`;
    state.psOutput = "Mon Apr 19 09:00:00 2026"; // same identity → original process

    // Expire the waitForPidExit loop immediately: first call sets deadline,
    // subsequent calls return a value past it so the while-condition is false.
    let nowCallCount = 0;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCallCount++;
      return nowCallCount === 1 ? 0 : 20_000; // past 10 s deadline on 2nd+ call
    });

    // kill(pid, 0) during the SIGKILL confirmation loop → ESRCH (reaping done)
    processKillSpy.mockImplementation((_p: number, sig: number | string) => {
      if (sig === "SIGKILL") return true as unknown as void;
      const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      throw err;
    });

    const chunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
    await stopLaunchAgent({ env: testEnv, stdout });

    expect(processKillSpy).toHaveBeenCalledWith(testPid, "SIGKILL");
    expect(chunks.join("")).not.toContain("Warning:");
  });

  it("emits a warning when SIGKILL itself fails with EPERM — port may not be free", async () => {
    state.printOutput = `state = running\npid = ${testPid}`;
    state.psOutput = "Mon Apr 19 09:00:00 2026";

    let nowCallCount = 0;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCallCount++;
      return nowCallCount === 1 ? 0 : 20_000;
    });

    processKillSpy.mockImplementation((_p: number, sig: number | string) => {
      if (sig === "SIGKILL") {
        const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
        throw err;
      }
      // kill(0) during waitForPidExit: process is alive
      return true as unknown as void;
    });

    const chunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
    await stopLaunchAgent({ env: testEnv, stdout });

    expect(chunks.join("")).toContain("Warning:");
    expect(chunks.join("")).toContain(String(testPid));
  });

  it("skips SIGKILL when PID identity changes — treats recycled PID as original process gone", async () => {
    // Scenario: process exits after bootout but PID is reused before our identity
    // re-check inside ensurePidGone.  waitForPidExit times out (kill(0) never throws),
    // but when we re-validate with getPidStartTime the start time has changed, so we
    // return true ("original process is gone") without sending SIGKILL.
    const originalPsOutput = "Mon Apr 19 09:00:00 2026";
    const recycledPsOutput = "Mon Apr 19 09:01:00 2026";

    // First ps call (before bootout) → original start time.
    state.printOutput = `state = running\npid = ${testPid}`;
    state.psOutput = originalPsOutput;

    // kill(0) never throws — process appears alive to waitForPidExit.
    // We expire the timer via Date.now() instead, and switch psOutput on the
    // first expiry so the identity re-check (second getPidStartTime call) sees
    // the recycled start time.
    let nowCallCount = 0;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCallCount++;
      if (nowCallCount === 1) {
        // waitForPidExit sets deadline: return 0 so deadline = TIMEOUT_MS
        return 0;
      }
      // All subsequent calls: return a value past the deadline.
      // Also switch psOutput here so the identity re-check (which happens right
      // after waitForPidExit returns) sees the recycled start time.
      state.psOutput = recycledPsOutput;
      return 20_000;
    });

    const chunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
    await stopLaunchAgent({ env: testEnv, stdout });

    // SIGKILL must NOT be sent — identity mismatch means original process already gone.
    expect(processKillSpy).not.toHaveBeenCalledWith(testPid, "SIGKILL");
    expect(chunks.join("")).not.toContain("Warning:");
  });

  it("restartLaunchAgent captures prevPid from printOutput and calls ensurePidGone path", async () => {
    // When printOutput contains a running PID, restartLaunchAgent should capture it
    // and pass it to ensurePidGone. Graceful exit (ESRCH on kill 0) → no warning.
    const env = testEnv;
    state.printOutput = `state = running\npid = ${testPid}`;
    state.psOutput = "Mon Apr 19 09:00:00 2026";

    processKillSpy.mockImplementation((_p: number, sig: number | string) => {
      if (sig === 0) {
        const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        throw err;
      }
      return true as unknown as void;
    });

    const chunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
    const result = await restartLaunchAgent({ env, stdout });

    expect(result).toEqual({ outcome: "completed" });
    // process.kill should have been called (at least the kill(0) check during ensurePidGone)
    expect(processKillSpy).toHaveBeenCalledWith(testPid, 0);
    expect(processKillSpy).not.toHaveBeenCalledWith(testPid, "SIGKILL");
    expect(chunks.join("")).not.toContain("Warning:");
  });

  it("ensurePidGone is called before kickstart in main restart path when prevPid is known", async () => {
    // The new flow always does: bootout → ensurePidGone → bootstrap → kickstart.
    // Verify that ensurePidGone (via kill(0) liveness check) runs before kickstart.
    const env = testEnv;
    state.printOutput = `state = running\npid = ${testPid}`;
    state.psOutput = "Mon Apr 19 09:00:00 2026";

    // kill(0) → ESRCH: process gracefully exited, no SIGKILL needed.
    processKillSpy.mockImplementation((_p: number, sig: number | string) => {
      if (sig === 0) {
        const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        throw err;
      }
      return true as unknown as void;
    });

    const chunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
    const result = await restartLaunchAgent({ env, stdout });

    expect(result).toEqual({ outcome: "completed" });
    // ensurePidGone should have polled liveness via kill(0) for the pre-bootout PID.
    expect(processKillSpy).toHaveBeenCalledWith(testPid, 0);
    expect(processKillSpy).not.toHaveBeenCalledWith(testPid, "SIGKILL");
    expect(chunks.join("")).not.toContain("Warning:");
  });

  it("restart path emits warning when ensurePidGone returns false (EPERM) before kickstart", async () => {
    // If SIGKILL throws EPERM, ensurePidGone returns false and a warning is emitted
    // before kickstart starts the new process.
    const env = testEnv;
    state.printOutput = `state = running\npid = ${testPid}`;
    state.psOutput = "Mon Apr 19 09:00:00 2026";

    let nowCallCount = 0;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCallCount++;
      return nowCallCount === 1 ? 0 : 20_000;
    });

    // kill(0) never throws → process appears alive; SIGKILL throws EPERM → returns false
    processKillSpy.mockImplementation((_p: number, sig: number | string) => {
      if (sig === "SIGKILL") {
        const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
        throw err;
      }
      return true as unknown as void;
    });

    const chunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
    const result = await restartLaunchAgent({ env, stdout });

    expect(result).toEqual({ outcome: "completed" });
    expect(chunks.join("")).toContain("Warning:");
    expect(chunks.join("")).toContain(String(testPid));
  });
});
