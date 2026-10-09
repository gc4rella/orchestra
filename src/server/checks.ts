/** Wall-clock limit for one run of a plan's verify command. */
export const CHECK_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL = 8_000;

export type CheckResult = { ok: boolean; output: string };

/**
 * Runs a plan's verify command (install, test, build) through `sh` in `cwd`.
 * The command comes from the director or the user, with the same trust as the agents' own shell access.
 */
export async function runCheck(cwd: string, command: string, signal?: AbortSignal, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // Its own process group, so a timeout also stops the test runners and servers the command started.
  // bun-types 1.2.15 omit `detached` although the runtime supports it.
  const options = { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true } as const;
  const proc = Bun.spawn(["sh", "-c", `exec 2>&1; ${command}`], options as Omit<typeof options, "detached">);
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  };
  stop.addEventListener("abort", kill, { once: true });
  if (stop.aborted) kill();
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  stop.removeEventListener("abort", kill);

  const tail = out.length > OUTPUT_TAIL ? `…${out.slice(-OUTPUT_TAIL)}` : out;
  if (signal?.aborted) return { ok: false, output: "cancelled" };
  if (timeout.aborted) return { ok: false, output: `${tail.trimEnd()}\n\nTimed out after ${Math.round(timeoutMs / 60_000)} minutes.` };
  return { ok: code === 0, output: code === 0 ? tail : `${tail.trimEnd()}\n\nExited with code ${code}.` };
}
