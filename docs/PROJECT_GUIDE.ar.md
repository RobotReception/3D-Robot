# الدليل الشامل: ما الذي تم، وكيف يعمل، وكيف تربطه بنظامك

> مشروع **روبوت استقبال ثلاثي الأبعاد** يعمل في المتصفح: جسم حقيقي بهيكل عظمي وتعابير وجه، يتحرك ويمشي ويتكلم ويتفاعل، وتتحكم به من برنامجك أو من **Gemini**.
> الكود: <https://github.com/RobotReception/3D-Robot> (الفرع `claude/awesome-noether-ve29yd`).
> هذا الملف هو **المدخل**؛ كل موضوع له ملف تفصيلي مذكور في مكانه.

---

## ١) فكرة المشروع في دقيقة

```
 Blender (كود Python)           محرك TypeScript فوق three.js                    واجهات
┌──────────────────────┐      ┌──────────────────────────────────────┐   ┌────────────────────────┐
│ مجسم + هيكل 40 عظمة   │ GLB  │ حركات · مشي IK · وجه · مزامنة شفاه ·   │   │ Control Studio (لوحة)   │
│ 43 تعبير وجه · خامات  │ ───▶ │ أداء الكلام · بيئة · تجنب العوائق ·     │──▶│ ربط Gemini (دردشة)      │
│ 5 أشكال للروبوت       │      │ ألوان وشعار · أوامر JSON               │   │ HTTP/WebSocket للتحكم   │
└──────────────────────┘      └──────────────────────────────────────┘   └────────────────────────┘
```

- **حقيقي وليس فيديو:** كل أمر (`walkTo`، `setEmotion`، `speak`...) يحرّك عظاماً وتعابير وجه فعلية.
- **خمسة أشكال** بنفس الهيكل: `concierge` (موظف الاستقبال الواقعي، الافتراضي)، `mascot` (صغير لطيف 92 سم)، `friendly`، `premium`، `futuristic`.
- **يعمل في أي متصفح حديث** بدون تثبيت؛ والمحرك مستقل عن الواجهة فتضمّنه في موقعك.

---

## ٢) ما الذي تم (حسب ما طلبتَه، بالترتيب)

| # | الطلب | ما سويته | أين |
|---|---|---|---|
| 1 | روبوت احترافي مثل صورتك | أعدت تصميم **Concierge**: خوذة بيضاء مستديرة وشاشة سوداء لامعة، وجه بعينين وابتسامة سماوية، سماعات سماوية، سترة كحلية فوق قميص أبيض وربطة عنق، مفاصل رمادية داكنة، حذاء أبيض بخط سماوي | `blender/build_robot.py` |
| 2 | الخصر مثل الإنسان، بلا حلقات ولا إضاءة | خصر **قطعة واحدة** بقماش السترة يضيق قليلاً ويدخل في الحوض | " |
| 3 | الذراع بلا كرات، ثم «أفضل من ذلك» | كتف منحوت وقطعتا ذراع بيضاوان تغطيان مفاصل صغيرة، ورسغ نحيف | " |
| 4 | إزالة الخيطين والميدالية من الصدر | أزلتهما؛ الصدر: قميص V وربطة عنق فقط | " |
| 5 | إضاءة العيون قوية | خففتها على كل الأشكال (انبعاث الوجه ~⅓ والوهج أقل من النصف) | `build_robot.py`، `RobotViewer.ts` |
| 6 | Friendly: بلا دائرة الصدر | لوحة صدر مسطحة بحواف ناعمة بدل الدائرة، وحلقات رمادية بدل البيج | `build_robot.py` |
| 7 | ألوان قابلة للتحكم + شعار على الصدر | تبويب **Brand**: منتقي لون لكل جزء، رفع شعار وتحديد حجمه ومكانه، هويات جاهزة | `src/studio/`، `RobotAvatar.setColors/setLogo` |
| 8 | تصميم Mascot كالصورة المرجعية | أعدت بناءه: 92 سم، شاشة بإطار بارز، سماعات فضية، حلقة ضوء بالرقبة، شعار بالصدر، منفذ خدمة بالظهر، أصابع حقيقية | `build_robot.py` |
| 9 | بيئة واقعية | **بهو استقبال**: أرضية حجرية، جدار خشب الجوز بلافتة مضيئة، مكتب استقبال، جدار زجاجي بمنظر مدينة، نباتات، مقعد، إضاءة سقف، وانعكاسات الغرفة على الروبوت | `src/viewer/environments/lobby.ts` |
| 10 | هوية جامعة الرازي | الألوان من دليل الهوية (`#0080c6` و`#f78a2c` و`#acd9e7`) وشعار الجامعة، افتراضية في الاستوديو؛ وفي البهو: لافتة وشعار على المكتب وخطوط LED بألوان الهوية | `src/studio/brands.ts` |
| 11 | حركة احترافية سلسة | أصلحت **أخطاء حقيقية** وجدتها بالقياس (انظر §٣) | `src/engine/*` |
| 12 | لا يخترق الحائط والأشياء | عوائق حقيقية وتخطيط مسار حولها (انظر §٤) | `src/engine/world.ts` |
| 13 | كلام احترافي منسق الحركة | مزامنة شفاه متداخلة + «مؤدّي كلام» (انظر §٥) | `lipsync/`، `SpeechPerformer.ts` |
| 14 | الربط بـ Gemini | سؤال ← تفكير ← إجابة بصوت وحركة (انظر §٦) | `assistant.ts`، `examples/gemini/` |
| 15 | تشغيل محلي | `run-local.bat` / `run-local.sh` ورفع كل شيء إلى GitHub | الجذر |

