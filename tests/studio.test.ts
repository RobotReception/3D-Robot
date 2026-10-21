import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioCore } from "../src/studio/core";
import { RobotAvatar } from "../src/engine/RobotAvatar";
import { makeRobot } from "./helpers/robot";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Studio model loading", () => {
  it("disposes stale loads and keeps only the latest requested model", async () => {
    vi.stubGlobal("window", {});
    const core = new StudioCore();
    const first = await makeRobot();
    const second = await makeRobot();
    const staleDispose = vi.spyOn(first, "dispose");
    let finishFirst!: (r: RobotAvatar) => void;
    vi.spyOn(RobotAvatar, "load").mockImplementationOnce(() => new Promise((r) => { finishFirst = r; })).mockResolvedValueOnce(second);
    core.viewer = { add: vi.fn(), remove: vi.fn(), dispose: vi.fn() } as unknown as StudioCore["viewer"];
    const pending = core.loadStyle("friendly");
    await core.loadStyle("premium");
    finishFirst(first);
    await pending;
    expect(core.robot).toBe(second);
    expect(core.style).toBe("premium");
    expect(staleDispose).toHaveBeenCalledOnce();
    expect(core.viewer.add).toHaveBeenCalledTimes(1);
    second.dispose();
  });

  it("keeps the current model when its replacement fails", async () => {
    const core = new StudioCore();
    const robot = await makeRobot();
    core.robot = robot;
    vi.spyOn(RobotAvatar, "load").mockRejectedValueOnce(new Error("network failure"));
    await expect(core.loadStyle("friendly")).resolves.toBeUndefined();
    expect(core.robot).toBe(robot);
    expect(core.log.at(-1)?.type).toBe("error");
    robot.dispose();
  });

  it("disposes a model that finishes loading after unmount", async () => {
    const core = new StudioCore();
    const robot = await makeRobot();
    const dispose = vi.spyOn(robot, "dispose");
    let finish!: (r: RobotAvatar) => void;
    vi.spyOn(RobotAvatar, "load").mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    const pending = core.loadStyle("friendly");
    core.dispose();
    finish(robot);
    await pending;
    expect(dispose).toHaveBeenCalledOnce();
    expect(core.robot).toBeUndefined();
  });
});
