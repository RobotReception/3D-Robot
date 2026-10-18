import { Canvas } from "@react-three/fiber";
import { createRoot } from "react-dom/client";
import { Robot } from "../../src/adapters/r3f";
import type { RobotAvatar } from "../../src/index";

function Scene() {
  return (
    <Canvas camera={{ position: [0, 1.1, 3.4], fov: 35 }} shadows>
      <color attach="background" args={["#10131a"]} />
      <ambientLight intensity={1.2} />
      <directionalLight position={[2.5, 4, 3]} intensity={2.4} castShadow />
      <Robot
        url="../models/robot_premium.glb"
        onReady={(r: RobotAvatar) => {
          (window as unknown as { robot: RobotAvatar }).robot = r;
          r.playAnimation("greeting");
        }}
      />
    </Canvas>
  );
}

createRoot(document.getElementById("root")!).render(<Scene />);
