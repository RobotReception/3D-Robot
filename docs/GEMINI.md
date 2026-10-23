# ربط الروبوت بـ Gemini: تسأل، فيفكّر ويجيب ويتفاعل

> **الخلاصة:** تكتب سؤالاً (أو تتحدث) ← الروبوت **يفكّر** فوراً (يد على الذقن) ← **Gemini** يبثّ الإجابة ← الروبوت **ينطق** أول جملة قبل اكتمال الرد، وفمه ورأسه وحاجباه ويداه تتحرك مع **الكلمات المشددة وعلامات الترقيم** ← يعود لوضع الاستعداد.
> كل شيء جاهز: وحدة في المحرك (`RobotAssistant`) + خادم وسيط صغير يحمي مفتاحك + صفحة مثال + اختبارات.

```
 المتصفح (الروبوت)                    خادمك (يحمل المفتاح)                 Google
┌────────────────────┐   /api/chat    ┌─────────────────────┐  streamGenerateContent
│ RobotAssistant     │ ─────────────▶ │ examples/gemini/    │ ─────────────────────▶ Gemini (نص)
│  • يحلّل الوسوم     │ ◀── SSE نص ─── │ server.ts           │ ◀── أجزاء النص ────────
│  • يقطّع الجمل      │   /api/tts     │  • يخفي المفتاح      │  generateContent (AUDIO)
│  • يبثّ الصوت       │ ─────────────▶ │  • حدود الاستخدام    │ ─────────────────────▶ Gemini (صوت)
│ RobotAvatar        │ ◀── PCM 24kHz ─│  • يتحقق من المدخلات │ ◀── PCM base64 ────────
│  فم/رأس/يدان/حواجب │                └─────────────────────┘
└────────────────────┘
```

---

## 1) التشغيل السريع (٥ دقائق)

```bash
git clone https://github.com/RobotReception/3D-Robot.git && cd 3D-Robot
git checkout claude/awesome-noether-ve29yd
npm install
cp .env.example .env            # ثم ضع مفتاحك في GEMINI_API_KEY=
```

1. **احصل على مفتاح** من <https://aistudio.google.com/apikey> وضعه في ملف `.env` (الملف مُستثنى من git).
2. **شغّل الخادم الوسيط** (نافذة أولى): `npm run gemini:server` ← يطبع `Gemini proxy on http://localhost:8788 ... key=set`.
3. **شغّل الموقع** (نافذة ثانية): `npm run dev` ثم افتح **<http://localhost:5173/examples/gemini.html>**.
4. اكتب سؤالاً بالعربية أو الإنجليزية، أو اضغط 🎤 وتحدّث (Chrome / Edge).

**للإنتاج (عملية واحدة):** `npm run build && npm run gemini:server` ثم افتح `http://localhost:8788/examples/gemini.html` (الخادم يقدّم مجلد `dist` أيضاً).

**للتجربة بدون مفتاح** (خادم Gemini وهمي بنفس صيغة الواجهة، مفيد للتطوير والاختبارات):

```bash
npm run gemini:mock                                                         # نافذة 1: http://localhost:8799
GEMINI_BASE_URL=http://localhost:8799 GEMINI_API_KEY=test-key npm run gemini:server   # نافذة 2
npm run dev                                                                 # نافذة 3
```

> أوامر ويندوز: بدل `VAR=x cmd` استخدم `set VAR=x&& cmd` في CMD، أو ضع المتغيرات في `.env`.

---

## 2) ماذا يحدث عند كل سؤال

| المرحلة | ما يراه المستخدم | ما يحدث داخلياً |
|---|---|---|
| **السؤال** | — | `assistant.ask(text)`؛ أي إجابة جارية تُقاطَع (barge-in) |
| **تفكير** | الروبوت يضع يده على ذقنه وينظر بعيداً (`state: thinking`) فوراً قبل أي شبكة | الطلب يذهب للخادم ← Gemini |
| **أول جملة** | يبدأ الكلام عند اكتمال **أول جملة** فقط (لا ينتظر كل الرد) | النص يُقطَّع عند نهايات الجمل؛ كل جملة تذهب لـ TTS؛ الجملة التالية تُجهَّز أثناء نطق الحالية (`prefetch`) |
| **أثناء الكلام** | فم متناسق، إيماءة رأس وحاجب على الكلمات المهمة، ضربة يد تسبق الكلمة، رمشة عند التوقف، ميل الرأس عند «؟» | الصوت يُبثّ في **تيار واحد بلا فجوات** (`speakStream`)؛ وحدات الفم تُحاذى مع **الصوت الحقيقي** وتحمل التشديد وعلامات الترقيم لـ `SpeechPerformer` ([LIPSYNC.md](LIPSYNC.md)) |
| **وسوم النموذج** | يرفع يده للتحية، يبتسم، يبدو فضولياً... في اللحظة التي تُنطق فيها جملتها | `[emotion=…]` و`[gesture=…]` تُزال من النص وتُنفَّذ عند بدء نطق جملتها |
| **النهاية** | يعود للاستعداد | الردّ يُضاف للسياق (`history`) بدون الوسوم |
| **خطأ** | حركة اعتذار + رسالة مقروءة | `state: error` ثم عودة تلقائية للاستعداد |