**الجودة:** 144 اختبار وحدة + 34 اختبار متصفح كامل (Chromium)، كلها ناجحة. الاختبارات تقيس الحركة نفسها (التسارع، الاصطدام، التوقيت)، لا مجرد وجود الملفات.

---

## ٣) الحركة: ما كان خاطئاً وكيف أصلحته

قست التسارع الزاوي للمفاصل أثناء الحركات ووجدت مشاكل محددة بدل التخمين:

| المشكلة (مقيسة) | السبب | الإصلاح |
|---|---|---|
| الذراعان تنقلبان **42° كل خطوة** أثناء المشي | مرحلة المشي كانت تُحسب من القدم الخاطئة فتقفز بين قيمتين | مرحلة مستمرة؛ اليد اليمنى تتحرك مع القدم اليسرى (ارتباط 0.79) |
| الحوض ينخفض **22 سم** عند بدء المشي ثم يعود | الخطوة الأولى تُحسب على سرعة صفر والجسم يتسارع | الهبوط يُحسب بالسرعة المتوقعة؛ التسارع يتناسب مع قدرة الساقين؛ بداية لينة (انخفاض < 6 سم) |
| القفز عند التوقف | هبوط فوري للحوض | دخول سلس + خروج بطيء، وتمايل/ارتفاع الحوض دوال ناعمة |
| انتقالات الحركات خطية (تبدأ بسرعة كاملة) | مزج خطي للأوزان | منحنى ناعم (smootherstep): بدء ونهاية بسرعة وتسارع صفر |
| الذراع **تقفز 21°** عند نهاية الكلام | حركة الوقوف الأساسية تعود فوراً | عودة بنفس الانتقال الناعم |
| تداخل خاطئ في الدخول والخروج | أسرع المنحنيين يحدد الزمن | الدخول والخروج متكاملان (يستغرقان المدة الأطول) |

نتيجة القياس (أسوأ تسارع زاوي، rad/s²): الكلام 1451→32، الترحيب 329→115، التفكير 170→27، وقفزات المشي اختفت. التفاصيل: قسم «Motion quality notes» في [API.md](API.md) و[ANIMATION.md](ANIMATION.md).

---

## ٤) عدم اختراق الجدران والأشياء

