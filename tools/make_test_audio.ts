// Generates the synthetic demo audio in public/audio (formant synthesis, CC0 - no recorded speech).
import fs from "node:fs";
import { encodeWav, synthesize, type Segment } from "../tests/helpers/synth";

const dir = new URL("../public/audio/", import.meta.url).pathname;
fs.mkdirSync(dir, { recursive: true });

// 1) vowel sweep with pauses and an "s": exercises the audio-driven (text-free) path
const vowels: Segment[] = [];
for (const v of ["aa", "E", "I", "O", "U"]) vowels.push({ kind: "vowel", v, dur: 0.38 }, { kind: "sil", dur: 0.16 });
vowels.push({ kind: "fric", dur: 0.3 }, { kind: "sil", dur: 0.2 }, { kind: "vowel", v: "aa", dur: 0.45 });
fs.writeFileSync(dir + "vowels.wav", encodeWav(synthesize(vowels, 22050).samples, 22050));

// 2) "hello" shaped utterance: h(silence-ish noise) - e - l - o  (pair it with text "hello" for hybrid sync)
const hello: Segment[] = [
  { kind: "sil", dur: 0.12 }, { kind: "fric", dur: 0.07, amp: 0.2 }, { kind: "vowel", v: "E", dur: 0.16 }, { kind: "nasal", dur: 0.09 },
  { kind: "vowel", v: "O", dur: 0.3, amp: 0.55 }, { kind: "sil", dur: 0.25 },
];
fs.writeFileSync(dir + "hello.wav", encodeWav(synthesize(hello, 22050).samples, 22050));
console.log("wrote", dir);