كل جملة تظهر في نافذة الدردشة **عندما تبدأ بالنطق**، لا قبله.

---

## 3) كيف يتحكم Gemini بالروبوت: الوسوم

النص الجاهز لـ system prompt (`buildSystemPrompt`) يعلّم النموذج أن يجيب بإيجاز بلغة المستخدم، وأن يضع عند بداية الجملة وسماً اختيارياً:

| وسم | قيم | مثال |
|---|---|---|
| `[emotion=NAME]` | `neutral happy friendly content curious thinking sad surprised angry` | `[emotion=sad]أعتذر، لا أملك هذه المعلومة.` |
| `[gesture=NAME]` | `greeting goodbye pointing nod shake bow happy surprised` | `[gesture=greeting]أهلاً بك في جامعة الرازي.` |
| `[action=...]` | `forward:2` `turn_left:90` `goto:desk` `home` `look:user` `point:left` … | `[action=goto:desk]تفضل معي إلى مكتب الاستقبال.` |

وسوم `[action=…]` تحرّك الروبوت فعلاً (يمشي حول الأثاث دون اختراقه). والأوامر المكتوبة البسيطة («تقدم مترين») تُنفَّذ محلياً دون المرور بـ Gemini؛ التفاصيل في **[CHAT_COMMANDS.ar.md](CHAT_COMMANDS.ar.md)**.

- الوسوم **لا تُنطق ولا تظهر** في النص ولا في السياق. أسماء غير معروفة تُتجاهل بصمت. الوسم قد يصل مقسوماً بين جزأين من البث (يُعالَج).
- **علامات الترقيم مهمة**: الروبوت يومئ على الفاصلة والنقطة، ويرفع رأسه وحاجبيه عند «؟»، ويؤكد عند «!». لذلك يطلب الـ prompt ترقيماً طبيعياً.
- خصّص الشخصية والمعرفة:

```ts
import { buildSystemPrompt } from "./src";
const system = buildSystemPrompt({
  name: "رازي", organization: "جامعة الرازي", role: "موظف استقبال",
  language: "auto", maxSentences: 3,
  extra: "ساعات الدوام: الأحد إلى الخميس 8 ص – 3 م. التسجيل في مبنى القبول بالطابق الأول.",
});
```

على الخادم: `ROBOT_NAME` و`ROBOT_ORG` و`ROBOT_ROLE` و`ROBOT_LANGUAGE` و`ROBOT_EXTRA` (أو `SYSTEM_PROMPT` كاملاً) في `.env`. لمعرفة أكبر (أسئلة شائعة، رسوم، خطط دراسية) ضعها في `ROBOT_EXTRA` أو أضف استرجاعاً (RAG) في `chat()` بالخادم قبل الإرسال.

---

## 4) الاستخدام في تطبيقك

### أ) متصفح + خادمك (الموصى به)

```ts
import { RobotAvatar, RobotViewer, RobotAssistant, ProxyChatBackend, ProxyTtsBackend } from "./src";

const viewer = new RobotViewer(document.getElementById("stage")!, { quality: "high", background: "lobby" });
const robot  = await RobotAvatar.load("/models/robot_concierge.glb");
viewer.add(robot);
viewer.start();
robot.stateMachine.userTarget = viewer.camera;               // عيناه على المستخدم

const assistant = new RobotAssistant(robot, {
  chat: new ProxyChatBackend({ url: "/api/chat" }),          // الخادم الوسيط (المفتاح هناك)
  tts:  new ProxyTtsBackend({ url: "/api/tts", voice: "Kore" }),
  persona: { name: "رازي", organization: "جامعة الرازي" },
  language: "ar",                                            // أو "en" أو undefined = لغة المستخدم
});

assistant.on("sentence", ({ text }) => addToChat(text));     // تظهر عند بدء نطقها
assistant.on("error",    ({ stage, message }) => showError(stage, message));

await assistant.ask("ما هي شروط القبول؟");                    // زرّ الإرسال = لفتة مستخدم تفتح الصوت
assistant.cancel();                                          // مقاطعة: يتوقف الكلام والتفكير ويعود للاستعداد
```