- **العالم** (`World`): مستطيل الجدران + صناديق (مكتب، مقعد) + دوائر (نباتات). البهو يعرّف عوائقه، وأرضية الاستوديو الأخرى محدودة بحدودها.
- **تخطيط مسار** (A* على شبكة 10 سم مع مسافة أمان بحسب عرض جسم الروبوت ثم تنعيم): `walkTo` إلى ما خلف المكتب يلتف حول النبتة والمكتب.
- **الاصطدام:** الانزلاق على الأسطح وعدم العبور؛ `walkForward` يتوقف أمام الحائط؛ الهدف داخل مكتب يُنقل لأقرب مكان فارغ (حدث `walk:blocked`)؛ ولا مسار → يُرجع `false` ولا يبدأ.
- **في الاستوديو:** خط أزرق على الأرض يرسم المسار المخطط.

```ts
robot.world = { bounds: { minX:-4, maxX:4, minZ:-4, maxZ:4 }, boxes:[{minX:-1,maxX:1,minZ:-.3,maxZ:.3}], circles:[{x:2.5,z:2,r:.4}] };
await robot.walkTo({ x: 0, z: 3 });      // يلتف حول العوائق
```

> **حدّ معروف:** الاصطدام للجسم على الأرض فقط؛ اليدان والذراعان لا تتفاديان الأشياء (قد تلمس أوراق نبتة عالية). التفاصيل: [API.md](API.md).

---

## ٥) الكلام

**الفم** (`VisemeTimeline`): كل شكل يبدأ قبل نطقه بـ50 مللي ثانية ويمتزج مع جيرانه (نموذج Cohen–Massaro): حروف العلة تغلب الحروف الرخوة، وإغلاق الشفتين (ب م) والأسنان (ف) يظهر دائماً، والفجوة القصيرة بين الكلمات لا تغلق الفم. **رفرفة الفم نزلت من 17 إلى 2 في 10 ثوانٍ.**

**مؤدّي الكلام** (`robot.performer`): يقرأ التشديد وعلامات الترقيم ويحرّك في وقتها:

| ما يسمعه | ما يفعله الروبوت |
|---|---|
| كلمة مهمة | إيماءة رأس، رفع حاجب، **ضربة يد** تبدأ قبلها بثلث ثانية وتصل ذروتها عليها (فارق ≈ 30 مللي ثانية)، تتبادل اليدان |
| بداية عبارة | رفع خفيف للرأس ونظرة جانبية |
| فاصلة / نقطة | إيماءة صغيرة / بطيئة + رمشة عند التوقف |
| «؟» | يميل الرأس لأعلى وترتفع الحواجب **قبل** التوقف |
| «!» | إيماءة قوية + رفع حاجبين |

أدوات التحكم: `robot.performer.intensity` (0–1)، `.head` `.brows` `.hands` `.blinks`، و`speak({ gestures:false })`. التفاصيل: [LIPSYNC.md](LIPSYNC.md).

---

## ٦) الربط بـ Gemini (سؤال ← إجابة)

التفصيل الكامل في **[GEMINI.md](GEMINI.md)**. الخلاصة:

```
المتصفح (روبوت + RobotAssistant) ⇄ خادمك الوسيط (يحمل المفتاح) ⇄ Gemini
```

**تشغيل سريع:**

```bash
npm install
cp .env.example .env            # ضع GEMINI_API_KEY (من https://aistudio.google.com/apikey)
npm run gemini:server           # نافذة 1: الخادم الوسيط على :8788
npm run dev                     # نافذة 2
# افتح http://localhost:5173/examples/gemini.html
```

ما يفعله `RobotAssistant` عند كل سؤال: يفكّر فوراً ← يبثّ النص ويقطّعه جملاً ← صوت كل جملة (والتالية تُجهَّز أثناء نطق الحالية) ← تيار صوت واحد بلا فجوات ← مزامنة مع الصوت الحقيقي ← وسوم `[emotion=…]` و`[gesture=…]` تُنفَّذ في وقتها ولا تُنطق ← مقاطعة (barge-in) ← حالة خطأ مقروءة. لا يعرف Gemini تحديداً: أي نموذج وصوت عبر واجهتين صغيرتين.

---

## ٧) كيف تربطه بنظامك (اختر ما يناسبك)

