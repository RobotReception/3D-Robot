export type Lang = "en" | "ar";

const AR: Record<string, string> = {
  "Robot Avatar Studio": "استوديو الروبوت التفاعلي",
  Motion: "الحركات", Joints: "المفاصل", Audio: "الصوت", Developer: "المطوّر",
  Style: "النمط", Camera: "الكاميرا", Quality: "الجودة", Background: "الخلفية",
  Full: "كامل", Upper: "الجزء العلوي", Face: "الوجه", Side: "جانبي", Back: "خلفي",
  Low: "منخفضة", Medium: "متوسطة", High: "عالية",
  "Reset pose": "إعادة الوضع الافتراضي", Screenshot: "لقطة شاشة", Stop: "إيقاف",
  "Assistant state": "حالة المساعد", Animations: "الحركات", "Loop looping clips": "تكرار الحركات الدورية",
  Emotion: "العاطفة", "Eye expression": "تعبير العينين", Speed: "السرعة", "Auto (emotion)": "تلقائي (حسب العاطفة)",
  Walk: "المشي", "Walk to": "المشي إلى", Go: "اذهب", "Turn left": "التفاف يسار", "Turn right": "التفاف يمين",
  "Gaze": "النظر", "Follow cursor": "متابعة المؤشر", "Look at camera": "النظر إلى الكاميرا", "Free gaze": "نظر حر",
  Hands: "اليدان", Point: "إشارة", Fist: "قبضة", Open: "مفتوحة", Relaxed: "مسترخية",
  Pointing: "الإشارة بالذراع (IK)", "Point at cursor target": "الإشارة إلى هدف أمام الروبوت",
  "Selected joint": "المفصل المحدد", "Click the robot to pick a joint": "انقر على الروبوت لاختيار مفصل",
  "Release joint": "تحرير المفصل", "Release all": "تحرير الكل", "Current angle": "الزاوية الحالية",
  "Head & eyes": "الرأس والعينان", Yaw: "دوران أفقي", Pitch: "ميل رأسي", Roll: "إمالة",
  "Eyes yaw": "اتجاه العين أفقيًا", "Eyes pitch": "اتجاه العين رأسيًا", "Mouth open": "فتح الفم", Blink: "رمش",
  "Left arm": "الذراع اليسرى", "Right arm": "الذراع اليمنى", Shoulder: "الكتف", Abduction: "رفع جانبي", Twist: "التفاف",
  Elbow: "المرفق", Wrist: "المعصم", "Wrist flex": "ثني المعصم", Fingers: "الأصابع", Thumb: "إبهام", Index: "سبابة", Middle: "وسطى", Ring: "بنصر",
  "Text to speak": "نص للنطق", Language: "اللغة", Auto: "تلقائي", "Speak": "انطق", "Silent preview": "معاينة صامتة (بدون صوت)",
  Rate: "السرعة", "Upload audio": "رفع ملف صوتي", "Transcript (optional)": "النص المكتوب (اختياري)",
  "Lip-sync mode": "نمط مزامنة الشفاه", "Hybrid (text + audio)": "مدمج (نص + صوت)", "Audio analysis only": "تحليل الصوت فقط",
  "Text only": "النص فقط", "Sync offset (ms)": "إزاحة المزامنة (مللي ثانية)", "Mouth gain": "قوة حركة الفم",
  "Hybrid gate": "تأثير شدة الصوت", "Demo audio": "صوت تجريبي", "Visemes": "أشكال الفم", Timeline: "الخط الزمني",
  "No voices installed: using silent preview": "لا توجد أصوات في المتصفح: سيتم استخدام المعاينة الصامتة",
  "Robot status": "حالة الروبوت", Events: "الأحداث", "JSON command": "أمر JSON", Send: "إرسال", Examples: "أمثلة",
  Performance: "الأداء", Clear: "مسح", Connect: "اتصال", "WebSocket URL": "عنوان WebSocket", Disconnect: "قطع الاتصال",
  "Quick commands": "أوامر سريعة", "Draw calls": "استدعاءات الرسم", Triangles: "المثلثات", "Engine update": "معالجة المحرك",
  Language_UI: "اللغة", "Pick a joint": "اختر مفصلًا", Override: "تحكم يدوي",
  Greeting: "ترحيب", Goodbye: "توديع", Happy: "سعادة", Sad: "حزن", Surprised: "دهشة", Error: "خطأ", Thinking: "تفكير",
  Listening: "إنصات", Speaking: "تحدث", Idle: "خمول", Pointing_anim: "إشارة", Walking: "مشي", Turning: "التفاف",
  Neutral: "محايد", Angry: "غضب", Curious: "فضول", Friendly: "ودود",
  "WebGL is not available": "WebGL غير متاح على هذا الجهاز أو المتصفح",
  "Loading robot...": "جاري تحميل الروبوت...",
};

export function makeT(lang: Lang) {
  return (key: string) => (lang === "ar" ? (AR[key] ?? key) : key);
}
export type T = ReturnType<typeof makeT>;