> **الصوت يحتاج لفتة مستخدم** (نقرة) قبل أول نطق، وهو شرط المتصفحات. استدعِ `ask` من حدث نقر/إرسال.

### ب) React

```tsx
const [robot, assistant] = useMemo(...);   // أنشئ RobotAssistant مرة واحدة بعد تحميل الروبوت
const send = (q: string) => assistant.ask(q);
useEffect(() => assistant.on("state", ({ state }) => setStatus(state)), [assistant]);   // on() يعيد دالة إلغاء الاشتراك
```

المحوّل `src/adapters/r3f.tsx` يشغّل الروبوت داخل `@react-three/fiber`، و`RobotAssistant` لا يعتمد على DOM فيعمل معه كما هو.

### ج) نموذج أو صوت آخر (OpenAI، Azure، خادم محلي...)

الوحدة لا تعرف Gemini؛ تعرف واجهتين صغيرتين:

```ts
interface ChatBackend { stream(req: { messages; system; language? }, signal: AbortSignal): AsyncIterable<string>; }
interface TtsBackend  { sampleRate: number; synth(text: string, signal: AbortSignal): Promise<Int16Array | ArrayBuffer | null>; }  // PCM16 أحادي
```

اكتب مصدّراً يرجع أجزاء النص كما تصل، وصوتاً PCM، وأعطه لـ `RobotAssistant`. كل ما سبق (الوسوم، الجمل، المزامنة، المقاطعة) يعمل معه.

### د) بدون خدمة صوت (أبسط)

بلا `tts`: يُجمَع الرد كاملاً ثم يُنطق بصوت المتصفح (`speechSynthesis`) مع نفس مزامنة الفم والحركة. زمن الانتظار أطول لأن الكلام يبدأ بعد اكتمال الرد. وإذا فشل TTS من أول جملة يحدث هذا تلقائياً (حدث `error` بـ `stage: "tts"`) فلا يبقى الروبوت صامتاً.

### هـ) من الخادم فقط (بدون صفحة)

إن كان عقل المحادثة عندك على الخادم أصلاً، أرسل للروبوت أوامر JSON عبر WebSocket/HTTP ([REMOTE_API.md](REMOTE_API.md)، [COMMANDS.md](COMMANDS.md)) مثل `speak` و`setEmotion` و`playAnimation`.

---

## 5) إدخال الصوت (ميكروفون)

```ts
import { listenOnce, speechRecognitionAvailable } from "./src";
if (speechRecognitionAvailable()) {
  micButton.onclick = async () => {
    assistant.cancel();                                                  // التحدث فوق الروبوت يقاطعه
    const text = await listenOnce(robot, { lang: "ar-SA", onInterim: (t) => (input.value = t) });
    if (text) await assistant.ask(text);
  };
}
```

- يستخدم `SpeechRecognition` في المتصفح (Chrome وEdge وSafari). يحتاج **https أو localhost** وإذن الميكروفون. للعربية: `ar-SA` أو `ar-EG` أو `ar-AE`... وللإنجليزية `en-US`.
- أثناء الاستماع يتخذ الروبوت وضع **الإصغاء** (ميل الرأس، عيناه على المستخدم).
- **خصوصية:** تعرّف الكلام في Chrome تعالجه خوادم المتصفح، لا خادمك.
- **بديل أدق للعربية/اللهجات:** سجّل الصوت (`MediaRecorder`) وأرسله لـ Gemini كمدخل صوتي بدل النص (يفهم الصوت مباشرة)، ثم مرّر النص الناتج إلى `assistant.ask`.

### بديل: Gemini Live API (محادثة صوتية فورية)

نماذج Live (`gemini-3.8-live`...) تأخذ الصوت وتعيده بزمن أقل، **لكنها لا تعيد نص الوسوم**، فتفقد وسوم العاطفة والتشديد النصي. يدعمها المحرك مباشرة لأن خرجها PCM 24kHz هو ما يقبله `speakStream`:

