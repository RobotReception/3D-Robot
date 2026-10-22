import assert from "node:assert/strict";

const root = await import("robot-avatar-engine");
assert.equal(typeof root.RobotAvatar, "function");
assert.equal(typeof root.RobotViewer, "function");
assert.ok(root.BUILTIN_CLIPS.length > 0);

const viewer = await import("robot-avatar-engine/viewer");
assert.equal(viewer.RobotViewer, root.RobotViewer);

const react = await import("robot-avatar-engine/react");
assert.equal(typeof react.Robot, "function");

console.log("package exports ok");