| تريد... | الطريقة | الملف |
|---|---|---|
| **تضمينه في موقعك** (JS عادي) | `RobotViewer` + `RobotAvatar.load()` | [INTEGRATION.md](INTEGRATION.md)، `examples/minimal.html` |
| تضمينه في **React** | محوّل `r3f` | `src/adapters/r3f.tsx`، `examples/r3f` |
| **محادثة مع Gemini** | `RobotAssistant` + الخادم الوسيط | [GEMINI.md](GEMINI.md) |
| محادثة مع **نموذج آخر** (OpenAI، محلي...) | اكتب `ChatBackend` و`TtsBackend` (دالتان) | GEMINI.md §4-ج |
| التحكم من **خادمك/وكيل ذكي** (بلا صفحة تفاعلية) | أوامر JSON عبر WebSocket/HTTP | [REMOTE_API.md](REMOTE_API.md)، [COMMANDS.md](COMMANDS.md) |
| **تأليف حركات جديدة** (حتى بواسطة LLM) | JSON بمفاتيح زمنية + مخطط JSON Schema | [MOTION_AUTHORING.md](MOTION_AUTHORING.md) |
| **هوية جهة أخرى** (ألوان وشعار) | `setColors` و`setLogo`، أو تبويب Brand، أو أضف هوية في `src/studio/brands.ts` | §٨ |
| **كشك/شاشة استقبال** | شغّل الصفحة بملء الشاشة (F11) على جهاز الكشك؛ `?quality=low` للأجهزة الضعيفة؛ المحادثة عبر `examples/gemini.html` | §٩ |

### أ) تحكم من برنامجك بأوامر JSON (الأبسط للأنظمة الحالية)

```bash
API_KEY=secret npm run api:server                  # خادم الأوامر على :8787
# في صفحة الروبوت: Studio ← Developer ← WebSocket ← ws://localhost:8787 ← Connect
curl -X POST localhost:8787/v1/command -H "authorization: Bearer secret" -H "content-type: application/json" \
  -d '{"cmd":"sequence","steps":[{"cmd":"setEmotion","emotion":"happy"},{"cmd":"playAnimation","name":"greeting"},{"cmd":"speak","text":"أهلاً بك!"}]}'
```

الأوامر المتاحة: `playAnimation stopAnimation setEmotion setEyeExpression lookAt moveHead moveArm moveTorso setEyeDirection moveJoint releaseJoint setHand pointAt setMouthOpen blink walkTo turn speak setState setSpeed setGlow stop resetPose wait sequence parallel registerMotion listMotions getMotion getMotionSchema getStatus`. يمكن لـ LLM إصدارها كاستدعاءات أدوات (tool calls).

### ب) من كودك مباشرة

```ts
import { RobotAvatar, RobotViewer } from "./src";
const viewer = new RobotViewer(el, { quality: "high", background: "lobby" });
const robot  = await RobotAvatar.load("/models/robot_concierge.glb");
viewer.add(robot); viewer.start();

robot.playAnimation("greeting");        robot.setEmotion("happy");
robot.lookAt({ x: 0, y: 1.4, z: 2 });   robot.moveArm("right", { shoulder: 30, elbow: 45 });
await robot.walkTo({ x: 1, z: 2 });     robot.speak({ text: "مرحباً بك", emotion: "friendly" });
robot.setState("thinking");             // idle | listening | thinking | speaking | error
```

حالات المساعد تضبط حزمة متناسقة (حركة + وجه + نظرة + لون وهج): `listening` يميل ويصغي، `thinking` يده على ذقنه، `speaking` يتكلم ويومئ، `error` يعتذر. اجعل عينيه على المستخدم: `robot.stateMachine.userTarget = camera`.

### ج) أحداث الروبوت (للتفاعل مع نظامك)

`robot.on("state" | "emotion" | "animation:start" | "animation:end" | "speech:start" | "speech:end" | "walk:start" | "walk:end" | "walk:blocked" | "walk:route" | "appearance" | "error", fn)` — كلها تعيد دالة إلغاء الاشتراك.

---

## ٨) تخصيص المظهر

