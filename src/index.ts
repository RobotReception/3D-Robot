/** Robot Avatar Engine - public API */
export { RobotAvatar } from "./engine/RobotAvatar";
export { findPath, resolve as resolveCollision, nearestFree, isFree, emptyWorld } from "./engine/world";
export type { World, WorldBox, WorldCircle, Point2 } from "./engine/world";
export type {
  RobotEvents, SpeakOptions, SpeechHandle, StreamSpeechOptions, StreamSpeechHandle, AnimationHandle, Vec3, RobotAvatarOptions,
} from "./engine/RobotAvatar";
export { AnimationController } from "./engine/AnimationController";
export type { PlayOptions, PlayResult } from "./engine/AnimationController";
export { BUILTIN_CLIPS } from "./engine/library";
export { CHANNELS, bakeClip } from "./engine/clips";
export type { Channel, ClipDef, PoseFrame } from "./engine/clips";
export { FaceController, EMOTIONS, EYE_EXPRESSIONS } from "./engine/FaceController";
export type { EmotionName, EyeExpression } from "./engine/FaceController";
export { LipSyncController } from "./engine/lipsync/LipSyncController";
export { VISEMES } from "./engine/lipsync/visemes";
export type { Viseme, VisemeEvent } from "./engine/lipsync/visemes";
export { textToVisemeEvents, estimateSpeechDuration } from "./engine/lipsync/phonemizer";
export { fromAzureVisemes, fromRhubarb, fromWordTimings, fromCharacterAlignment } from "./engine/lipsync/adapters";
export { analyzeAudioBuffer } from "./engine/lipsync/audioAnalysis";
export { alignTextToActivity, activeIntervals } from "./engine/lipsync/align";
export { AudioController } from "./engine/AudioController";
export { AssistantStateMachine, ASSISTANT_STATES } from "./engine/stateMachine";
export type { AssistantState } from "./engine/stateMachine";
export { executeCommand, executeMessage, COMMAND_NAMES } from "./engine/commands";
export type { RobotCommand, CommandResult } from "./engine/commands";
export { attachBridge, connectWebSocket } from "./engine/bridge";
export type { BridgeTransport } from "./engine/bridge";
export {
  JOINT_DEFS, REQUIRED_BONES, REQUIRED_MORPHS, HAND_PRESETS, armPose, headPose, fingerPose, rawLimits,
} from "./engine/rig";
export type { ArmAngles, HeadAngles, EulerDeg, Side } from "./engine/rig";
export { loadRobotGLTF, parseRobotGLTF, inspectRobotModel } from "./engine/loader";
export { RobotViewer, webglSupported, WebGLUnavailableError } from "./viewer/RobotViewer";
export type { QualityLevel, CameraPreset, BackgroundPreset, ViewerStats } from "./viewer/RobotViewer";
export { compileMotion, exportMotion, MOTION_SCHEMA } from "./engine/motionJson";
export type { MotionJson, MotionKey, MotionEvent, CompileResult } from "./engine/motionJson";
