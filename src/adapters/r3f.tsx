import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { RobotAvatar, type RobotAvatarOptions } from "../engine/RobotAvatar";

/**
 * React Three Fiber adapter. The engine itself has no React dependency; this is all it takes:
 *
 *   <Canvas><Robot url="/models/robot_premium.glb" onReady={(r) => r.playAnimation("greeting")} /></Canvas>
 *
 * The robot is advanced from R3F's own render loop (`useFrame`), so it pauses/resumes with the canvas.
 */
export function Robot({ url, onReady, options }: { url: string; onReady?: (robot: RobotAvatar) => void; options?: RobotAvatarOptions }) {
  const [robot, setRobot] = useState<RobotAvatar | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let dead = false;
    let r: RobotAvatar | null = null;
    RobotAvatar.load(url, options).then((x) => {
      if (dead) return x.dispose();
      r = x;
      setRobot(x);
      onReady?.(x);
      invalidate();
    });
    return () => {
      dead = true;
      r?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  useFrame((_, dt) => robot?.update(dt));
  return robot ? <primitive object={robot.root} /> : null;
}