```ts
const speech = robot.speakStream({ sampleRate: 24000 });       // الفم يتبع الصوت الحي، والحركة من طاقة الصوت
liveSession.onAudioChunk = (pcm16) => speech.pushPCM16(pcm16);  // اربط مقاطع الصوت الواردة
liveSession.onTurnComplete = () => speech.end();
```

مفتاحك يجب ألا يصل للمتصفح: استخدم **رموزاً مؤقتة (ephemeral tokens)** يصدرها خادمك. هذا المسار **لم أجرّبه**؛ المسار الموصى به والمُختبَر هو الأول (نص + TTS).

---

## 6) عقد الخادم الوسيط (`examples/gemini/server.ts`)

| نقطة | الطلب | الرد |
|---|---|---|
| `GET /api/health` | — | `{ ok, hasKey, model, tts, voice }` (لا يكشف المفتاح) |
| `POST /api/chat` | `{ messages: [{role:"user"\|"assistant", text}], language? }` | **SSE**: `data: {"text":"..."}` ... `data: [DONE]`؛ عند الخطأ أثناء البث `event: error` + `{message}` |
| `POST /api/tts` | `{ text, voice? }` | PCM16 أحادي خام، الترويسة `X-Sample-Rate: 24000` |

الأخطاء قبل بدء البث ترجع JSON `{ error }` برمز HTTP حقيقي (400 مدخلات، 403 مفتاح، 404 نموذج، 429 حصة، 502 مشكلة في Google).

**متغيرات البيئة** (في `.env` أو البيئة؛ البيئة تتقدم):

