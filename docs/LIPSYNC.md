# Speech & lip-sync

## Pipeline

```
 text ──► phonemizer (EN/AR rules) ─┐
 TTS viseme/word timings ───────────┼─► VisemeTimeline ─► LipSyncController ─► FaceController (viseme_* morphs)
 audio file ─► offline analysis ────┤        ▲ audio clock (Web Audio)  ▲ loudness envelope (hybrid gate)
 live audio (stream/mic) ─► frame analysis ──────────────────────────────┘
```

Visemes use the 15-shape Oculus/OVR set (`sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, E, I, O, U`) = the mouth shape keys `viseme_*`.
The controller samples the timeline **at the audio clock** (not at frame count), looks ahead 30 ms (mouths lead sound), spring-smooths 35 ms, keeps the sum of viseme weights ≤ 1, scales expression morphs down 60 % while speaking (a smile never stretches an "O"), and returns the mouth to rest at the end. Eyes keep blinking/looking, the head bobs with articulation energy, and talk gestures run on the arms while speaking.

## Approach 1 — audio-driven (`analyzeAudioBuffer`, `LipSyncController.startLive`)

Per 40 ms frame (20 ms hop): RMS energy gate → silence; high-band (>3.5 kHz) dominance + zero-crossing → fricative (`SS`/`CH`); otherwise LPC (order ≈ 16 at 11 kHz) spectral-envelope peaks → F1/F2 → nearest vowel in log-formant space (`aa E I O U`, softly weighted); articulation scaled by level; flicker < 2 frames removed; event times centred on the analysis window. A quiet-audio floor (`MIN_REF_RMS`) prevents noise being normalised into "speech".
**Recognises vowel shapes and openness only.** Plosives appear as closures/dips; consonants other than fricatives are not distinguished. Language independent.

## Approach 2 — text / phoneme-based (`textToVisemeEvents`, `adapters.ts`)

- **English/Arabic rules** (`phonemizer.ts`): digraphs (th, sh, ch, ph, ng, qu, ee, oo, ou…), silent final *e*, doubled consonants; Arabic letters → visemes, harakat (fatha → `aa`, damma → `U`, kasra → `I`, tanween), **shadda lengthens** the consonant, long vowels (ا و ي) vs consonant use, and short implicit vowels inserted between consonants in **unvocalised** text. Mixed Arabic/English text and punctuation pauses are handled. This is an approximation of spelling, not a pronunciation dictionary (no stress, dialect, loanword or numeral expansion).
- **Exact timings from your TTS** (preferred): `fromAzureVisemes` (Azure viseme IDs 0–21 → our set; verify the table against the current Azure docs), `fromCharacterAlignment` (ElevenLabs-style character timings → word windows → phoneme units), `fromWordTimings`, `fromRhubarb` (Rhubarb JSON cues). Pass the result as `speak({ visemes })` or `speakStream().pushVisemes()`.

## Approach 3 — hybrid (default for audio + text)

`alignTextToActivity`: detects the *speech runs* in the audio (loudness envelope, merges gaps < 90 ms), splits the text into phrases at long pauses (comma/full stop), maps phrase *i* onto run *i* (or spreads everything over all active time when the counts differ), and distributes units inside each run. The envelope additionally gates the visemes (`lipsync.hybrid`, 0…1) so the mouth closes in real silences. Tune with `lipsync.offsetMs` (± ms) and `gain`.

## Streaming

`speakStream({sampleRate})` plays PCM16 chunks gaplessly (small jitter buffer) and by default drives the mouth from the **live audio analysis**; if your TTS also sends visemes, `pushVisemes()` switches to timeline mode on the stream clock. `LipSyncController.pushEvents/endStream` can be used directly.

## Browser TTS (`speechSynthesis`)

No access to the audio, so the mouth follows the text timeline (estimated duration at the chosen rate) and re-syncs on the `boundary` events when the voice emits them. Availability of voices (especially Arabic) and of `boundary` varies per OS/browser; with no voice the Studio uses a **silent timed preview**. For production quality use a TTS API that returns audio + timings.

## Measured quality (see TESTING.md for conditions)

- Audio analysis on formant-synthesised vowels `a e i o u` + `s` at 16/22.05/44.1 kHz: all segments labelled correctly, onsets within ≈ 20–40 ms; in Chromium, 100 % of mouth samples in the segment interiors matched the expected viseme while playing through Web Audio.
- Hybrid on a "hello"-shaped synthetic clip: mouth closed in the leading/trailing silence (mean opening ≤ 0.12) and open during speech (≈ 0.94).
- **Not measured:** accuracy on recorded human speech, noisy audio, or any real TTS output.
