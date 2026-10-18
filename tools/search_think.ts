import * as THREE from "three";
import { loadModelNode } from "../tests/helpers/loadRobot";
import { JointSpace, armPose } from "../src/engine/rig";
const { parts } = await loadModelNode("premium");
const container = new THREE.Group(); container.add(parts.scene);
const js = new JointSpace(container);
const tip = (p:any)=>{ js.resetAll(); for (const [b,e] of Object.entries(p) as any) js.setEuler(b,{x:e[0],y:e[1],z:e[2]}); container.updateMatrixWorld(true);
  const w=js.bone("hand_R").getWorldPosition(new THREE.Vector3()); const f=js.bone("finger_index_2_R").getWorldPosition(new THREE.Vector3()); return {w,f}; };
const target = new THREE.Vector3(-0.045,1.13,0.2);
let best=1e9, bp:any=null;
for(let i=0;i<150000;i++){
  const a={shoulder:Math.random()*100, abduction:Math.random()*60-25, twist:Math.random()*220-90, elbow:60+Math.random()*90, wristFlex:Math.random()*80-50};
  const {f}=tip(armPose("R",a)); const d=f.distanceTo(target);
  if(d<best){best=d;bp=a;}
}
console.log(best, bp, tip(armPose("R",bp)).w.toArray());