```ts
robot.setColors({ body:"#f5f7fa", uniform:"#0080c6", accent:"#f78a2c", eyes:"#7fd3ff", light:"#0080c6" });
//   الأجزاء: body trim uniform joints accent visor eyes light   (الجزء غير الموجود في الشكل يُتجاهل)
await robot.setLogo("/logos/alrazi.png", { size: 0.1, placement: "left" });   // "center" | "left"، null يزيله
robot.resetColors();
viewer.setLobbyBrand({ logo:"/logos/x.png", nameAr:"…", nameEn:"…", primary:"#0080c6", accent:"#f78a2c" });  // لافتة البهو
```

**إضافة هويتك الجاهزة:** أضف مدخلاً في `BRAND_PRESETS` داخل `src/studio/brands.ts` ثم ضع الشعار في `public/logos/`. **أفضل شعار:** PNG بخلفية شفافة (الحالي مقصوص من الصورة وخلفيته زرقاء فاتحة فيبدو باهتاً قليلاً).

الخلفيات: `lobby` (الافتراضية) `studio` `light` `dusk` `green` `transparent` — `viewer.setBackground("…")`.
تعديل **الموديل نفسه** (أبعاد، ألوان أصلية، أجزاء): `blender/build_robot.py` ثم `npm run model:build` (يحتاج `pip install bpy numpy`).

---

## ٩) التشغيل والنشر

**متطلبات:** Node.js 20+ (والـ Python فقط لإعادة بناء الموديل).

| الأمر | الوظيفة |
|---|---|
| `run-local.bat` / `./run-local.sh` | تشغيل بنقرة: يثبّت الحزم ويفتح `localhost:5173` |
| `npm run dev` | الاستوديو للتطوير (`localhost:5173`) |
| `npm run build` | بناء ثابت في `dist/` (يُقدَّم من أي خادم ملفات) |
| `npm run gemini:server` | الخادم الوسيط لـ Gemini (`:8788`، ويقدّم `dist/` أيضاً) |
| `npm run gemini:mock` | خادم Gemini وهمي للتجربة بلا مفتاح (`:8799`) |
| `npm run api:server` | خادم أوامر HTTP/WebSocket (`:8787`) |
| `npm test` | 144 اختبار وحدة |
| `npm run test:e2e` | 34 اختبار متصفح كامل |
| `npm run model:build` | إعادة بناء الأشكال الخمسة من Blender |
| `npm run docs:gen` | توليد `RIG.md` و`MOTIONS.md` من الكود |

**نشر إنتاجي (عملية واحدة):** `npm run build` ثم `npm run gemini:server` ← `http://السيرفر:8788/examples/gemini.html` (الخادم يقدّم الصفحة والـ API معاً). خلف nginx: عطّل `proxy_buffering` لمسار `/api/chat`. الأمان: المفتاح على الخادم فقط، حد طلبات، رفض مدخلات غير صالحة؛ وللموقع العام أضف تسجيل دخول/CAPTCHA.

**الصوت يحتاج نقرة من المستخدم** قبل أول نطق (شرط المتصفحات). **الميكروفون** يحتاج Chrome/Edge/Safari و`https` أو `localhost`.

---

## ١٠) خريطة الملفات

```
blender/build_robot.py        بناء الأشكال الخمسة (مجسم، هيكل، خامات، تعابير)
public/models/*.glb           الموديلات الجاهزة    public/logos/   الشعارات
src/engine/                   RobotAvatar (الواجهة الرئيسية) · الحركة: AnimationController, library, clips,
                              LocomotionController, ik, world · الوجه: FaceController, lipsync/ ·
                              SpeechPerformer · assistant (+ assistantPrompt, backends/) · commands, bridge (JSON)
src/viewer/                   RobotViewer (مشهد، إضاءة، جودة) + environments/lobby.ts (البهو)
src/studio/                   لوحة التحكم (React): Motion · Brand · Joints · Audio · Developer
examples/                     minimal.html · r3f · gemini.html + gemini/ (الخادم الوسيط وصفحة الدردشة)
tools/                        remote_api_server, mock_gemini_server, توليد الوثائق، لقطات
tests/                        وحدة + e2e/run.mjs (متصفح كامل)
docs/                         وثائق تفصيلية (API, ANIMATION, LIPSYNC, GEMINI, REMOTE_API, RIG, ...)
```

---

## ١١) ما لم يُختبر / حدود صريحة