| متغير | الافتراضي | الوصف |
|---|---|---|
| `GEMINI_API_KEY` | — | **مطلوب** |
| `GEMINI_MODEL` | `gemini-3.8-flash` | نموذج النص |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-tts` | نموذج الصوت |
| `GEMINI_VOICE` | `Kore` | الصوت (30 صوتاً جاهزاً، انظر القائمة في التوثيق الرسمي) |
| `TTS_STYLE` | — | تلميح أسلوب للصوت مثل `Say warmly and clearly:` |
| `GEMINI_TEMPERATURE` / `GEMINI_MAX_TOKENS` | `0.7` / `500` | سقف طول الرد (يتحكم بالتكلفة) |
| `ROBOT_NAME/ORG/ROLE/LANGUAGE/EXTRA`, `SYSTEM_PROMPT` | رازي / جامعة الرازي / ... | الشخصية والمعرفة |
| `ALLOW_CLIENT_SYSTEM` | `0` | `1` يسمح للصفحة بإرسال system prompt (لا تفعله لموقع عام) |
| `ALLOWED_ORIGIN` | — | عند تقديم الصفحة من نطاق آخر (CORS) |
| `RATE_CHAT_PER_MIN` / `RATE_TTS_PER_MIN` | `30` / `120` | حد الطلبات لكل عنوان IP |
| `PORT` | `8788` | المنفذ |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | للخادم الوهمي أو بوابة |

خلف **nginx**: عطّل التخزين المؤقت لمسار البث (`proxy_buffering off;`) وإلا يصل النص دفعة واحدة. الخادم يرسل `x-accel-buffering: no`.

---

## 7) الأمان والتكلفة

- **المفتاح على الخادم فقط.** لا تضعه في كود الصفحة ولا في `VITE_*`. الخادم الوسيط يتحقق من المدخلات (حجم الطلب ≤ 64KB، رسائل ≤ 3000 حرف، ≤ 40 رسالة)، ويحدّ الطلبات، ولا يطبع المفتاح في السجلات.
- **system prompt من الخادم** افتراضياً: لا يستطيع زائر تغيير شخصية الروبوت أو استخدام مفتاحك كدردشة عامة بتعليماتٍ مخصصة.
- لموقع **عام**: أضف تسجيل دخول/CAPTCHA أمام `/api/*`، واجعل حد الطلبات أشد، وفعّل تنبيهات الميزانية في حسابك على Google.
- **ما يخفض التكلفة:** نموذج `flash-lite` للأسئلة البسيطة، `GEMINI_MAX_TOKENS` أقل، ردود قصيرة (الـ prompt يطلب ≤ 3 جمل)، تخزين مؤقت لإجابات الأسئلة المتكررة (رسوم، مواعيد) في الخادم. تذكّر أن TTS يُحتسب لكل جملة.
- **السلامة:** إن حجب Gemini الرد (فلاتر الأمان) يرجع الخادم `event: error` برسالة مقروءة ويدخل الروبوت حالة الخطأ.

---

## 8) زمن الاستجابة

زمن أول كلمة ≈ أول أجزاء النص + توليد صوت **جملة واحدة**. لتقليله:
- نموذج أسرع (`gemini-3.5-flash-lite`) أو أقل «تفكيراً» إن كان نموذجك يدعم ضبطه.
- الجملة الأولى قصيرة: الـ prompt يطلب البدء بالجواب مباشرة، و`SentenceChunker` يقطع أول جملة من 14 حرفاً.
- `prefetch: 2` (الافتراضي) يولّد الجملة التالية أثناء نطق الحالية فلا توجد فجوات؛ ارفعه لـ 3 إن كان TTS بطيئاً.
- أثناء الانتظار الروبوت «يفكر» فلا يبدو متجمداً.

---

## 9) استكشاف الأخطاء

| العرَض | السبب والحل |
|---|---|
| `GEMINI_API_KEY is not set on the server` | أنشئ `.env` من `.env.example` وأعد تشغيل `npm run gemini:server` |
| `HTTP 400: API key not valid` / `403 PERMISSION_DENIED` | المفتاح خاطئ أو غير مفعّل لهذه الخدمة؛ أنشئ مفتاحاً جديداً في AI Studio |
| `HTTP 404: models/... is not found` | اسم النموذج غير متاح لحسابك. اضبط `GEMINI_MODEL` / `GEMINI_TTS_MODEL` على ما في [قائمة النماذج](https://ai.google.dev/gemini-api/docs/models) |
| `HTTP 429` / `quota` | تجاوزت الحصة؛ انتظر أو فعّل الفوترة. الروبوت يعرض حالة الخطأ ثم يعود للاستعداد |
| لا يوجد صوت | الصوت يبدأ بعد نقرة المستخدم (سياسة المتصفح). تأكد من مستوى الصوت. افتح الـ console وابحث عن `error` بـ `stage: "tts"` |
| الصفحة لا تصل للخادم (`404`/`ECONNREFUSED` على `/api`) | شغّل `npm run gemini:server`. في وضع `npm run dev` يوجّه Vite المسار `/api` إلى `http://localhost:8788` (غيّره بـ `API_PROXY=...`) |
| النص يصل دفعة واحدة | وسيط (nginx/CDN) يخزّن البث. عطّل التخزين المؤقت للمسار `/api/chat` |
| الميكروفون لا يعمل | يحتاج Chrome/Edge/Safari، وhttps أو localhost، وإذن الميكروفون |
| الروبوت يقرأ «emotion» بصوته | النموذج كتب الوسم بشكل مختلف عن `[emotion=name]`. حافظ على نص الـ prompt؛ الوسوم المعروفة تُزال دائماً حتى لو انقسمت |
| صوت عربي غير مناسب | جرّب صوتاً آخر (`GEMINI_VOICE`) أو `TTS_STYLE`. اللغة تُكتشف تلقائياً من النص |
| ردّ طويل جداً | قلّل `GEMINI_MAX_TOKENS` أو `maxSentences` في الـ prompt |

---

## 10) مرجع `RobotAssistant`

```ts
new RobotAssistant(robot, {
  chat: ChatBackend,            // مطلوب
  tts?: TtsBackend,             // بدونه: صوت المتصفح بعد اكتمال الرد
  persona?: PromptOptions,      // أو system: string كاملاً
  maxHistory?: number,          // الافتراضي 16 رسالة
  prefetch?: number,            // طلبات TTS المتوازية، الافتراضي 2
  language?: string,            // يُرسل للخادم ("ar" | "en")
  commands?: false | { places, home, maxMeters, voice, userTarget },  // أوامر الشات المحلية (انظر CHAT_COMMANDS.ar.md)
});
await assistant.ask(text, { commands?: false }): Promise<{ text, aborted, error?, commands? }>
assistant.cancel({ motion?: false })  // مقاطعة + عودة للاستعداد (يوقف المشي أيضاً ما لم تمنع ذلك)
assistant.reset()               // مسح السياق
assistant.history               // [{ role, text }]
assistant.thinking              // true أثناء الإجابة
assistant.on("state" | "sentence" | "tag" | "answer" | "error" | "command" | "action", fn)   // يعيد دالة إلغاء الاشتراك
```

| حدث | بيانات |
|---|---|
| `state` | `{ state: "thinking" \| "speaking" \| "acting" \| "idle" \| "error" }` |
| `command` | `{ text, actions, lang }` فُهمت رسالتك كأمر (قبل التنفيذ) |
| `action` | `{ action, result, index, source: "chat" \| "llm" }` انتهت خطوة (مع `result.ok` / `reason`) |
| `sentence` | `{ text, index }` عند **بدء نطق** الجملة |
| `tag` | `{ tag: { name: "emotion"\|"gesture"\|"action", value }, at }` عند تنفيذ الوسم |
| `answer` | `{ text, aborted }` عند الانتهاء (أو المقاطعة) |
| `error` | `{ message, stage: "chat" \| "tts" \| "robot" }` |

**المقاطعة (barge-in):** `ask` جديدة أثناء الإجابة توقف الكلام فوراً وتحتفظ في السياق بما نُطق فعلاً (ليفهم النموذج «لا، أقصد…»).
**الأخطاء:** تضع الروبوت في `error` (حركة اعتذار) ثم يعود للاستعداد، ولا يبقى السؤال الفاشل في السياق فتسهل إعادة المحاولة.
**أدوات مساعدة** (مصدّرة): `DirectiveParser` (يفصل الوسوم عن النص المتدفق)، `SentenceChunker` (يقطع الجمل بذكاء: لا يقطع عند `3.5` ولا `Dr.`، ويدعم `؟`)، `pcmEnvelope` (غلاف شدة الصوت لمحاذاة الفم)، `buildSystemPrompt`.

---

## 11) بديل: Interactions API

توصي Google بواجهة **Interactions API** (`POST /v1beta/interactions`) للمشاريع الجديدة، مع بقاء `generateContent` / `streamGenerateContent` مدعومتين بالكامل. الخادم الوسيط هنا يستخدم `generateContent` لأنه الأقدم والأكثر ثباتاً، وكل تفاصيل Google محصورة في دالتين (`chat()` و`tts()`) في `examples/gemini/server.ts`. للانتقال، هذه الصيغ **من التوثيق الرسمي** (لم تُجرَّب هنا):

```jsonc
// نص: POST https://generativelanguage.googleapis.com/v1beta/interactions   (الترويسة x-goog-api-key)
{ "model": "gemini-3.8-flash", "system_instruction": "…", "input": "…", "stream": true }   // + ?alt=sse للبث
// أحداث البث: event_type == "step.delta" و delta.type == "text" → delta.text

// صوت:
{ "model": "gemini-3.8-flash-tts",
  "input": [{ "type": "user_input", "content": [{ "type": "text", "text": "مرحبا بكم" }] }],
  "response_format": { "type": "audio", "mime_type": "audio/l16", "sample_rate": 24000 },
  "generation_config": { "speech_config": [{ "voice": "Kore" }] } }
// الرد: base64 لـ PCM 16-bit أحادي 24kHz (steps[].content[].data)
```

---

## 12) ما اختُبر وما لم يُختبر

- **اختُبر (آلياً):** 14 اختباراً للوحدة (الوسوم، الجمل، الترتيب، المقاطعة، الأخطاء، صوت المتصفح البديل)، و5 اختبارات متصفح كاملة: صفحة المثال ← الخادم الوسيط ← **خادم Gemini وهمي** يحاكي صيغة `streamGenerateContent?alt=sse` و`generateContent` (AUDIO): سؤال عربي وإنجليزي، تسلسل الحالات، الوسوم، المقاطعة، خطأ الحصة 429، وحماية المفتاح.
- **لم يُختبر:** الاتصال بـ Gemini **الحقيقي** (لا يوجد مفتاح في بيئة التطوير)، والصوت المسموع فعلاً، والـ Live API. أسماء النماذج والصيغ مأخوذة من التوثيق الرسمي بتاريخ 2026-10-23 وقد تتغير؛ إن اختلف شيء فالتعديل محصور في `examples/gemini/server.ts`. **جرّب أول سؤال حقيقي وأخبرني بأي خطأ يظهر في نافذة الخادم.**

## المصادر

- [قائمة نماذج Gemini API](https://ai.google.dev/gemini-api/docs/models) · [توليد النص](https://ai.google.dev/gemini-api/docs/text-generation) · [توليد الكلام TTS](https://ai.google.dev/gemini-api/docs/speech-generation) · [مفاتيح API](https://aistudio.google.com/apikey)
- [الانتقال إلى Interactions API](https://ai.google.dev/gemini-api/docs/migrate-to-interactions) · [سجل التغييرات](https://ai.google.dev/gemini/docs/changelog)