- **Gemini الحقيقي:** لم أتصل به (لا مفتاح في بيئتي). الاختبارات استخدمت خادماً وهمياً بنفس صيغة الواجهة. أسماء النماذج الافتراضية من توثيق Google بتاريخ 2026-10-23، فإن اختلفت لحسابك اضبط `GEMINI_MODEL` و`GEMINI_TTS_MODEL` في `.env`.
- **الصوت المسموع والميكروفون وLive API:** لم أسمعها بنفسي؛ توقيت الصوت الحقيقي مع الحركة قد يحتاج ضبطاً بسيطاً (`robot.lipsync.offsetMs`).
- **الأداء على كرت شاشة حقيقي:** قياساتي من محاكي برمجي بطيء (SwiftShader)؛ البهو أثقل من الخلفيات القديمة، وإن كان جهازك ضعيفاً استخدم `quality: "low"` أو خلفية `studio`.
- **الاصطدام:** للجسم فقط (لا اليدان)، وعوائق البهو ثابتة (مكتب ونبات ومقعد وجدران).
- **باقٍ بلا تعديل:** كرات داكنة عند الورك والركبة في ساقَي Concierge (طلبتَ الذراعين فقط)، ويمكن جعلها ملساء بالطريقة نفسها إن أردت.
- **الشعار:** مقصوص من صورة وليس ملفاً أصلياً (انظر §٨).
- **الصفحة المنشورة على claude.ai** (رابط الاستوديو الخاص بك) أقدم من هذه النسخة وهي للاستعراض فقط؛ للنسخة الكاملة شغّل المشروع محلياً.

---

## ١٢) استكشاف أخطاء سريع

| العرَض | الحل |
|---|---|
| `localhost refused to connect` | الموقع لا يعمل بعد: شغّل `run-local.bat` أو `npm run dev` واترك النافذة مفتوحة |
| `Node.js غير مثبت` | ثبّت Node.js 20+ ثم أعد تشغيل الجهاز |
| الروبوت لا يتكلم | الصوت يبدأ بعد نقرة المستخدم؛ تأكد من مستوى الصوت |
| أخطاء `404/403/429` من Gemini | النموذج/المفتاح/الحصة: انظر جدول GEMINI.md §9 |
| الصفحة بطيئة | قائمة **Quality** (Low) أو خلفية `studio` في الاستوديو، أو `?quality=low` في صفحة gemini، أو جهاز بكرت شاشة |
| الروبوت لا يتجنب شيئاً أضفته | أضفه إلى `world` (صندوق/دائرة) أو إلى `lobbyWorld()` |

---

## ١٣) خطوات مقترحة تالية

1. **جرّب Gemini الحقيقي** بسؤالين (عربي وإنجليزي) وأخبرني بأي خطأ يظهر.
2. **ادمج الفرع في `main`** (Pull Request) ليصير الافتراضي على GitHub.
3. أرسل **شعاراً بخلفية شفافة** (PNG أو SVG) وأعلى جودة.
4. أضف **معرفة جهتك** (أسئلة شائعة، مواعيد، رسوم) في `ROBOT_EXTRA` أو عبر استرجاع (RAG) في الخادم.
5. للكشك: كلمة تنبيه (wake word) أو كشف حضور بالكاميرا لبدء المحادثة تلقائياً.
6. اجعل ساقَي Concierge ملساوين ويدَيه تتفاديان العوائق.

---

## الوثائق التفصيلية

[GEMINI.md](GEMINI.md) · [API.md](API.md) · [ANIMATION.md](ANIMATION.md) · [MOTIONS.md](MOTIONS.md) · [MOTION_AUTHORING.md](MOTION_AUTHORING.md) · [LIPSYNC.md](LIPSYNC.md) · [REMOTE_API.md](REMOTE_API.md) · [COMMANDS.md](COMMANDS.md) · [INTEGRATION.md](INTEGRATION.md) · [STUDIO.md](STUDIO.md) · [RIG.md](RIG.md) · [DESIGN.md](DESIGN.md) · [PERFORMANCE.md](PERFORMANCE.md) · [TESTING.md](TESTING.md)
