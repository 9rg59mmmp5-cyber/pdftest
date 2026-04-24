import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Play, CheckCircle, XCircle, Clock, RefreshCw, FileText, Settings, ListChecks, ArrowRight, ArrowLeft, Upload, ChevronLeft, ChevronRight, Maximize, Minimize, Trash2, ZoomIn, ZoomOut, Keyboard, BookOpen, Book, Plus, Crop, Highlighter, Hand, Check, X, Folder, FolderOpen, File, Home, List, Gamepad2, LogIn, LogOut, User, Pen, Eraser, MousePointer2, Smartphone, StickyNote, NotebookPen } from 'lucide-react';
import localforage from 'localforage';
import { v4 as uuidv4 } from 'uuid';
import { Document, Page, pdfjs } from 'react-pdf';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import JSZip from 'jszip';
import jsPDF from 'jspdf';
import { saveAs } from 'file-saver';
import { useAuth } from './contexts/AuthContext';
import { api } from './api';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Android ve eski tarayıcılar için CDN legacy worker (module worker değil)
pdfjs.GlobalWorkerOptions.workerSrc =
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;

const pdfOptions = {
  cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/standard_fonts/`,
};

// FIX PERFORMANS: Optimal DPR — çok yüksek DPR yavaşlatır, çok düşük bulanık gösterir.
// Mobile 2x, tablet/desktop 1.5x (zaten CSS zoom ile keskin görünür)
const OPTIMAL_DPR = (() => {
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  // En az 1.5, en fazla 2 — yeterince keskin + hızlı
  return Math.min(2, Math.max(1.5, dpr));
})();

type Mode = 'setup' | 'taking' | 'grading' | 'results' | 'saved_questions' | 'saved_notes' | 'memorize' | 'ustasi' | 'analiz' | 'calisma';

// ═══════════════════════════════════════════════════════════════════════
// ⏱ ÇALIŞMA SAYACI — Types
// ═══════════════════════════════════════════════════════════════════════
type StudyMode = 'pomodoro' | 'desktime' | 'deepwork' | 'flexible';
type StudyPhase = 'idle' | 'working' | 'break' | 'paused';

interface StudyPreset {
  id: StudyMode;
  name: string;
  icon: string;
  workMin: number;
  breakMin: number;
  longBreakMin: number;
  longBreakEvery: number;
  description: string;
}

const STUDY_PRESETS: StudyPreset[] = [
  { id: 'pomodoro', name: 'Pomodoro', icon: '🍅', workMin: 25, breakMin: 5, longBreakMin: 30, longBreakEvery: 4,
    description: 'Klasik 25/5 — yeni başlayanlar ve dağılmış dikkate ideal (Cirillo, 1980)' },
  { id: 'desktime', name: 'DeskTime', icon: '⚡', workMin: 52, breakMin: 17, longBreakMin: 30, longBreakEvery: 4,
    description: 'En verimli %10\'un tekniği — orta zorluk (DeskTime, 2014)' },
  { id: 'deepwork', name: 'Deep Work', icon: '🧠', workMin: 90, breakMin: 20, longBreakMin: 45, longBreakEvery: 2,
    description: 'Ultradian ritim — derin odaklanma, KPSS için ideal (Schwartz/Newport)' },
  { id: 'flexible', name: 'Esnek', icon: '🎯', workMin: 999, breakMin: 10, longBreakMin: 20, longBreakEvery: 4,
    description: 'Süre sınırı yok — sen karar ver, mola istediğinde al' },
];

interface StudySession {
  date: string; // YYYY-MM-DD
  totalSeconds: number;
  workBlocks: number; // Tamamlanan iş blokları
  breaks: number;
  mode: StudyMode;
  timeline: Array<{ start: number; end: number; type: 'work' | 'break' }>; // Saat timestamp
}

interface StudyState {
  phase: StudyPhase;
  mode: StudyMode;
  phaseStartedAt: number; // ms timestamp — o fazın başladığı an
  accumulatedInPhase: number; // pause öncesi biriken saniye
  completedWorkBlocks: number; // Bu oturumda tamamlanan
  todayTotalSeconds: number; // Bugün toplam (her kayıt sonrası güncellenir)
  todayDate: string; // YYYY-MM-DD — gün değişimini yakalamak için
}

interface SavedQuestion {
  id: string;
  sessionId: string;
  questionNumber: number;
  subject: string;
  topic?: string;
  difficulty: 'Kolay' | 'Orta' | 'Zor';
  image: string;
  date: number;
  correctAnswer?: string;
  notes?: string;
  pdfId?: string;
  page?: number;
  rect?: { x: number, y: number, width: number, height: number };
  // ── SM-2 bilimsel tekrar alanları ──────────────────────────────────────
  srsNextReview?: number;         // Sonraki tekrar zamanı (ms timestamp)
  srsReviewCount?: number;        // Kaç kez tekrar edildi
  srsEaseFactor?: number;         // Kolaylık faktörü (2.5 başlangıç, 1.3 minimum)
  srsIntervalDays?: number;       // Sonraki aralık (gün)
  srsLapses?: number;             // Kaç kez yanlış bilindi
  srsLastReviewedAt?: number;     // Son tekrar zamanı
  srsStage?: 'new' | 'learning' | 'review' | 'mature' | 'mastered';  // Öğrenme aşaması
  srsCorrectStreak?: number;      // Üst üste doğru bilme sayısı (otomatik zorluk için)
  srsWrongStreak?: number;        // Üst üste yanlış sayısı
}

interface QuestionReviewStats {
  totalXP: number;
  level: number;
  dailyStreak: number;            // Gün olarak seri
  lastStudyDate: string;          // YYYY-MM-DD formatında son çalışma günü
  totalReviews: number;
  correctReviews: number;
  achievements: string[];         // Kazanılan başarım ID'leri
  weeklyHistory: { date: string; reviewed: number; correct: number }[];
}

interface PDFMetadata {
  id: string;
  name: string;
  subject: string;
  category: string;
  addedAt: number;
  size: number;
  url?: string;
  isCloud?: boolean;
}

interface Stroke {
  id: string;
  page: number;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: { x: number; y: number }[];
}

interface ExamSession {
  id: string;
  name: string;
  subject?: string;
  questionCount: number;
  userAnswers: Record<number, string>;
  correctAnswers: Record<number, string>;
  timeElapsed: number;
  activeQuestion: number;
  pdfZoom: number;
  mode: Mode;
  lastAccessed: number;
  pdfId?: string;
  pdfMarks?: { id: string, page: number, x: number, y: number, width?: number, height?: number, color?: 'red' | 'green' | 'yellow', questionNumber?: number, points?: {x: number, y: number}[], markType?: 'dot' | 'cross' | 'tick' | 'green-dot' | 'rect' }[];
  bookmarks?: { id: string, page: number, note: string, addedAt: number }[];
  drawings?: Stroke[];
  // FIX: PDF'in son scroll pozisyonu (Virtuoso item index). twoPageView=false iken sayfa-1, true iken çift sayfa index'i.
  lastPage?: number;
  lastTwoPageView?: boolean;
  // FIX: PDF tamamlanma yüzdesi için — kullanıcının ulaştığı en yüksek SAYFA numarası (1-based, twoPageView bağımsız)
  maxPageViewed?: number;
  // PDF'in toplam sayfa sayısı (cache)
  totalPages?: number;
  // FIX: Manuel "okudum" işareti konan sayfalar (1-based sayfa numaraları)
  readPages?: number[];
}

interface SavedNote {
  id: string;
  subject: string;
  topic?: string;
  image: string;       // base64 veya URL
  title?: string;      // opsiyonel başlık
  date: number;
  pdfId?: string;
  pdfName?: string;
  page?: number;
  rect?: { x: number; y: number; width: number; height: number };
  nextReviewDate?: number; // Günlük tekrar: epoch ms, gün başı (00:00)
  reviewCount?: number;    // Kaç kez tekrar edildi
  // FIX: Bilimsel tekrar (SM-2 benzeri) alanları
  easeFactor?: number;     // Kolaylık katsayısı (default 2.5, min 1.3)
  intervalDays?: number;   // Son seçilen aralık (gün)
  lapses?: number;         // Kaç kez unutuldu ("bilmiyorum")
  lastReviewedAt?: number; // Son tekrar zamanı (epoch ms)
  // FIX: Kategori/renk — Önemli/Örnek/Tanım/Formül
  category?: 'onemli' | 'ornek' | 'tanim' | 'formul' | 'diger';
}

// Kategori renk ve ikon haritası
const NOTE_CATEGORIES: Record<string, { label: string; color: string; bg: string; border: string; emoji: string }> = {
  onemli: { label: 'Önemli', color: 'text-rose-400', bg: 'bg-rose-900/30', border: 'border-rose-500/40', emoji: '🔴' },
  ornek:  { label: 'Örnek', color: 'text-blue-400',  bg: 'bg-blue-900/30',  border: 'border-blue-500/40',  emoji: '💡' },
  tanim:  { label: 'Tanım', color: 'text-emerald-400', bg: 'bg-emerald-900/30', border: 'border-emerald-500/40', emoji: '📖' },
  formul: { label: 'Formül', color: 'text-amber-400', bg: 'bg-amber-900/30',  border: 'border-amber-500/40',  emoji: '🧮' },
  diger:  { label: 'Diğer', color: 'text-slate-400', bg: 'bg-slate-800',     border: 'border-slate-700',     emoji: '📌' },
};

// FIX: Ezber kartları — kullanıcının kendi yazdığı metin tabanlı ezber kartları
// Örnek: "Coğrafya → Göller → Van Gölü: Türkiye'nin en büyük gölü, ..."
interface MemorizeCard {
  id: string;
  subject: string;              // Ders: "Coğrafya", "Tarih" vs.
  topic: string;                // Konu: "Göller", "Dağlar", "Yazar Eser" vs.
  front: string;                // Ön yüz (soru/ipucu): "Van Gölü"
  back: string;                 // Arka yüz (cevap): "Türkiye'nin en büyük gölü, sodalı"
  createdAt: number;
  // SM-2 alanları (SavedNote ile aynı)
  nextReviewDate?: number;
  reviewCount?: number;
  easeFactor?: number;
  intervalDays?: number;
  lapses?: number;
  lastReviewedAt?: number;
}

const SUBJECTS = ['Türkçe', 'Matematik', 'Tarih', 'Coğrafya', 'Vatandaşlık'];
const CATEGORIES = ['Konu Anlatımı', 'Soru Bankası', 'Branş Denemesi', 'Önemli Fotoğraflar ve Notlar', 'Plan'];

const KPSS_TOPICS: Record<string, string[]> = {
  'Türkçe': [
    'Sözcükte Anlam',
    'Cümlede Anlam',
    'Paragrafta Anlam',
    'Ses Bilgisi',
    'Yazım Kuralları',
    'Noktalama İşaretleri',
    'Sözcükte Yapı',
    'Sözcük Türleri',
    'Cümlenin Ögeleri',
    'Fiilde Çatı',
    'Cümle Türleri',
    'Anlatım Bozuklukları'
  ],
  'Matematik': [
    'Temel Kavramlar',
    'Sayı Basamakları',
    'Bölme - Bölünebilme',
    'OBEB - OKEK',
    'Rasyonel Sayılar',
    'Basit Eşitsizlikler',
    'Mutlak Değer',
    'Üslü Sayılar',
    'Köklü Sayılar',
    'Çarpanlara Ayırma',
    'Oran - Orantı',
    'Denklem Çözme',
    'Problemler',
    'Kümeler',
    'Fonksiyonlar',
    'Permütasyon - Kombinasyon - Olasılık',
    'Tablo - Grafik',
    'Sayısal Mantık',
    'Geometri'
  ],
  'Tarih': [
    'İslamiyet Öncesi Türk Tarihi',
    'İlk Türk İslam Devletleri',
    'Osmanlı Kuruluş Dönemi',
    'Osmanlı Yükselme Dönemi',
    'Osmanlı Duraklama Dönemi',
    'Osmanlı Gerileme Dönemi',
    'Osmanlı Dağılma Dönemi',
    'Osmanlı Kültür ve Medeniyeti',
    'Kurtuluş Savaşı Hazırlık Dönemi',
    'I. TBMM Dönemi',
    'Kurtuluş Savaşı Muharebeleri',
    'Atatürk İlke ve İnkılapları',
    'Atatürk Dönemi Dış Politika',
    'Çağdaş Türk ve Dünya Tarihi'
  ],
  'Coğrafya': [
    'Türkiye\'nin Coğrafi Konumu',
    'Türkiye\'nin Yer Şekilleri',
    'Türkiye\'nin İklimi',
    'Türkiye\'nin Bitki Örtüsü',
    'Türkiye\'de Nüfus',
    'Türkiye\'de Yerleşme',
    'Türkiye\'de Tarım ve Hayvancılık',
    'Türkiye\'de Madenler ve Enerji',
    'Türkiye\'de Sanayi',
    'Türkiye\'de Ulaşım ve Ticaret',
    'Türkiye\'de Turizm',
    'Türkiye\'nin Bölgeleri'
  ],
  'Vatandaşlık': [
    'Hukukun Temel Kavramları',
    'Devlet Biçimleri ve Demokrasi',
    'Anayasa Hukukuna Giriş',
    '1982 Anayasası Temel İlkeleri',
    'Temel Hak ve Hürriyetler',
    'Yasama',
    'Yürütme',
    'Yargı',
    'İdare Hukuku',
    'Güncel Bilgiler'
  ]
};

const OPTIONS = ['A', 'B', 'C', 'D', 'E'];
const ZOOM_STEPS = [50, 60, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];

const createImageWithNotes = (base64Image: string, q: SavedQuestion): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64Image);
        return;
      }

      const fontSize = Math.max(16, Math.floor(img.width * 0.03));
      const padding = Math.max(20, Math.floor(img.width * 0.04));
      const lineHeight = Math.floor(fontSize * 1.5);
      const textWidth = img.width - (padding * 2);
      
      ctx.font = `${fontSize}px sans-serif`;
      
      const wrapText = (text: string, maxWidth: number) => {
        const words = text.split(' ');
        const lines = [];
        let currentLine = words[0];

        for (let i = 1; i < words.length; i++) {
          const word = words[i];
          const width = ctx.measureText(currentLine + " " + word).width;
          if (width < maxWidth) {
            currentLine += " " + word;
          } else {
            lines.push(currentLine);
            currentLine = word;
          }
        }
        lines.push(currentLine);
        return lines;
      };

      let textLines: string[] = [];
      if (q.topic) {
        textLines.push(`Konu: ${q.topic}`);
      }
      if (q.correctAnswer) {
        textLines.push(`Doğru Cevap: ${q.correctAnswer}`);
      }
      if (q.notes) {
        if (textLines.length > 0) textLines.push('');
        textLines.push('Notlar:');
        const noteLines = q.notes.split('\n');
        noteLines.forEach(nl => {
          textLines = textLines.concat(wrapText(nl, textWidth));
        });
      }

      const hasText = textLines.length > 0;
      const textHeight = hasText ? (textLines.length * lineHeight) + (padding * 2) : 0;

      canvas.width = img.width;
      canvas.height = img.height + textHeight;

      // Draw original image
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      // Draw text background
      if (hasText) {
        ctx.fillStyle = '#f8fafc'; // slate-50
        ctx.fillRect(0, img.height, canvas.width, textHeight);
        
        ctx.fillStyle = '#e2e8f0'; // slate-200
        ctx.fillRect(0, img.height, canvas.width, 1); // separator line

        // Draw text
        ctx.fillStyle = '#0f172a'; // slate-900
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textBaseline = 'top';
        
        textLines.forEach((line, index) => {
          const y = img.height + padding + (index * lineHeight);
          ctx.fillText(line, padding, y);
        });
      }

      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(base64Image);
    img.src = base64Image;
  });
};

export default function App() {
  const { user, signInWithGoogle, logout, loginWithPassword } = useAuth();
  const [uploadProgress, setUploadProgress] = useState<Record<string, {name: string, pct: number}>>({});
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<any>(null);
  const [showTrackingModal, setShowTrackingModal] = useState(false);
  const [trackingData, setTrackingData] = useState<any[]>([]);
  const [trackingActiveSubject, setTrackingActiveSubject] = useState('Tarih');

  const KPSS_TOPICS_LIST: Record<string, string[]> = {
    'Tarih': [
      'İslamiyet Öncesi Türk Tarihi', 'İlk Türk İslam Devletleri',
      'Osmanlı Devleti Kuruluş Dönemi', 'Osmanlı Devleti Yükselme Dönemi',
      'Osmanlı Devleti Duraklama ve Gerileme', 'Osmanlı Kültür ve Medeniyeti',
      '20. Yüzyılda Osmanlı Devleti', 'Kurtuluş Savaşı Hazırlık Dönemi',
      'I. TBMM Dönemi', 'Kurtuluş Savaşı Muharebeler', 'Lozan Barış Antlaşması',
      'Atatürk İlke ve İnkılapları', 'Atatürk Dönemi İç Politika',
      'Atatürk Dönemi Dış Politika', 'Çağdaş Türk ve Dünya Tarihi'
    ],
    'Matematik': [
      'Temel Kavramlar', 'Rasyonel Sayılar', 'Üslü Sayılar', 'Köklü Sayılar',
      'Çarpanlara Ayırma', 'Denklem Çözme', 'Oran-Orantı', 'Problemler',
      'Kümeler', 'Fonksiyonlar', 'Permütasyon-Kombinasyon', 'Olasılık',
      'Tablo-Grafik Okuma', 'Geometri', 'Sayısal Mantık'
    ],
    'Türkçe': [
      'Sözcükte Anlam', 'Cümlede Anlam', 'Paragrafta Anlam',
      'Ses Bilgisi', 'Yapı Bilgisi', 'Sözcük Türleri',
      'Cümle Ögeleri', 'Cümle Türleri', 'Anlatım Bozuklukları',
      'Yazım Kuralları', 'Noktalama İşaretleri', 'Sözel Mantık'
    ],
    'Coğrafya': [
      'Türkiye Coğrafi Konum', 'Yer Şekilleri', 'İklim ve Bitki Örtüsü',
      'Nüfus ve Yerleşme', 'Tarım', 'Hayvancılık',
      'Madenler ve Enerji', 'Sanayi', 'Ulaşım', 'Ticaret',
      'Turizm', 'Türkiye Bölgeleri'
    ],
    'Vatandaşlık': [
      'Hukukun Temel Kavramları', 'Devlet Biçimleri ve Demokrasi',
      'Anayasa Hukukuna Giriş', '1982 Anayasası', 'Temel Haklar ve Ödevler',
      'Yasama', 'Yürütme', 'Yargı', 'İdare Hukuku'
    ]
  };

  const loadTrackingData = async () => {
    // FIX #9: Login olmayan kullanıcılar için localforage fallback
    if (!user) {
      try {
        const local = await localforage.getItem<any[]>('tracking_data');
        if (local) setTrackingData(local);
      } catch {}
      return;
    }
    try {
      const token = await user.getIdToken();
      const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
      const r = await fetch(`${BASE}/tracking`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setTrackingData(await r.json());
    } catch {}
  };

  const saveTracking = async (item: any) => {
    // FIX Konu Takibi KRİTİK: Yeni kayıtlarda id yoktu → /tracking/undefined'a istek gidiyordu
    // Her zaman id garanti et
    const itemWithId = item.id ? item : { ...item, id: uuidv4() };

    // FIX #9: Login olmayan kullanıcılar için localforage'a kaydet
    if (!user) {
      try {
        setTrackingData(prev => {
          // id veya (subject+topic+pdf_name) ile eşleştir
          const exists = prev.find(t => t.id === itemWithId.id ||
            (t.subject === itemWithId.subject && t.topic === itemWithId.topic && t.pdf_name === itemWithId.pdf_name));
          const updated = exists
            ? prev.map(t => (t.id === itemWithId.id || (t.subject === itemWithId.subject && t.topic === itemWithId.topic && t.pdf_name === itemWithId.pdf_name)) ? itemWithId : t)
            : [...prev, itemWithId];
          localforage.setItem('tracking_data', updated).catch(console.error);
          return updated;
        });
      } catch {}
      return;
    }
    try {
      const token = await user.getIdToken();
      const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
      const r = await fetch(`${BASE}/tracking/${itemWithId.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(itemWithId),
      });
      if (!r.ok) {
        console.error('Tracking save failed:', r.status, await r.text());
        return;
      }
      setTrackingData(prev => {
        const exists = prev.find(t => t.id === itemWithId.id);
        if (exists) return prev.map(t => t.id === itemWithId.id ? itemWithId : t);
        return [...prev, itemWithId];
      });
    } catch (e) {
      console.error('saveTracking error:', e);
    }
  };
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const handleLogin = async () => {
    setLoginLoading(true);
    setLoginError('');
    try {
      await loginWithPassword(loginUsername, loginPassword);
      setShowLoginModal(false);
      setLoginUsername('');
      setLoginPassword('');
    } catch (e: any) {
      setLoginError(e.message || 'Giriş başarısız');
    } finally {
      setLoginLoading(false);
    }
  };
  const [mode, setMode] = useState<Mode>('setup');
  const [questionCount, setQuestionCount] = useState<number>(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, string>>({});
  const [correctAnswers, setCorrectAnswers] = useState<Record<number, string>>({});
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [currentPdfId, setCurrentPdfId] = useState<string | null>(null);
  const [customCount, setCustomCount] = useState<string>('');
  const [showFinishModal, setShowFinishModal] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showReviewPDF, setShowReviewPDF] = useState<boolean>(false);
  const [pendingReviewScroll, setPendingReviewScroll] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isCropMode, setIsCropMode] = useState<boolean>(false);
  const [isHighlightMode, setIsHighlightMode] = useState<boolean>(false);
  const [isNoteCropMode, setIsNoteCropMode] = useState<boolean>(false); // NOT KES modu
  const [noteCropState, setNoteCropState] = useState<{ page: number, startX: number, startY: number, currentX: number, currentY: number } | null>(null);
  const [noteImage, setNoteImage] = useState<string | null>(null);
  const [showNoteModal, setShowNoteModal] = useState<boolean>(false);
  const [isSavingNote, setIsSavingNote] = useState<boolean>(false);
  const [noteCropSubject, setNoteCropSubject] = useState<string>(SUBJECTS[0]);
  const [noteCropTopic, setNoteCropTopic] = useState<string>('');
  const [noteCropTitle, setNoteCropTitle] = useState<string>('');
  const [savedNotes, setSavedNotes] = useState<SavedNote[]>([]);
  const [noteCropPage, setNoteCropPage] = useState<number>(1);
  const [noteCropRect, setNoteCropRect] = useState<{x:number,y:number,width:number,height:number} | null>(null);
  const [activeMarkTool, setActiveMarkTool] = useState<'red-dot' | 'green-dot' | 'green-tick' | 'red-cross'>('red-dot');
  const [cropState, setCropState] = useState<{ page: number, startX: number, startY: number, currentX: number, currentY: number } | null>(null);
  const [highlightState, setHighlightState] = useState<{ page: number, points: {x: number, y: number}[] } | null>(null);
  const [showCropModal, setShowCropModal] = useState<boolean>(false);
  const [cropSubject, setCropSubject] = useState<string>(SUBJECTS[0]);
  const [cropTopic, setCropTopic] = useState<string>('');
  const [lastTopicBySubject, setLastTopicBySubject] = useState<Record<string, string>>({});
  const [showTestBuilderModal, setShowTestBuilderModal] = useState<boolean>(false);
  const [showNoteLayoutBuilder, setShowNoteLayoutBuilder] = useState<boolean>(false);
  const [noteLayoutSelected, setNoteLayoutSelected] = useState<Set<string>>(new Set());
  const [noteLayoutCols, setNoteLayoutCols] = useState<1 | 2 | 3>(2);
  const [noteLayoutFilterSubject, setNoteLayoutFilterSubject] = useState<string>('');
  const [noteLayoutFilterTopic, setNoteLayoutFilterTopic] = useState<string>('');
  const [noteLayoutBuilding, setNoteLayoutBuilding] = useState<boolean>(false);
  const [testBuilderSubject, setTestBuilderSubject] = useState<string>('');
  const [testBuilderTopic, setTestBuilderTopic] = useState<string>('');
  const [testBuilderQuestionCount, setTestBuilderQuestionCount] = useState<number>(0);
  const [testBuilderAnswerPosition, setTestBuilderAnswerPosition] = useState<'bottom-right' | 'end'>('end');
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean, message: string, onConfirm: () => void } | null>(null);
  const [cropImage, setCropImage] = useState<string | null>(null);
  const shareFileRef = useRef<File | null>(null);
  const [savedQuestions, setSavedQuestions] = useState<SavedQuestion[]>([]);

  // ─── KPSS Ustası — Bilimsel Soru Tekrar Sistemi (SM-2) ───────────────────
  const [ustasiQueue, setUstasiQueue] = useState<SavedQuestion[]>([]);
  const [ustasiIndex, setUstasiIndex] = useState<number>(0);
  const [ustasiSelectedAnswer, setUstasiSelectedAnswer] = useState<string | null>(null);
  const [ustasiShowResult, setUstasiShowResult] = useState<boolean>(false);
  const [ustasiSessionStats, setUstasiSessionStats] = useState<{
    correct: number; wrong: number; xpGained: number; startTime: number;
    relapseQueue: SavedQuestion[];  // Bu oturumda yanlış olup 10dk sonra dönecek sorular
  }>({ correct: 0, wrong: 0, xpGained: 0, startTime: Date.now(), relapseQueue: [] });
  const [reviewStats, setReviewStats] = useState<QuestionReviewStats>({
    totalXP: 0, level: 1, dailyStreak: 0, lastStudyDate: '',
    totalReviews: 0, correctReviews: 0, achievements: [], weeklyHistory: []
  });
  const [ustasiFilterSubject, setUstasiFilterSubject] = useState<string>('__all__');
  const [ustasiMaxNew, setUstasiMaxNew] = useState<number>(20); // Günlük yeni soru limiti
  const [ustasiShowStats, setUstasiShowStats] = useState<boolean>(false);
  const [ustasiAchievementToast, setUstasiAchievementToast] = useState<string | null>(null);

  // ── Sınav tarihi (KPSS Önlisans için) ──────────────────────────────────
  const [examDate, setExamDate] = useState<string>(''); // YYYY-MM-DD
  useEffect(() => {
    (async () => {
      const d = await localforage.getItem<string>('exam_date');
      if (d) setExamDate(d);
    })();
  }, []);
  const persistExamDate = async (d: string) => {
    await localforage.setItem('exam_date', d);
    setExamDate(d);
  };
  const daysToExam = (): number | null => {
    if (!examDate) return null;
    const target = new Date(examDate).getTime();
    const now = Date.now();
    return Math.max(0, Math.ceil((target - now) / 86400000));
  };
  const examIntensity = (): 'normal' | 'orta' | 'yogun' | 'kritik' => {
    const d = daysToExam();
    if (d === null) return 'normal';
    if (d < 30) return 'kritik';
    if (d < 60) return 'yogun';
    if (d < 100) return 'orta';
    return 'normal';
  };

  // ═══════════════════════════════════════════════════════════════════════
  // ⏱ ÇALIŞMA SAYACI — State
  // ═══════════════════════════════════════════════════════════════════════
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };

  const [studyState, setStudyState] = useState<StudyState>({
    phase: 'idle',
    mode: 'deepwork',
    phaseStartedAt: 0,
    accumulatedInPhase: 0,
    completedWorkBlocks: 0,
    todayTotalSeconds: 0,
    todayDate: todayStr(),
  });
  const [studyHistory, setStudyHistory] = useState<StudySession[]>([]);
  const [studyCustomGoal, setStudyCustomGoal] = useState<number>(0); // Dakika; 0 = adaptif
  const [studyTelegramOn, setStudyTelegramOn] = useState<boolean>(true);
  const [studyBrowserNotifOn, setStudyBrowserNotifOn] = useState<boolean>(true);
  const [studyTick, setStudyTick] = useState(0); // Ticker — her saniye artar
  const studyStateRef = useRef(studyState);
  studyStateRef.current = studyState;

  // Hedef (dakika) — sınav yaklaşımına göre adaptif + manuel override
  const studyGoalMinutes = useMemo((): number => {
    if (studyCustomGoal > 0) return studyCustomGoal;
    if (!examDate) return 180;
    const d = Math.max(0, Math.ceil((new Date(examDate).getTime() - Date.now()) / 86400000));
    if (d < 30) return 360;    // 6 saat
    if (d < 60) return 300;    // 5 saat
    if (d < 100) return 240;   // 4 saat
    return 180;                 // 3 saat
  }, [studyCustomGoal, examDate]);

  // ═══════════════════════════════════════════════════════════════════════
  // 🐛 GLOBAL ERROR HANDLER — yakalanan tüm hataları sunucuya ilet
  // ═══════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const reportError = async (message: string, stack?: string, source?: string) => {
      try {
        const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
        await fetch(`${BASE}/client-error`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message, stack, userAgent: navigator.userAgent,
            url: window.location.href, mode, component: source || 'global',
          }),
        });
      } catch {}
    };

    const onError = (event: ErrorEvent) => {
      reportError(event.message, event.error?.stack, 'window.onerror');
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const msg = typeof reason === 'string' ? reason : reason?.message || String(reason);
      reportError(`Unhandled Promise: ${msg}`, reason?.stack, 'unhandledrejection');
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [mode]);

  // İlk yüklemede localforage'dan state'i oku
  useEffect(() => {
    (async () => {
      try {
        const s = await localforage.getItem<StudyState>('study_state');
        const h = await localforage.getItem<StudySession[]>('study_history');
        const g = await localforage.getItem<number>('study_custom_goal');
        const tg = await localforage.getItem<boolean>('study_telegram');
        const bn = await localforage.getItem<boolean>('study_browser_notif');
        
        if (s) {
          // Gün değişmiş mi kontrol — eğer evet dünkü toplamı history'ye ekle
          if (s.todayDate !== todayStr()) {
            if (s.todayTotalSeconds > 0 && h) {
              const already = h.find(x => x.date === s.todayDate);
              if (!already) {
                h.push({
                  date: s.todayDate,
                  totalSeconds: s.todayTotalSeconds,
                  workBlocks: s.completedWorkBlocks,
                  breaks: 0,
                  mode: s.mode,
                  timeline: [],
                });
                await localforage.setItem('study_history', h);
              }
            }
            // Bugün için sıfırla
            const fresh: StudyState = {
              ...s,
              phase: 'idle',
              phaseStartedAt: 0,
              accumulatedInPhase: 0,
              completedWorkBlocks: 0,
              todayTotalSeconds: 0,
              todayDate: todayStr(),
            };
            setStudyState(fresh);
            await localforage.setItem('study_state', fresh);
          } else {
            // Aynı gün — eğer working/break fazındaysa, geçen süreyi hesaba kat
            if (s.phase === 'working' || s.phase === 'break') {
              const elapsed = Math.floor((Date.now() - s.phaseStartedAt) / 1000);
              const newTotal = s.phase === 'working' 
                ? s.todayTotalSeconds + Math.max(0, elapsed - s.accumulatedInPhase)
                : s.todayTotalSeconds;
              setStudyState({ ...s, todayTotalSeconds: newTotal });
            } else {
              setStudyState(s);
            }
          }
        }
        if (h) setStudyHistory(h);
        if (typeof g === 'number') setStudyCustomGoal(g);
        if (typeof tg === 'boolean') setStudyTelegramOn(tg);
        if (typeof bn === 'boolean') setStudyBrowserNotifOn(bn);
      } catch (e) {
        console.error('study state load:', e);
      }
    })();
  }, []);

  // Persist — state değiştikçe localforage'a yaz
  useEffect(() => {
    localforage.setItem('study_state', studyState).catch(()=>{});
  }, [studyState]);
  useEffect(() => {
    localforage.setItem('study_history', studyHistory).catch(()=>{});
  }, [studyHistory]);
  useEffect(() => {
    localforage.setItem('study_custom_goal', studyCustomGoal).catch(()=>{});
  }, [studyCustomGoal]);
  useEffect(() => {
    localforage.setItem('study_telegram', studyTelegramOn).catch(()=>{});
  }, [studyTelegramOn]);
  useEffect(() => {
    localforage.setItem('study_browser_notif', studyBrowserNotifOn).catch(()=>{});
  }, [studyBrowserNotifOn]);

  // Ticker — her saniye bir render trigger (sayaç görünsün diye)
  useEffect(() => {
    if (studyState.phase === 'working' || studyState.phase === 'break') {
      const t = setInterval(() => setStudyTick(v => v + 1), 1000);
      return () => clearInterval(t);
    }
  }, [studyState.phase]);

  // Gün değişimini yakala (örn 23:59 → 00:01 sırasında sayfa açıksa)
  useEffect(() => {
    const check = setInterval(() => {
      const t = todayStr();
      if (studyStateRef.current.todayDate !== t) {
        setStudyState(s => {
          // Dünkü'yü history'ye ekle
          if (s.todayTotalSeconds > 0) {
            setStudyHistory(h => {
              if (h.find(x => x.date === s.todayDate)) return h;
              return [...h, {
                date: s.todayDate,
                totalSeconds: s.todayTotalSeconds,
                workBlocks: s.completedWorkBlocks,
                breaks: 0,
                mode: s.mode,
                timeline: [],
              }];
            });
          }
          // Yeni gün — çalışma devam ediyorsa phase'i koruyoruz
          if (s.phase === 'working') {
            // Gece yarısını geçti — phaseStartedAt'i now'a çek ki yarının sayacı temiz başlasın
            sendStudyNotif('🌅 Yeni gün başladı!', 'Sayaç sıfırlandı, çalışmaya devam edebilirsin.');
            return {
              ...s,
              phaseStartedAt: Date.now(),
              accumulatedInPhase: 0,
              completedWorkBlocks: 0,
              todayTotalSeconds: 0,
              todayDate: t,
            };
          }
          return { ...s, todayTotalSeconds: 0, todayDate: t, completedWorkBlocks: 0 };
        });
      }
    }, 30000); // Her 30 sn kontrol
    return () => clearInterval(check);
  }, []);

  // Browser notification izni
  useEffect(() => {
    if (studyBrowserNotifOn && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(()=>{});
    }
  }, [studyBrowserNotifOn]);

  // Bildirim gönderici — browser + telegram
  const sendStudyNotif = (title: string, body: string) => {
    // Browser
    if (studyBrowserNotifOn && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(title, { body, icon: '/pdftest/icon.png', tag: 'study' }); } catch {}
    }
    // Telegram (backend üzerinden)
    if (studyTelegramOn && user) {
      (async () => {
        try {
          const token = await user.getIdToken();
          const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
          await fetch(`${BASE}/study/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ title, body }),
          });
        } catch {}
      })();
    }
  };

  // Çalışma başlat
  const startStudyWork = () => {
    const preset = STUDY_PRESETS.find(p => p.id === studyState.mode)!;
    setStudyState(s => ({
      ...s,
      phase: 'working',
      phaseStartedAt: Date.now(),
      accumulatedInPhase: 0,
    }));
    sendStudyNotif(`${preset.icon} Çalışma Başladı`, `${preset.name}: ${preset.workMin} dk odak`);
  };

  // Mola başlat
  const startStudyBreak = (long: boolean = false) => {
    const preset = STUDY_PRESETS.find(p => p.id === studyState.mode)!;
    // İş bloğu tamamlandı
    setStudyState(s => {
      const elapsed = Math.floor((Date.now() - s.phaseStartedAt) / 1000);
      const workedNow = Math.max(0, elapsed - s.accumulatedInPhase);
      return {
        ...s,
        phase: 'break',
        phaseStartedAt: Date.now(),
        accumulatedInPhase: 0,
        completedWorkBlocks: s.completedWorkBlocks + 1,
        todayTotalSeconds: s.todayTotalSeconds + workedNow,
      };
    });
    const min = long ? preset.longBreakMin : preset.breakMin;
    sendStudyNotif('☕ Mola zamanı', `${min} dk dinlen. Su iç, biraz yürü.`);
  };

  // Çalışmayı devam et (mola bitti)
  const resumeStudyWork = () => {
    const preset = STUDY_PRESETS.find(p => p.id === studyState.mode)!;
    setStudyState(s => ({
      ...s,
      phase: 'working',
      phaseStartedAt: Date.now(),
      accumulatedInPhase: 0,
    }));
    sendStudyNotif(`${preset.icon} Devam`, `${preset.workMin} dk odaklanma başladı`);
  };

  // Pause (elle)
  const pauseStudy = () => {
    setStudyState(s => {
      if (s.phase !== 'working' && s.phase !== 'break') return s;
      const elapsed = Math.floor((Date.now() - s.phaseStartedAt) / 1000);
      // Working ise çalışma süresini total'e ekle
      const newTotal = s.phase === 'working' 
        ? s.todayTotalSeconds + Math.max(0, elapsed - s.accumulatedInPhase)
        : s.todayTotalSeconds;
      return {
        ...s,
        phase: 'paused',
        accumulatedInPhase: elapsed,
        todayTotalSeconds: newTotal,
      };
    });
  };

  // Tamamen bitir — bugünkü oturumu kapat
  const stopStudy = () => {
    setStudyState(s => {
      if (s.phase === 'working') {
        const elapsed = Math.floor((Date.now() - s.phaseStartedAt) / 1000);
        return {
          ...s,
          phase: 'idle',
          phaseStartedAt: 0,
          accumulatedInPhase: 0,
          todayTotalSeconds: s.todayTotalSeconds + Math.max(0, elapsed - s.accumulatedInPhase),
        };
      }
      return { ...s, phase: 'idle', phaseStartedAt: 0, accumulatedInPhase: 0 };
    });
    sendStudyNotif('⏹ Çalışma Durdu', 'Bugünlük güzel iş, yarın görüşürüz!');
  };

  // Otomatik phase geçişi — work bitti mi? break bitti mi?
  useEffect(() => {
    if (studyState.phase === 'idle' || studyState.phase === 'paused') return;
    const preset = STUDY_PRESETS.find(p => p.id === studyState.mode)!;
    const elapsedSec = Math.floor((Date.now() - studyState.phaseStartedAt) / 1000);
    
    if (studyState.phase === 'working') {
      const targetSec = preset.workMin * 60;
      if (preset.id !== 'flexible' && elapsedSec >= targetSec) {
        // Uzun mola zamanı mı?
        const nextBlockNumber = studyState.completedWorkBlocks + 1;
        const isLongBreak = nextBlockNumber % preset.longBreakEvery === 0;
        startStudyBreak(isLongBreak);
      }
    } else if (studyState.phase === 'break') {
      const blocksDone = studyState.completedWorkBlocks;
      const isLongBreak = blocksDone > 0 && blocksDone % preset.longBreakEvery === 0;
      const breakTarget = (isLongBreak ? preset.longBreakMin : preset.breakMin) * 60;
      if (elapsedSec >= breakTarget) {
        sendStudyNotif('🔔 Mola bitti!', 'Tekrar çalışmaya başlayabilirsin.');
        setStudyState(s => ({ ...s, phase: 'idle' }));
      }
    }
  }, [studyTick, studyState.phase]);


  // ── Analiz: zayıf konu / hata günlüğü hesapla ──────────────────────────
  const analyzeStats = useMemo(() => {
    type ConcreteStat = { subject: string; topic: string; total: number; wrong: number; lastReview: number };
    const map = new Map<string, ConcreteStat>();
    const errorBook: SavedQuestion[] = []; // En az 1 lapse olanlar

    for (const q of savedQuestions) {
      if (!q.correctAnswer || !q.srsReviewCount) continue;
      const key = `${q.subject}|||${q.topic || 'Genel'}`;
      const existing = map.get(key) || {
        subject: q.subject, topic: q.topic || 'Genel', total: 0, wrong: 0, lastReview: 0
      };
      existing.total += 1;
      if ((q.srsLapses || 0) > 0) {
        existing.wrong += (q.srsLapses || 0);
        if (!errorBook.find(e => e.id === q.id)) errorBook.push(q);
      }
      existing.lastReview = Math.max(existing.lastReview, q.srsLastReviewedAt || 0);
      map.set(key, existing);
    }

    const allTopics = Array.from(map.values()).filter(t => t.total >= 2);
    const weakest = [...allTopics]
      .map(t => ({ ...t, errorRate: t.total > 0 ? t.wrong / t.total : 0 }))
      .filter(t => t.errorRate > 0)
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, 10);

    const strongest = [...allTopics]
      .map(t => ({ ...t, errorRate: t.total > 0 ? t.wrong / t.total : 0 }))
      .filter(t => t.errorRate < 0.2)
      .sort((a, b) => a.errorRate - b.errorRate)
      .slice(0, 10);

    // Ders bazlı genel başarı
    const bySubject: Record<string, { total: number; wrong: number; mastered: number }> = {};
    for (const q of savedQuestions.filter(sq => sq.correctAnswer)) {
      if (!bySubject[q.subject]) bySubject[q.subject] = { total: 0, wrong: 0, mastered: 0 };
      bySubject[q.subject].total += 1;
      if ((q.srsLapses || 0) > 0) bySubject[q.subject].wrong += 1;
      if (q.srsStage === 'mastered') bySubject[q.subject].mastered += 1;
    }

    // Hata günlüğü: en sık hata yapılan sırayla
    errorBook.sort((a, b) => (b.srsLapses || 0) - (a.srsLapses || 0));

    return {
      weakest, strongest, bySubject, errorBook,
      totalQuestions: savedQuestions.filter(q => q.correctAnswer).length,
      reviewedQuestions: savedQuestions.filter(q => q.srsReviewCount).length,
      masteredCount: savedQuestions.filter(q => q.srsStage === 'mastered').length,
      learningCount: savedQuestions.filter(q => q.srsStage === 'learning').length,
    };
  }, [savedQuestions]);

  const [gameModeQuestions, setGameModeQuestions] = useState<SavedQuestion[] | null>(null);
  const [currentGameQuestionIndex, setCurrentGameQuestionIndex] = useState(0);
  const [gameModeAnswers, setGameModeAnswers] = useState<Record<string, string>>({});
  const [gameModeFinished, setGameModeFinished] = useState(false);
  const [gameModeTimeLeft, setGameModeTimeLeft] = useState(60);
  // Not tekrar modu (flashcard)
  const [noteReviewNotes, setNoteReviewNotes] = useState<SavedNote[] | null>(null);
  const [noteReviewIndex, setNoteReviewIndex] = useState(0);
  const [noteReviewDone, setNoteReviewDone] = useState<Set<string>>(new Set());
  const [noteReviewSkipped, setNoteReviewSkipped] = useState<Set<string>>(new Set());
  // FIX: Ezber Kartları (metin tabanlı, SM-2 destekli)
  const [memorizeCards, setMemorizeCards] = useState<MemorizeCard[]>([]);
  const [memorizeReviewCards, setMemorizeReviewCards] = useState<MemorizeCard[] | null>(null);
  const [memorizeReviewIndex, setMemorizeReviewIndex] = useState(0);
  const [memorizeReviewShowBack, setMemorizeReviewShowBack] = useState(false);
  const [memorizeReviewDone, setMemorizeReviewDone] = useState<Set<string>>(new Set());
  const [showAddMemorizeModal, setShowAddMemorizeModal] = useState(false);
  const [memorizeFilterSubject, setMemorizeFilterSubject] = useState<string>('');
  const [memorizeFilterTopic, setMemorizeFilterTopic] = useState<string>('');
  const [memorizeNewSubject, setMemorizeNewSubject] = useState<string>('');
  const [memorizeNewTopic, setMemorizeNewTopic] = useState<string>('');
  const [memorizeNewFront, setMemorizeNewFront] = useState<string>('');
  const [memorizeNewBack, setMemorizeNewBack] = useState<string>('');
  const [memorizeBulkText, setMemorizeBulkText] = useState<string>('');
  const [memorizeAddMode, setMemorizeAddMode] = useState<'single' | 'bulk' | 'youtube'>('single');
  // FIX: YouTube ezber üretimi state
  const [ytUrl, setYtUrl] = useState<string>('');
  const [ytLoading, setYtLoading] = useState<boolean>(false);
  const [ytVideos, setYtVideos] = useState<{ id: string; title: string; duration?: number }[]>([]);
  const [ytPlaylistName, setYtPlaylistName] = useState<string | null>(null);
  const [ytSelected, setYtSelected] = useState<Set<string>>(new Set());
  const [ytJobId, setYtJobId] = useState<string | null>(null);
  const [ytJobStatus, setYtJobStatus] = useState<any | null>(null);
  const ytPollRef = useRef<number | null>(null);
  // FIX: Fotoğraf/dosya ile soru/not ekleme
  const [photoUploadMode, setPhotoUploadMode] = useState<'question' | 'note' | null>(null);
  const [photoUploadImage, setPhotoUploadImage] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const photoCameraInputRef = useRef<HTMLInputElement>(null);

  // Dosya → base64
  const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Fotoğraf seçildiğinde — büyük resmi küçült (max 1600px), kalite 0.85 JPEG
  const compressImage = async (base64: string, maxSize = 1600, quality = 0.85): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          if (width > height) { height = (height / width) * maxSize; width = maxSize; }
          else { width = (width / height) * maxSize; height = maxSize; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(base64); return; }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(base64);
      img.src = base64;
    });
  };

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('Lütfen bir fotoğraf dosyası seçin.');
      e.target.value = '';
      return;
    }
    try {
      const raw = await fileToBase64(file);
      const compressed = await compressImage(raw);
      setPhotoUploadImage(compressed);
      // Fotoğraf tipine göre uygun modalı aç
      if (photoUploadMode === 'question') {
        setCropImage(compressed);
        setCropSubject(selectedSubject || SUBJECTS[0]);
        setCropTopic(lastTopicBySubject[selectedSubject] || '');
        setShowCropModal(true);
      } else if (photoUploadMode === 'note') {
        setNoteImage(compressed);
        setNoteCropSubject(selectedSubject || SUBJECTS[0]);
        setNoteCropTopic(lastTopicBySubject[selectedSubject] || '');
        setNoteCropTitle('');
        setNoteCropCategory('onemli');
        setNoteCropPage(0); // PDF'ten gelmediği için 0
        setNoteCropRect(null);
        setShowNoteModal(true);
      }
    } catch (err) {
      alert('Fotoğraf yüklenemedi: ' + err);
    } finally {
      e.target.value = '';
      setPhotoUploadMode(null);
    }
  };
  const [autoSaveInterval, setAutoSaveInterval] = useState<number>(5);
  const [activeQuestion, setActiveQuestion] = useState<number>(1);
  const [sessions, setSessions] = useState<ExamSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [selectedSubject, setSelectedSubject] = useState<string>('Genel');

  const saveExamSession = async (session: ExamSession) => {
    if (user) {
      try {
        await api.saveSession(user, { ...session, uid: user.uid });
      } catch (error) {
        console.error("Error saving session:", error);
      }
    } else {
      await localforage.setItem(`exam_${session.id}`, session);
    }
  };

  const deleteExamSession = async (sessionId: string) => {
    if (user) {
      try {
        await api.deleteSession(user, sessionId);
      } catch (error) {
        console.error("Error deleting session:", error);
      }
    } else {
      await localforage.removeItem(`exam_${sessionId}`);
    }
  };
  const [pdfMarks, setPdfMarks] = useState<{ id: string, page: number, x: number, y: number, width?: number, height?: number, color?: 'red' | 'green' | 'yellow', questionNumber?: number, points?: {x: number, y: number}[], markType?: 'dot' | 'cross' | 'tick' | 'green-dot' | 'rect' }[]>([]);
  const [bookmarks, setBookmarks] = useState<{ id: string, page: number, note: string, addedAt: number }[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
  // FIX: PDF Dark Mode — siyah arayüz için PDF renk ters çevirme
  const [pdfDarkMode, setPdfDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem('pdfDarkMode') === 'true'; } catch { return false; }
  });
  // FIX: PDF Tema — 'normal' | 'dark' | 'sepia'
  const [pdfTheme, setPdfTheme] = useState<'normal' | 'dark' | 'sepia'>(() => {
    try {
      const saved = localStorage.getItem('pdfTheme') as any;
      if (saved === 'normal' || saved === 'dark' || saved === 'sepia') return saved;
      // Eski pdfDarkMode'dan taşı
      return localStorage.getItem('pdfDarkMode') === 'true' ? 'dark' : 'normal';
    } catch { return 'normal'; }
  });
  // FIX: Odak/Okuma Modu — toolbar ve navigasyonu gizler
  const [focusMode, setFocusMode] = useState<boolean>(false);
  // FIX: Kontrol Kilidi — sadece kaydır/oku, araçlar pasif
  const [readOnlyLock, setReadOnlyLock] = useState<boolean>(false);
  // FIX: Sayfa hedefi — hangi session için kaç sayfa hedefleniyor, bugün kaç sayfa okundu
  const [pageGoal, setPageGoal] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('pageGoal') || '0') || 0; } catch { return 0; }
  });
  // Session'da ilk görülen min sayfa (okuma başlangıcı) — hedef ilerlemesi için
  const sessionStartPageRef = useRef<number | null>(null);
  const maxPageReachedRef = useRef<number>(0);
  const [pagesRead, setPagesRead] = useState<number>(0); // bu session'da okunan sayfa sayısı
  // FIX: Not kategorisi seçimi (not kesme modalında)
  const [noteCropCategory, setNoteCropCategory] = useState<'onemli' | 'ornek' | 'tanim' | 'formul' | 'diger'>('onemli');
  // FIX: Notlar sayfasında kategori filtresi
  const [notesFilterCategory, setNotesFilterCategory] = useState<string>('');
  
  // Drawing states
  const [drawMode, setDrawMode] = useState<'none' | 'pen' | 'highlighter' | 'eraser'>('none');
  const [drawColor, setDrawColor] = useState<string>('#ef4444');
  const [highlighterColor, setHighlighterColor] = useState<string>('#fef08a');
  const [drawWidth, setDrawWidth] = useState<number>(2);
  const [stylusOnly, setStylusOnly] = useState<boolean>(false); // Default false, user can enable palm rejection
  const [drawings, setDrawings] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);

  const [pdfLibrary, setPdfLibrary] = useState<PDFMetadata[]>([]);
  const [storageUsed, setStorageUsed] = useState<number>(0);
  const [storageDetails, setStorageDetails] = useState<{
    pdfBytes: number; pdfCount: number;
    imageBytes: number; imageCount: number;
    noteImageBytes: number; noteImageCount: number;
    sessionBytes: number; sessionCount: number;
    noteBytes: number; noteCount: number;
    questionMetaBytes: number; questionCount: number;
    memorizeBytes: number; memorizeCount: number;
    drawingCount: number; bookmarkCount: number;
    pdfMarkCount: number; readPageCount: number;
  }>({
    pdfBytes: 0, pdfCount: 0,
    imageBytes: 0, imageCount: 0,
    noteImageBytes: 0, noteImageCount: 0,
    sessionBytes: 0, sessionCount: 0,
    noteBytes: 0, noteCount: 0,
    questionMetaBytes: 0, questionCount: 0,
    memorizeBytes: 0, memorizeCount: 0,
    drawingCount: 0, bookmarkCount: 0,
    pdfMarkCount: 0, readPageCount: 0,
  });
  const STORAGE_LIMIT = 4 * 1024 * 1024 * 1024; // 4 GB in bytes
  const [libraryView, setLibraryView] = useState<'subjects' | 'categories' | 'pdfs'>('subjects');
  const [activeSubject, setActiveSubject] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  // PDF Controls state
  const [pdfZoom, setPdfZoom] = useState<number>(100);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [twoPageView, setTwoPageView] = useState<boolean>(false);
  const [gradingViewMode, setGradingViewMode] = useState<'grid' | 'pdf'>('pdf');
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const currentScrollIndexRef = useRef<number>(0);
  // FIX: Auto-save'in tetiklenmesi için scroll pozisyonu STATE olarak da tutulur (debounced).
  // currentScrollIndexRef her scroll'da güncellenir, bu state ise 1 saniye debounce ile güncellenir.
  const [lastSavedPage, setLastSavedPage] = useState<number>(0);
  const scrollSaveTimeoutRef = useRef<number | null>(null);
  // FIX: PDF tamamlanma yüzdesi — en yüksek görülen sayfa (1-based)
  const [maxPageViewed, setMaxPageViewed] = useState<number>(0);
  // FIX: "Okudum" işareti konulmuş sayfalar (1-based)
  const [readPages, setReadPages] = useState<Set<number>>(new Set());
  // 5 saniyelik otomatik okuma takibi için
  const dwellStartRef = useRef<{ page: number; start: number } | null>(null);

  // Timer state
  const [timeElapsed, setTimeElapsed] = useState<number>(0);
  const [isTimerRunning, setIsTimerRunning] = useState<boolean>(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const savedInterval = localStorage.getItem('autoSaveInterval');
    if (savedInterval) {
      setAutoSaveInterval(parseInt(savedInterval, 10));
    }
  }, []);

  // FIX Fullscreen: ESC ile kapatıldığında state senkronize et + iOS webkit desteği
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNowFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement
      );
      setIsFullscreen(isNowFullscreen);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('autoSaveInterval', autoSaveInterval.toString());
  }, [autoSaveInterval]);

  // FIX: PDF Dark Mode persistence (geriye uyumluluk)
  useEffect(() => {
    localStorage.setItem('pdfDarkMode', pdfDarkMode.toString());
  }, [pdfDarkMode]);

  // FIX: PDF Tema persistence
  useEffect(() => {
    localStorage.setItem('pdfTheme', pdfTheme);
    // Eski flag'i de uyumlu güncelle
    setPdfDarkMode(pdfTheme === 'dark');
  }, [pdfTheme]);

  // FIX: Sayfa hedefi persistence
  useEffect(() => {
    localStorage.setItem('pageGoal', pageGoal.toString());
  }, [pageGoal]);

  // FIX: PDF temaları — sadece canvas'a filter uygula
  useEffect(() => {
    const styleId = 'pdf-theme-style';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (pdfTheme !== 'normal') {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
      }
      if (pdfTheme === 'dark') {
        styleEl.textContent = `
          .react-pdf__Page__canvas {
            filter: invert(0.88) hue-rotate(180deg) contrast(0.92) !important;
            background: #1a1a1a !important;
          }
          .react-pdf__Page { background: #1a1a1a !important; }
        `;
      } else if (pdfTheme === 'sepia') {
        // Sepia: sıcak, düşük kontrastlı, e-reader tarzı
        styleEl.textContent = `
          .react-pdf__Page__canvas {
            filter: sepia(0.35) saturate(1.1) contrast(0.92) brightness(0.96) !important;
            background: #f4ecd8 !important;
          }
          .react-pdf__Page { background: #f4ecd8 !important; }
        `;
      }
    } else if (styleEl) {
      styleEl.remove();
    }
    return () => {
      const el = document.getElementById(styleId);
      if (el && pdfTheme === 'normal') el.remove();
    };
  }, [pdfTheme]);

  useEffect(() => {
    if (isTimerRunning) {
      timerRef.current = window.setInterval(() => {
        setTimeElapsed((prev) => prev + 1);
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isTimerRunning]);

  useEffect(() => {
    if (gameModeQuestions && !gameModeFinished) {
      setGameModeTimeLeft(60);
    }
  }, [currentGameQuestionIndex, gameModeQuestions, gameModeFinished]);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    const currentQ = gameModeQuestions?.[currentGameQuestionIndex];
    const hasAnswered = currentQ && gameModeAnswers[currentQ.id];

    if (gameModeQuestions && !gameModeFinished && gameModeTimeLeft > 0 && !hasAnswered) {
      timer = setInterval(() => {
        setGameModeTimeLeft(prev => prev - 1);
      }, 1000);
    } else if (gameModeQuestions && !gameModeFinished && gameModeTimeLeft === 0 && !hasAnswered) {
      // Auto-advance when time runs out
      setTimeout(() => {
        if (currentGameQuestionIndex === gameModeQuestions.length - 1) {
          setGameModeFinished(true);
        } else {
          setCurrentGameQuestionIndex(prev => prev + 1);
        }
      }, 500);
    }
    return () => clearInterval(timer);
  }, [gameModeQuestions, gameModeFinished, gameModeTimeLeft, currentGameQuestionIndex, gameModeAnswers]);

  // Keyboard shortcuts for fast marking
  useEffect(() => {
    if (mode !== 'taking') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const key = e.key.toUpperCase();
      if (['A', 'B', 'C', 'D', 'E'].includes(key)) {
        setUserAnswers(prev => ({ ...prev, [activeQuestion]: key }));
        if (activeQuestion < questionCount) {
          setActiveQuestion(prev => prev + 1);
        } else {
          setQuestionCount(prev => prev + 1);
          setActiveQuestion(prev => prev + 1);
        }
      } else if (e.key === 'ArrowRight') {
        if (activeQuestion < questionCount) {
          setActiveQuestion(prev => prev + 1);
        } else {
          setQuestionCount(prev => prev + 1);
          setActiveQuestion(prev => prev + 1);
        }
      } else if (e.key === 'ArrowLeft') {
        setActiveQuestion(prev => Math.max(1, prev - 1));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, activeQuestion, questionCount]);

  useEffect(() => {
    let unsubscribeQuestions: () => void;
    let unsubscribeSessions: () => void;

    const loadSessions = async () => {
      if (user) {
        // Load from Firestore
        // Load questions, sessions, PDFs from server
        try {
          const token = await user.getIdToken();
          const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
          const [loadedQ, loadedS, loadedPdfs] = await Promise.all([
            api.getQuestions(user),
            api.getSessions(user),
            api.getPdfs(user),
          ]);
          // Notları da yükle
          try {
            const notesRes = await fetch(`${BASE}/notes`, { headers: { Authorization: `Bearer ${token}` } });
            if (notesRes.ok) {
              const loadedNotes: SavedNote[] = await notesRes.json();
              loadedNotes.sort((a, b) => b.date - a.date);
              setSavedNotes(loadedNotes);
            }
          } catch {}
          loadedQ.sort((a: any, b: any) => (b.date || 0) - (a.date || 0));
          setSavedQuestions(loadedQ);
          loadedS.sort((a: any, b: any) => b.lastAccessed - a.lastAccessed);
          setSessions(loadedS);
          loadedPdfs.sort((a: any, b: any) => b.addedAt - a.addedAt);
          setPdfLibrary(loadedPdfs);
          const totalSize = loadedPdfs.reduce((acc: number, p: any) => acc + (p.size || 0), 0);
          setStorageUsed(totalSize);
          // Konu takip verilerini yükle
          loadTrackingData();
          // FIX: Ezber kartlarını sunucudan yükle + localforage'dan otomatik migration
          try {
            const token = await user.getIdToken();
            const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
            const memRes = await fetch(`${BASE}/memorize`, { headers: { Authorization: `Bearer ${token}` } });
            let serverMem: MemorizeCard[] = [];
            if (memRes.ok) {
              serverMem = await memRes.json();
            }
            // Migration: localforage'daki eski kartları sunucuya taşı
            const localMem = await localforage.getItem<MemorizeCard[]>(`memorize_cards_${user.uid}`);
            if (localMem && localMem.length > 0) {
              const serverIds = new Set(serverMem.map(c => c.id));
              const toMigrate = localMem.filter(c => !serverIds.has(c.id));
              if (toMigrate.length > 0) {
                console.log(`Ezber migration: ${toMigrate.length} kart sunucuya taşınıyor`);
                await Promise.all(toMigrate.map(c =>
                  fetch(`${BASE}/memorize/${c.id}`, {
                    method: 'PUT',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...c, uid: user.uid }),
                  })
                ));
                serverMem = [...toMigrate, ...serverMem];
              }
              // Migration başarılı, localforage'daki eski kopyayı güncelle
              await localforage.setItem(`memorize_cards_${user.uid}`, serverMem);
            }
            serverMem.sort((a, b) => b.createdAt - a.createdAt);
            setMemorizeCards(serverMem);
          } catch (e) {
            console.error('Memorize load error, falling back to local:', e);
            // Sunucu hatası: localforage fallback
            try {
              const mem = await localforage.getItem<MemorizeCard[]>(`memorize_cards_${user.uid}`);
              if (mem) setMemorizeCards(mem);
            } catch {}
          }

          // Detaylı depolama bilgisi al
          if (user) {
            try {
              const token = await user.getIdToken();
              const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
              const r = await fetch(`${BASE}/storage-usage`, {
                headers: { Authorization: `Bearer ${token}` }
              });
              if (r.ok) {
                const d = await r.json();
                setStorageDetails({
                  pdfBytes: d.pdfBytes || 0, pdfCount: d.pdfCount || 0,
                  imageBytes: d.imageBytes || 0, imageCount: d.imageCount || 0,
                  noteImageBytes: d.noteImageBytes || 0, noteImageCount: d.noteImageCount || 0,
                  sessionBytes: d.sessionBytes || 0, sessionCount: d.sessionCount || 0,
                  noteBytes: d.noteBytes || 0, noteCount: d.noteCount || 0,
                  questionMetaBytes: d.questionMetaBytes || 0, questionCount: d.questionCount || 0,
                  memorizeBytes: d.memorizeBytes || 0, memorizeCount: d.memorizeCount || 0,
                  drawingCount: d.drawingCount || 0, bookmarkCount: d.bookmarkCount || 0,
                  pdfMarkCount: d.pdfMarkCount || 0, readPageCount: d.readPageCount || 0,
                });
                setStorageUsed(d.bytes || totalSize);
              }
            } catch {}
          }
        } catch (error) {
          console.error("Error loading data from server:", error);
        }
        unsubscribeQuestions = () => {};
        unsubscribeSessions = () => {};
      } else {
        // Load from localforage
        const keys = await localforage.keys();
        const examKeys = keys.filter(k => k.startsWith('exam_'));
        const loadedSessions: ExamSession[] = [];
        for (const key of examKeys) {
          const session = await localforage.getItem<ExamSession>(key);
          if (session) {
            const hasPdf = await localforage.getItem(`pdf_${session.id}`);
            if (hasPdf) {
              loadedSessions.push(session);
            }
          }
        }
        loadedSessions.sort((a, b) => b.lastAccessed - a.lastAccessed);
        setSessions(loadedSessions);
        
        const savedQ = await localforage.getItem<SavedQuestion[]>('saved_questions');
        if (savedQ) { setSavedQuestions(savedQ); }

        const savedN = await localforage.getItem<SavedNote[]>('saved_notes');
        if (savedN) { setSavedNotes(savedN); }

        // FIX: Guest için ezber kartları
        try {
          const mem = await localforage.getItem<MemorizeCard[]>('memorize_cards_guest');
          if (mem) setMemorizeCards(mem);
        } catch {}
        
        const library = await localforage.getItem<PDFMetadata[]>('pdf_library') || [];
        setPdfLibrary(library);
        // FIX #9b: Guest kullanıcılar için de konu takibi yükle
        loadTrackingData();
      }
    };
    loadSessions();

    return () => {
      if (unsubscribeQuestions) unsubscribeQuestions();
      if (unsubscribeSessions) unsubscribeSessions();
    };
  }, [user]);

  const timeElapsedRef = useRef(timeElapsed);
  useEffect(() => {
    timeElapsedRef.current = timeElapsed;
  }, [timeElapsed]);

  // FIX PERFORMANS: Auto-save'i 2 saniye debounce et — her tuşa basışta fetch gitmesin
  const autoSaveTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    if (currentSessionId && mode !== 'setup') {
      // Önceki pending save'i iptal et
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
      autoSaveTimeoutRef.current = window.setTimeout(async () => {
        setIsSaving(true);
        let baseSession = sessions.find(s => s.id === currentSessionId)
          || await localforage.getItem<ExamSession>(`exam_${currentSessionId}`);

        const updatedSession: ExamSession = {
          ...(baseSession || {}),
          id: currentSessionId,
          name: baseSession?.name || selectedSubject,
          subject: selectedSubject,
          pdfId: currentPdfId || baseSession?.pdfId,
          questionCount,
          userAnswers,
          correctAnswers,
          timeElapsed: timeElapsedRef.current,
          activeQuestion,
          pdfZoom,
          mode,
          pdfMarks,
          drawings,
          bookmarks,
          lastPage: lastSavedPage,
          lastTwoPageView: twoPageView,
          maxPageViewed: Math.max(maxPageViewed, baseSession?.maxPageViewed || 0),
          totalPages: numPages || baseSession?.totalPages,
          // FIX: Okudum işaretleri — merge ile (eski + yeni)
          readPages: Array.from(new Set([...(baseSession?.readPages || []), ...Array.from(readPages)])),
          lastAccessed: Date.now()
        } as ExamSession;
        await saveExamSession(updatedSession);
        setSessions(prev => prev.map(s => s.id === currentSessionId ? updatedSession : s));
        setTimeout(() => setIsSaving(false), 500);
      }, 2000); // 2 sn debounce

      return () => {
        if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
      };
    }
  }, [currentSessionId, questionCount, userAnswers, correctAnswers, activeQuestion, pdfZoom, mode, pdfMarks, drawings, bookmarks, selectedSubject, currentPdfId, lastSavedPage, twoPageView, readPages]);

  // FIX PERFORMANS: Ref ile son değerleri sakla — interval yeniden oluşturulmasın
  const saveStateRef = useRef({
    questionCount, userAnswers, correctAnswers, activeQuestion, pdfZoom, mode,
    pdfMarks, drawings, bookmarks, selectedSubject, currentPdfId, twoPageView, maxPageViewed, numPages, readPages
  });
  useEffect(() => {
    saveStateRef.current = {
      questionCount, userAnswers, correctAnswers, activeQuestion, pdfZoom, mode,
      pdfMarks, drawings, bookmarks, selectedSubject, currentPdfId, twoPageView, maxPageViewed, numPages, readPages
    };
  }, [questionCount, userAnswers, correctAnswers, activeQuestion, pdfZoom, mode, pdfMarks, drawings, bookmarks, selectedSubject, currentPdfId, twoPageView, maxPageViewed, numPages, readPages]);

  useEffect(() => {
    if (currentSessionId && mode !== 'setup' && autoSaveInterval > 0) {
      const interval = window.setInterval(async () => {
        const s = saveStateRef.current;
        let baseSession = sessions.find(ss => ss.id === currentSessionId)
          || await localforage.getItem<ExamSession>(`exam_${currentSessionId}`);
        const updatedSession: ExamSession = {
          ...(baseSession || {}),
          id: currentSessionId,
          name: baseSession?.name || s.selectedSubject,
          subject: s.selectedSubject,
          pdfId: s.currentPdfId || baseSession?.pdfId,
          questionCount: s.questionCount,
          userAnswers: s.userAnswers,
          correctAnswers: s.correctAnswers,
          timeElapsed: timeElapsedRef.current,
          activeQuestion: s.activeQuestion,
          pdfZoom: s.pdfZoom,
          mode: s.mode,
          pdfMarks: s.pdfMarks,
          drawings: s.drawings,
          bookmarks: s.bookmarks,
          lastPage: currentScrollIndexRef.current,
          lastTwoPageView: s.twoPageView,
          maxPageViewed: Math.max(s.maxPageViewed, baseSession?.maxPageViewed || 0),
          totalPages: s.numPages || baseSession?.totalPages,
          readPages: Array.from(new Set([...(baseSession?.readPages || []), ...Array.from(s.readPages)])),
          lastAccessed: Date.now()
        } as ExamSession;
        await saveExamSession(updatedSession);
        setSessions(prev => prev.map(ss => ss.id === currentSessionId ? updatedSession : ss));
      }, autoSaveInterval * 60 * 1000);
      return () => clearInterval(interval);
    }
  }, [currentSessionId, mode, autoSaveInterval]); // MINIMAL dependency

  const toggleFullscreen = () => {
    const isNowFullscreen = !!(
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement
    );
    if (!isNowFullscreen) {
      // FIX Fullscreen mobil: iOS Safari webkit prefix gerektirir
      const el = document.documentElement as any;
      if (el.requestFullscreen) {
        el.requestFullscreen().catch((err: Error) => {
          console.error(`Fullscreen error: ${err.message}`);
        });
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    } else {
      const doc = document as any;
      if (doc.exitFullscreen) {
        doc.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      }
    }
    // Not: setIsFullscreen artık fullscreenchange event'i tarafından yönetiliyor
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handleStart = async (count: number) => {
    const finalCount = count > 0 ? count : 1;
    setQuestionCount(finalCount);
    setUserAnswers({});
    setCorrectAnswers({});
    setTimeElapsed(0);
    setActiveQuestion(1);
    setPdfMarks([]);
    setDrawings([]);
    setMode('taking');
    setIsTimerRunning(false);
    setMaxPageViewed(0); setReadPages(new Set()); // FIX: Yeni sınav

    if (!currentSessionId) {
      const newSessionId = uuidv4();
      setCurrentSessionId(newSessionId);
      
      const newSession: ExamSession = {
        id: newSessionId,
        name: `Sınav ${new Date().toLocaleDateString()}`,
        subject: selectedSubject,
        questionCount: finalCount,
        userAnswers: {},
        correctAnswers: {},
        timeElapsed: 0,
        activeQuestion: 1,
        pdfZoom: 100,
        mode: 'taking' as const,
        pdfMarks: [],
        lastAccessed: Date.now()
      };
      
      await saveExamSession(newSession);
      setSessions(prev => [newSession, ...prev]);
    } else {
      // FIX #7: Login kullanıcılar için localforage her zaman null döner,
      // sessions state'i kullan (hem login hem guest için çalışır)
      const session = sessions.find(s => s.id === currentSessionId)
        || await localforage.getItem<ExamSession>(`exam_${currentSessionId}`);
      if (session) {
        const updatedSession = {
          ...session,
          subject: selectedSubject,
          questionCount: finalCount,
          userAnswers: {},
          correctAnswers: {},
          timeElapsed: 0,
          activeQuestion: 1,
          mode: 'taking' as const,
          pdfMarks: [],
          lastAccessed: Date.now()
        };
        await saveExamSession(updatedSession);
        setSessions(prev => prev.map(s => s.id === currentSessionId ? updatedSession : s));
      }
    }
  };

  const handleFileUploadToLibrary = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !activeSubject || !activeCategory) {
      if (e.target) e.target.value = '';
      return;
    }
    for (const file of files) {
      if (user && storageUsed + file.size > STORAGE_LIMIT) {
        alert('Depolama alanı sınırına (4 GB) ulaştınız.');
        break;
      }
      const id = uuidv4();
      const metadata: PDFMetadata = {
        id, name: file.name, subject: activeSubject,
        category: activeCategory, addedAt: Date.now(),
        size: file.size, isCloud: !!user
      };
      try {
        if (user) {
          setUploadProgress(prev => ({ ...prev, [id]: { name: file.name, pct: 0 } }));
          const { url } = await api.uploadPdfWithProgress(user, id, file,
            { name: file.name, subject: activeSubject, category: activeCategory },
            (pct) => setUploadProgress(prev => ({ ...prev, [id]: { name: file.name, pct } }))
          );
          metadata.url = url.replace(/^https?:/, window.location.protocol);
          metadata.isCloud = true;
          setPdfLibrary(prev => [metadata, ...prev]);
          setStorageUsed(prev => prev + file.size);
          setUploadProgress(prev => { const n = {...prev}; delete n[id]; return n; });
        } else {
          const arrayBuffer = await file.arrayBuffer();
          await localforage.setItem(`pdf_file_${id}`, arrayBuffer);
          setPdfLibrary(prev => {
            const updated = [metadata, ...prev];
            localforage.setItem('pdf_library', updated).catch(console.error);
            return updated;
          });
        }
      } catch (error: any) {
        console.error('Error saving PDF:', error);
        alert(`${file.name} yüklenemedi: ${error.message || 'Hata'}`);
        setUploadProgress(prev => { const n = {...prev}; delete n[id]; return n; });
      }
    }
    if (e.target) e.target.value = '';
  };

  const openStoredPdf = async (metadata: PDFMetadata) => {
    try {
      let url = '';
      let file: Blob | null = null;

      if (metadata.isCloud && metadata.url) {
        // http/https protokol uyumsuzluğunu düzelt
        url = metadata.url.replace(/^https?:/, window.location.protocol);
      } else {
        const storedData = await localforage.getItem<any>(`pdf_file_${metadata.id}`);
        if (!storedData) {
          alert('PDF dosyası bulunamadı. Silinmiş olabilir.');
          return;
        }
        
        let blob: Blob;
        if (storedData instanceof Blob) {
          blob = storedData;
        } else if (storedData instanceof ArrayBuffer || storedData instanceof Uint8Array || (storedData.buffer && storedData.buffer instanceof ArrayBuffer)) {
          blob = new Blob([storedData], { type: 'application/pdf' });
        } else {
          console.error("Retrieved file is not a valid Blob or Buffer", storedData);
          alert('PDF dosyası bozuk veya okunamıyor.');
          return;
        }
        url = URL.createObjectURL(blob);
      }

      setPdfUrl(url);
      // FIX currentPdfId: PDF kütüphanesinden açılınca kesilen soruların bağlanması için
      setCurrentPdfId(metadata.id);

      // Aynı PDF için mevcut session varsa onu kullan
      // Her zaman API'den taze çek — state'e güvenme
      let existingSession = null;
      if (user) {
        try {
          const freshSessions = await api.getSessions(user);
          setSessions(freshSessions);
          // FIX session eşleşme: önce pdfId ile dene, yoksa isimle dön
          const matchingById = freshSessions.filter((s: any) => s.pdfId === metadata.id);
          const matchingByName = freshSessions.filter((s: any) => s.name === metadata.name);
          const matching = matchingById.length > 0 ? matchingById : matchingByName;
          existingSession = matching.length > 0 
            ? matching.reduce((max: any, s: any) => (s.pdfMarks?.length || 0) > (max.pdfMarks?.length || 0) ? s : max, matching[0])
            : null;
        } catch {}
      } else {
        // FIX session eşleşme guest: önce pdfId ile dene, yoksa isimle dön
        existingSession = sessions.find(s => s.pdfId === metadata.id)
          || sessions.find(s => s.name === metadata.name)
          || null;
      }
      
      if (existingSession) {
        // Mevcut session'ı devam ettir
        setCurrentSessionId(existingSession.id);
        setMode(existingSession.mode || 'taking');
        setQuestionCount(existingSession.questionCount || 120);
        setUserAnswers(existingSession.userAnswers || {});
        setCorrectAnswers(existingSession.correctAnswers || {});
        setTimeElapsed(existingSession.timeElapsed || 0);
        const existingMarks = existingSession.pdfMarks || [];
        setBookmarks(existingSession.bookmarks || []);
        // activeQuestion: session'da kayıtlı son aktif soru (öncelikli)
        const savedActiveQuestion = existingSession.activeQuestion || 1;
        setActiveQuestion(savedActiveQuestion);
        setPdfMarks(existingMarks);
        setDrawings(existingSession.drawings || []);
        setSelectedSubject(existingSession.subject || metadata.subject);
        // FIX: Tamamlanma yüzdesi için max sayfa restore
        setMaxPageViewed(existingSession.maxPageViewed || 0);
        setReadPages(new Set(existingSession.readPages || []));
        // FIX: Son sayfaya scroll — öncelik sırası:
        // 1. Kayıtlı lastPage (kullanıcının en son baktığı PDF sayfası — EN GÜVENİLİR)
        // 2. activeQuestion'ın işaretlendiği sayfa
        // 3. activeQuestion sayfa numarası (yaklaşık)
        // 4. En yüksek mark sayfası
        // 5. İlk sayfa
        let targetIndex: number;
        if (typeof existingSession.lastPage === 'number' && existingSession.lastPage >= 0) {
          // lastPage zaten Virtuoso item index'i (twoPageView dahil edilmiş)
          // Mevcut twoPageView ile kayıtlı twoPageView farklıysa dönüştür
          const savedTwoPage = existingSession.lastTwoPageView || false;
          if (savedTwoPage === twoPageView) {
            targetIndex = existingSession.lastPage;
          } else if (savedTwoPage && !twoPageView) {
            // Çift→Tek: çift sayfa index → tek sayfa index
            targetIndex = existingSession.lastPage * 2;
          } else {
            // Tek→Çift: tek sayfa index → çift sayfa index
            targetIndex = Math.floor(existingSession.lastPage / 2);
          }
          setLastSavedPage(targetIndex);
          currentScrollIndexRef.current = targetIndex;
        } else {
          const activeQMark = existingMarks.find((m: any) => m.questionNumber === savedActiveQuestion);
          let targetPage: number;
          if (activeQMark) {
            targetPage = activeQMark.page - 1;
          } else if (savedActiveQuestion > 1) {
            targetPage = savedActiveQuestion - 1;
          } else if (existingMarks.length > 0) {
            const lastMarkByPage = existingMarks.reduce(
              (max: any, m: any) => m.page > max.page ? m : max, existingMarks[0]
            );
            targetPage = lastMarkByPage.page - 1;
          } else {
            targetPage = 0;
          }
          targetIndex = twoPageView ? Math.floor(targetPage / 2) : targetPage;
        }
        setPendingReviewScroll(targetIndex);
      } else {
        // Yeni session oluştur
        const newSessionId = uuidv4();
        setCurrentSessionId(newSessionId);
        setMode('taking');
        setQuestionCount(120);
        setUserAnswers({});
        setCorrectAnswers({});
        setTimeElapsed(0);
        setActiveQuestion(1);
        setPdfMarks([]);
        setDrawings([]);
        setBookmarks([]);
        setSelectedSubject(metadata.subject);
        setMaxPageViewed(0); setReadPages(new Set()); // FIX: Yeni PDF
        
        const newSession: ExamSession = {
          id: newSessionId,
          name: metadata.name,
          // FIX session pdfId: yeni session'a pdfId kaydet — gelecekte doğru eşleşme için
          pdfId: metadata.id,
          lastAccessed: Date.now(),
          questionCount: 120,
          userAnswers: {},
          correctAnswers: {},
          timeElapsed: 0,
          activeQuestion: 1,
          pdfZoom: 100,
          mode: 'taking',
          subject: metadata.subject,
          pdfMarks: []
        };
        
        await saveExamSession(newSession);
        if (file) {
          await localforage.setItem(`pdf_${newSessionId}`, file);
        }
        setSessions(prev => [newSession, ...prev]);
      }
    } catch (error) {
      console.error('Error opening stored PDF:', error);
      alert('PDF açılırken bir hata oluştu.');
    }
  };

  const deleteStoredPdf = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm('Bu PDF dosyasını kütüphaneden kalıcı olarak silmek istediğinize emin misiniz?')) {
      const pdfToDelete = pdfLibrary.find(p => p.id === id);
      
      if (user) {
        try {
          await api.deletePdf(user, id);
          setPdfLibrary(prev => prev.filter(p => p.id !== id));
          if (pdfToDelete?.size) {
            setStorageUsed(prev => Math.max(0, prev - pdfToDelete.size));
          }
        } catch (error) {
          console.error("Error deleting PDF:", error);
          alert("PDF silinirken bir hata oluştu.");
        }
      } else {
        await localforage.removeItem(`pdf_file_${id}`);
        setPdfLibrary(prev => {
          const updated = prev.filter(p => p.id !== id);
          localforage.setItem('pdf_library', updated).catch(console.error);
          return updated;
        });
      }
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      if (pdfUrl) {
        URL.revokeObjectURL(pdfUrl);
      }
      const url = URL.createObjectURL(file);
      setPdfUrl(url);
      setPdfZoom(100);
      setPdfError(null);
      setMaxPageViewed(0); setReadPages(new Set()); // FIX: Yeni PDF

      const newSessionId = uuidv4();
      const newSession: ExamSession = {
        id: newSessionId,
        name: file.name,
        subject: selectedSubject,
        questionCount: 0,
        userAnswers: {},
        correctAnswers: {},
        timeElapsed: 0,
        activeQuestion: 1,
        pdfZoom: 100,
        mode: 'setup',
        lastAccessed: Date.now()
      };
      
      await saveExamSession(newSession);
      try {
        const arrayBuffer = await file.arrayBuffer();
        await localforage.setItem(`pdf_${newSessionId}`, arrayBuffer);
      } catch (e) {
        console.error("Error saving PDF to localforage:", e);
      }
      
      setSessions(prev => [newSession, ...prev]);
      setCurrentSessionId(newSessionId);
    }
    if (e.target) e.target.value = '';
  };

  const resumeSession = async (session: ExamSession) => {
    setCurrentSessionId(session.id);
    setQuestionCount(session.questionCount);
    setCustomCount(session.questionCount > 0 ? session.questionCount.toString() : '');
    setSelectedSubject(session.subject || 'Genel');
    setUserAnswers(session.userAnswers || {});
    setCorrectAnswers(session.correctAnswers || {});
    setTimeElapsed(session.timeElapsed || 0);
    const savedAQ = session.activeQuestion || 1;
    setActiveQuestion(savedAQ);
    // FIX: Son sayfaya scroll — lastPage öncelikli (kullanıcının en son baktığı sayfa)
    let targetIndex: number;
    if (typeof session.lastPage === 'number' && session.lastPage >= 0) {
      const savedTwoPage = session.lastTwoPageView || false;
      if (savedTwoPage === twoPageView) {
        targetIndex = session.lastPage;
      } else if (savedTwoPage && !twoPageView) {
        targetIndex = session.lastPage * 2;
      } else {
        targetIndex = Math.floor(session.lastPage / 2);
      }
      setLastSavedPage(targetIndex);
      currentScrollIndexRef.current = targetIndex;
      setPendingReviewScroll(targetIndex);
    } else if (savedAQ > 1) {
      targetIndex = twoPageView
        ? Math.floor((savedAQ - 1) / 2)
        : savedAQ - 1;
      setPendingReviewScroll(targetIndex);
    }
    setPdfZoom(session.pdfZoom || 100);
    setPdfMarks(session.pdfMarks || []);
    setDrawings(session.drawings || []);
    // FIX resumeSession: bookmarks hiç restore edilmiyordu
    setBookmarks(session.bookmarks || []);
    // FIX: Tamamlanma yüzdesi için max sayfa restore
    setMaxPageViewed(session.maxPageViewed || 0);
    setReadPages(new Set(session.readPages || []));
    setMode(session.mode || 'taking');
    
    if (session.mode === 'taking') {
      setIsTimerRunning(false);
    } else {
      setIsTimerRunning(false);
    }

    const file = await localforage.getItem<any>(`pdf_${session.id}`);
    if (file) {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      
      let blob: Blob;
      if (file instanceof Blob) {
        blob = file;
      } else if (file instanceof ArrayBuffer || file instanceof Uint8Array || (file.buffer && file.buffer instanceof ArrayBuffer)) {
        blob = new Blob([file], { type: 'application/pdf' });
      } else {
        console.error("Retrieved file is not a valid Blob or Buffer", file);
        setPdfError("PDF dosyası depolamadan okunamadı. Lütfen dosyayı tekrar yükleyin.");
        return;
      }
      
      try {
        const url = URL.createObjectURL(blob);
        setPdfUrl(url);
        // FIX currentPdfId: resumeSession'da da set et
        if (session.pdfId) setCurrentPdfId(session.pdfId);
        setPdfError(null);
      } catch (err) {
        console.error("Error creating object URL:", err);
        setPdfError("PDF dosyası görüntülenemiyor. Tarayıcı desteklemiyor olabilir.");
      }
    } else {
      // Check if it's a cloud PDF
      const metadata = pdfLibrary.find(p => p.id === session.pdfId);
      if (metadata && metadata.isCloud && metadata.url) {
        setPdfUrl(metadata.url.replace(/^https?:/, window.location.protocol));
        // FIX currentPdfId: cloud PDF için de set et
        setCurrentPdfId(metadata.id);
        setPdfError(null);
      } else {
        setPdfUrl(null);
      }
    }
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmModal({
      isOpen: true,
      message: 'Bu oturumu silmek istediğinize emin misiniz?',
      onConfirm: async () => {
        await deleteExamSession(id);
        await localforage.removeItem(`pdf_${id}`);
        setSessions(prev => prev.filter(s => s.id !== id));
        if (currentSessionId === id) {
          setCurrentSessionId(null);
          setPdfUrl(null);
          setMode('setup');
        }
      }
    });
  };

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (pdfUrl) {
        URL.revokeObjectURL(pdfUrl);
      }
    };
  }, [pdfUrl]);

  const handleAnswerSelect = (qNum: number, option: string) => {
    setActiveQuestion(qNum);
    setUserAnswers((prev) => {
      // Toggle off if clicking the same option
      if (prev[qNum] === option) {
        const newAnswers = { ...prev };
        delete newAnswers[qNum];
        return newAnswers;
      }
      return { ...prev, [qNum]: option };
    });
  };

  const handleZoomIn = () => {
    setPdfZoom(z => {
      const next = ZOOM_STEPS.find(step => step > z);
      return next || z;
    });
  };

  const handleZoomOut = () => {
    setPdfZoom(z => {
      const prev = [...ZOOM_STEPS].reverse().find(step => step < z);
      return prev || z;
    });
  };

  const handleHighlightStart = (e: React.PointerEvent<HTMLDivElement>, page: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setHighlightState({ page, points: [{x, y}] });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleHighlightMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!highlightState) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setHighlightState(prev => prev ? { ...prev, points: [...prev.points, {x, y}] } : null);
  };

  const handleHighlightEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!highlightState) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    
    if (highlightState.points.length > 1) {
      const newMark = {
        id: uuidv4(),
        page: highlightState.page,
        x: highlightState.points[0].x,
        y: highlightState.points[0].y,
        points: highlightState.points,
        color: 'yellow' as const,
        questionNumber: activeQuestion
      };
      setPdfMarks(prev => [...prev, newMark]);
    }
    
    setHighlightState(null);
  };

  const handleCropStart = (e: React.PointerEvent<HTMLDivElement>, page: number) => {
    if (readOnlyLock) return; // FIX: okuma kilidi
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setCropState({ page, startX: x, startY: y, currentX: x, currentY: y });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleCropMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cropState) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setCropState(prev => prev ? { ...prev, currentX: x, currentY: y } : null);
  };

  const handleCropEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cropState) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    
    const left = Math.min(cropState.startX, cropState.currentX);
    const top = Math.min(cropState.startY, cropState.currentY);
    const width = Math.abs(cropState.currentX - cropState.startX);
    const height = Math.abs(cropState.currentY - cropState.startY);
    
    if (width < 2 || height < 2) {
      setCropState(null);
      return;
    }

    const pageEl = document.querySelector(`.react-pdf__Page[data-page-number="${cropState.page}"]`);
    const canvas = pageEl?.querySelector('canvas');
    
    if (canvas) {
      const tempCanvas = document.createElement('canvas');
      const ctx = tempCanvas.getContext('2d');
      
      const pxLeft = (left / 100) * canvas.width;
      const pxTop = (top / 100) * canvas.height;
      const pxWidth = (width / 100) * canvas.width;
      const pxHeight = (height / 100) * canvas.height;
      
      tempCanvas.width = pxWidth;
      tempCanvas.height = pxHeight;
      
      if (ctx) {
        ctx.drawImage(canvas, pxLeft, pxTop, pxWidth, pxHeight, 0, 0, pxWidth, pxHeight);
        
        const pageMarks: any[] = []; // İşaretler fotoğrafa dahil edilmiyor
        const scale = canvas.width / (pageEl?.clientWidth || canvas.width);
        
        pageMarks.forEach(mark => {
          const markPxX = (mark.x / 100) * canvas.width;
          const markPxY = (mark.y / 100) * canvas.height;
          
          if (mark.color === 'yellow') {
            if (mark.points) {
              // Check if any point is inside the crop area
              const intersects = mark.points.some(p => {
                const pxX = (p.x / 100) * canvas.width;
                const pxY = (p.y / 100) * canvas.height;
                return pxX >= pxLeft && pxX <= pxLeft + pxWidth && pxY >= pxTop && pxY <= pxTop + pxHeight;
              });

              if (intersects) {
                ctx.beginPath();
                mark.points.forEach((p, i) => {
                  const pxX = (p.x / 100) * canvas.width;
                  const pxY = (p.y / 100) * canvas.height;
                  const drawX = pxX - pxLeft;
                  const drawY = pxY - pxTop;
                  if (i === 0) ctx.moveTo(drawX, drawY);
                  else ctx.lineTo(drawX, drawY);
                });
                ctx.strokeStyle = 'rgba(253, 224, 71, 0.5)';
                ctx.lineWidth = canvas.width * 0.015; // 1.5% of width
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.stroke();
              }
            } else if (mark.width && mark.height) {
              const markPxWidth = (mark.width / 100) * canvas.width;
              const markPxHeight = (mark.height / 100) * canvas.height;
              
              // Check if highlight intersects with crop area
              if (markPxX < pxLeft + pxWidth && markPxX + markPxWidth > pxLeft &&
                  markPxY < pxTop + pxHeight && markPxY + markPxHeight > pxTop) {
                
                const drawX = Math.max(0, markPxX - pxLeft);
                const drawY = Math.max(0, markPxY - pxTop);
                const drawWidth = Math.min(pxWidth - drawX, markPxWidth - (pxLeft > markPxX ? pxLeft - markPxX : 0));
                const drawHeight = Math.min(pxHeight - drawY, markPxHeight - (pxTop > markPxY ? pxTop - markPxY : 0));
                
                ctx.fillStyle = 'rgba(253, 224, 71, 0.4)'; // yellow-300 with opacity
                ctx.fillRect(drawX, drawY, drawWidth, drawHeight);
              }
            }
          } else {
            if (markPxX >= pxLeft && markPxX <= pxLeft + pxWidth &&
                markPxY >= pxTop && markPxY <= pxTop + pxHeight) {
              
              const drawX = markPxX - pxLeft;
              const drawY = markPxY - pxTop;
              
              if (mark.markType === 'cross') {
                ctx.beginPath();
                const size = 8 * scale;
                ctx.moveTo(drawX - size, drawY - size);
                ctx.lineTo(drawX + size, drawY + size);
                ctx.moveTo(drawX + size, drawY - size);
                ctx.lineTo(drawX - size, drawY + size);
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)'; // red-500
                ctx.lineWidth = 4 * scale;
                ctx.lineCap = 'round';
                ctx.stroke();
              } else if (mark.markType === 'tick') {
                ctx.beginPath();
                const size = 8 * scale;
                ctx.moveTo(drawX - size, drawY);
                ctx.lineTo(drawX - size/3, drawY + size);
                ctx.lineTo(drawX + size, drawY - size);
                ctx.strokeStyle = 'rgba(16, 185, 129, 0.9)'; // emerald-500
                ctx.lineWidth = 4 * scale;
                ctx.lineCap = 'round';
                ctx.stroke();
              } else {
                ctx.beginPath();
                ctx.arc(drawX, drawY, 6 * scale, 0, 2 * Math.PI);
                ctx.fillStyle = mark.color === 'green' ? 'rgba(16, 185, 129, 0.8)' : 'rgba(239, 68, 68, 0.8)';
                ctx.fill();
                ctx.lineWidth = 2 * scale;
                ctx.strokeStyle = 'white';
                ctx.stroke();
              }
            }
          }
        });
      }
      
      const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.9);
      setCropImage(dataUrl);
      // Paylaşım için File'ı önceden hazırla
      try {
        const base64 = dataUrl.split(',')[1];
        const mime = dataUrl.split(';')[0].split(':')[1] || 'image/jpeg';
        const binary = atob(base64);
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        const blob = new Blob([arr], { type: mime });
        shareFileRef.current = new File([blob], 'soru.jpg', { type: mime });
      } catch {}
      setCropSubject(activeSubject || selectedSubject || SUBJECTS[0]);
      // Mevcut dersin son konusunu otomatik seç
      setCropTopic(lastTopicBySubject[cropSubject] || '');
      setShowCropModal(true);
    } else {
      setCropState(null);
    }
    
    setIsCropMode(false);
  };

  // ── NOT KES handlers ──────────────────────────────────────────────────────
  const handleNoteCropStart = (e: React.PointerEvent<HTMLDivElement>, page: number) => {
    if (readOnlyLock) return; // FIX: okuma kilidi
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setNoteCropState({ page, startX: x, startY: y, currentX: x, currentY: y });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleNoteCropMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!noteCropState) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setNoteCropState(prev => prev ? { ...prev, currentX: x, currentY: y } : null);
  };

  const handleNoteCropEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!noteCropState) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const left   = Math.min(noteCropState.startX, noteCropState.currentX);
    const top    = Math.min(noteCropState.startY, noteCropState.currentY);
    const width  = Math.abs(noteCropState.currentX - noteCropState.startX);
    const height = Math.abs(noteCropState.currentY - noteCropState.startY);
    if (width < 2 || height < 2) { setNoteCropState(null); return; }
    const pageEl = document.querySelector(`.react-pdf__Page[data-page-number="${noteCropState.page}"]`);
    const canvas = pageEl?.querySelector('canvas');
    if (canvas) {
      const tempCanvas = document.createElement('canvas');
      const ctx = tempCanvas.getContext('2d');
      const pxLeft   = (left   / 100) * canvas.width;
      const pxTop    = (top    / 100) * canvas.height;
      const pxWidth  = (width  / 100) * canvas.width;
      const pxHeight = (height / 100) * canvas.height;
      tempCanvas.width  = pxWidth;
      tempCanvas.height = pxHeight;
      if (ctx) {
        ctx.drawImage(canvas, pxLeft, pxTop, pxWidth, pxHeight, 0, 0, pxWidth, pxHeight);
        ctx.strokeStyle = 'rgba(34,197,94,0.85)';
        ctx.lineWidth   = Math.max(3, pxWidth * 0.008);
        ctx.setLineDash([pxWidth * 0.04, pxWidth * 0.02]);
        ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, pxWidth - ctx.lineWidth, pxHeight - ctx.lineWidth);
        ctx.setLineDash([]);
      }
      const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.92);
      setNoteImage(dataUrl);
      setNoteCropPage(noteCropState.page);
      setNoteCropRect({ x: left, y: top, width, height });
      setNoteCropSubject(activeSubject || selectedSubject || SUBJECTS[0]);
      setNoteCropTopic(lastTopicBySubject[noteCropSubject] || '');
      setNoteCropTitle('');
      setNoteCropCategory('onemli'); // FIX: varsayılan kategori
      setShowNoteModal(true);
    }
    setNoteCropState(null);
    setIsNoteCropMode(false);
  };

  const saveNote = async (note: SavedNote) => {
    if (user) {
      try {
        let noteToSave: any = { ...note, uid: user.uid };

        // 1. Önce görseli sunucuya yükle
        if (note.image && note.image.startsWith('data:')) {
          const token = await user.getIdToken();
          const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
          const r = await fetch(`${BASE}/notes/image`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: note.id, image: note.image }),
          });
          if (r.ok) {
            const { url, imageFile } = await r.json();
            noteToSave.image = url.replace(/^https?:/, window.location.protocol);
            noteToSave.imageFile = imageFile;
          } else {
            const errText = await r.text();
            alert(`❌ Görsel yüklenemedi (${r.status}): ${errText}`);
            return; // Hata varsa kaydetme
          }
        }

        // 2. Metadata'yı kaydet
        const token = await user.getIdToken();
        const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
        const res = await fetch(`${BASE}/notes/${note.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(noteToSave),
        });

        if (res.ok) {
          // 3. Sunucu başarılıysa state'e ekle
          setSavedNotes(prev => [{ ...note, image: noteToSave.image }, ...prev]);
          // Başarı bildirimi — 2 saniye görünür
          setConfirmModal({
            isOpen: true,
            message: '✅ Not sunucuya kaydedildi!',
            onConfirm: () => setConfirmModal(null),
          });
          setTimeout(() => setConfirmModal(null), 2000);
        } else {
          const errText = await res.text();
          alert(`❌ Not kaydedilemedi (${res.status}): ${errText}`);
        }

      } catch (err: any) {
        alert(`❌ Bağlantı hatası: ${err?.message || err}`);
      }
    } else {
      // Guest: localforage'a kaydet
      const all = [note, ...savedNotes];
      setSavedNotes(all);
      await localforage.setItem('saved_notes', all);
    }
  };

  // Notu güncelle (nextReviewDate, reviewCount gibi alanlar için)
  const updateNote = async (updated: SavedNote) => {
    setSavedNotes(prev => prev.map(n => n.id === updated.id ? updated : n));
    if (user) {
      try {
        const token = await user.getIdToken();
        const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
        await fetch(`${BASE}/notes/${updated.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...updated, uid: user.uid }),
        });
      } catch (err) { console.error('updateNote error:', err); }
    } else {
      const all = savedNotes.map(n => n.id === updated.id ? updated : n);
      await localforage.setItem('saved_notes', all);
    }
  };

  const deleteNote = async (id: string) => {
    setSavedNotes(prev => prev.filter(n => n.id !== id));
    if (user) {
      try {
        const token = await user.getIdToken();
        const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
        await fetch(`${BASE}/notes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      } catch (err) { console.error('deleteNote error:', err); }
    } else {
      await localforage.setItem('saved_notes', savedNotes.filter(n => n.id !== id));
    }
  };

  // FIX: Ezber kartları persistence — sunucuya kayıt (login) veya localforage (guest)
  const saveMemorizeCards = async (cards: MemorizeCard[]) => {
    const key = user ? `memorize_cards_${user.uid}` : 'memorize_cards_guest';
    await localforage.setItem(key, cards); // Her zaman local cache
  };

  const addMemorizeCard = async (card: MemorizeCard) => {
    const updated = [card, ...memorizeCards];
    setMemorizeCards(updated);
    await saveMemorizeCards(updated);
    // Sunucuya gönder
    if (user) {
      try {
        const token = await user.getIdToken();
        const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
        await fetch(`${BASE}/memorize/${card.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...card, uid: user.uid }),
        });
      } catch (err) { console.error('addMemorizeCard server error:', err); }
    }
  };

  const addMemorizeCardsBulk = async (cards: MemorizeCard[]) => {
    const updated = [...cards, ...memorizeCards];
    setMemorizeCards(updated);
    await saveMemorizeCards(updated);
    if (user) {
      try {
        const token = await user.getIdToken();
        const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
        // Toplu — her biri için ayrı PUT (server tarafı zaten upsert)
        await Promise.all(cards.map(c =>
          fetch(`${BASE}/memorize/${c.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...c, uid: user.uid }),
          })
        ));
      } catch (err) { console.error('addMemorizeCardsBulk server error:', err); }
    }
  };

  const updateMemorizeCard = async (card: MemorizeCard) => {
    const updated = memorizeCards.map(c => c.id === card.id ? card : c);
    setMemorizeCards(updated);
    await saveMemorizeCards(updated);
    if (user) {
      try {
        const token = await user.getIdToken();
        const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
        await fetch(`${BASE}/memorize/${card.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...card, uid: user.uid }),
        });
      } catch (err) { console.error('updateMemorizeCard server error:', err); }
    }
  };

  const deleteMemorizeCard = async (id: string) => {
    const updated = memorizeCards.filter(c => c.id !== id);
    setMemorizeCards(updated);
    await saveMemorizeCards(updated);
    if (user) {
      try {
        const token = await user.getIdToken();
        const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
        await fetch(`${BASE}/memorize/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) { console.error('deleteMemorizeCard server error:', err); }
    }
  };

  // Ezber kartları için SM-2 (notlarla aynı mantık)
  const scheduleMemorizeCardSM2 = async (card: MemorizeCard, quality: 0 | 1 | 2 | 3) => {
    const oldEase = card.easeFactor ?? 2.5;
    const oldInterval = card.intervalDays ?? 0;
    const oldReviews = card.reviewCount ?? 0;
    let newEase = oldEase;
    let newInterval: number;
    let newLapses = card.lapses ?? 0;

    if (quality === 0) {
      newInterval = 1;
      newLapses += 1;
      newEase = Math.max(1.3, oldEase - 0.2);
    } else {
      const q = quality + 2;
      newEase = Math.max(1.3, oldEase + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
      if (oldReviews === 0) newInterval = 1;
      else if (oldReviews === 1) newInterval = quality === 1 ? 2 : (quality === 3 ? 4 : 3);
      else {
        const qMultiplier = quality === 1 ? 0.8 : (quality === 3 ? 1.3 : 1.0);
        newInterval = Math.round(oldInterval * newEase * qMultiplier);
        newInterval = Math.max(1, Math.min(newInterval, 180));
      }
    }

    const nextDate = new Date();
    nextDate.setHours(0, 0, 0, 0);
    nextDate.setDate(nextDate.getDate() + newInterval);

    const updated: MemorizeCard = {
      ...card,
      nextReviewDate: nextDate.getTime(),
      reviewCount: oldReviews + 1,
      easeFactor: Number(newEase.toFixed(2)),
      intervalDays: newInterval,
      lapses: newLapses,
      lastReviewedAt: Date.now(),
    };
    await updateMemorizeCard(updated);
    return newInterval;
  };

  const getMemorizeCardStage = (card: MemorizeCard): { label: string; color: string; emoji: string } => {
    const reviews = card.reviewCount ?? 0;
    const interval = card.intervalDays ?? 0;
    const lapses = card.lapses ?? 0;
    if (reviews === 0) return { label: 'Yeni', color: 'text-sky-400 bg-sky-900/30 border-sky-700/50', emoji: '🌱' };
    if (reviews <= 2 || interval < 3) return { label: 'Öğreniliyor', color: 'text-amber-400 bg-amber-900/30 border-amber-700/50', emoji: '📖' };
    if (lapses > 2 && reviews < 5) return { label: 'Zorlanıyor', color: 'text-rose-400 bg-rose-900/30 border-rose-700/50', emoji: '⚠️' };
    if (interval < 14) return { label: 'Pekiştiriliyor', color: 'text-emerald-400 bg-emerald-900/30 border-emerald-700/50', emoji: '🌿' };
    if (interval < 45) return { label: 'Öğrenildi', color: 'text-green-400 bg-green-900/30 border-green-700/50', emoji: '🌳' };
    return { label: 'Kalıcı', color: 'text-violet-400 bg-violet-900/30 border-violet-700/50', emoji: '🏆' };
  };

  const todayMemorizeCards = memorizeCards.filter(c => {
    if (!c.nextReviewDate) return true; // Yeni kartlar bugün tekrar edilebilir
    const ds = new Date(); ds.setHours(0,0,0,0);
    return c.nextReviewDate <= ds.getTime() + 86400000 - 1;
  });

  const startMemorizeReview = (cards: MemorizeCard[]) => {
    const shuffled = [...cards].sort(() => Math.random() - 0.5);
    setMemorizeReviewCards(shuffled);
    setMemorizeReviewIndex(0);
    setMemorizeReviewShowBack(false);
    setMemorizeReviewDone(new Set());
  };

  // ═══════════════════════════════════════════════════════════════════════
  // ⚡ KPSS USTASI — Bilimsel Soru Tekrar Sistemi (SM-2 + Oyunlaştırma)
  // ═══════════════════════════════════════════════════════════════════════

  const XP_LEVELS = [0, 50, 150, 350, 700, 1200, 2000, 3200, 5000, 7500, 11000, 16000, 23000, 33000, 50000];
  const getLevelFromXP = (xp: number): number => {
    for (let i = XP_LEVELS.length - 1; i >= 0; i--) {
      if (xp >= XP_LEVELS[i]) return i + 1;
    }
    return 1;
  };
  const getXPForNextLevel = (level: number): number => {
    return XP_LEVELS[Math.min(level, XP_LEVELS.length - 1)] || 999999;
  };
  const getStageEmoji = (stage?: string) => ({
    'new': '🌱', 'learning': '📖', 'review': '🌿', 'mature': '🌳', 'mastered': '🏆'
  })[stage || 'new'] || '🌱';
  const getStageLabel = (stage?: string) => ({
    'new': 'Yeni', 'learning': 'Öğreniliyor', 'review': 'Pekiştiriliyor', 'mature': 'Öğrenildi', 'mastered': 'Kalıcı'
  })[stage || 'new'] || 'Yeni';

  const ACHIEVEMENTS: { id: string; name: string; emoji: string; check: (stats: QuestionReviewStats, questions: SavedQuestion[]) => boolean }[] = [
    { id: 'first_10', name: 'İlk Adım', emoji: '🎯', check: (s) => s.totalReviews >= 10 },
    { id: 'first_100', name: 'Yüzlük Klübü', emoji: '💯', check: (s) => s.totalReviews >= 100 },
    { id: 'streak_7', name: 'Haftalık Seri', emoji: '🔥', check: (s) => s.dailyStreak >= 7 },
    { id: 'streak_30', name: 'Aylık Seri', emoji: '⚡', check: (s) => s.dailyStreak >= 30 },
    { id: 'mastered_10', name: 'Kalıcı Öğrenme', emoji: '🏆', check: (_s, qs) => qs.filter(q => q.srsStage === 'mastered').length >= 10 },
    { id: 'mastered_50', name: 'Bilge', emoji: '🧠', check: (_s, qs) => qs.filter(q => q.srsStage === 'mastered').length >= 50 },
    { id: 'accuracy_90', name: 'Usta Nişancı', emoji: '🎯', check: (s) => s.totalReviews >= 50 && (s.correctReviews / s.totalReviews) >= 0.9 },
    { id: 'level_5', name: 'Seviye 5', emoji: '⭐', check: (s) => s.level >= 5 },
    { id: 'level_10', name: 'Seviye 10', emoji: '🌟', check: (s) => s.level >= 10 },
    { id: 'tarih_master', name: 'Tarih Ustası', emoji: '📜', check: (_s, qs) => qs.filter(q => q.subject === 'Tarih' && q.srsStage === 'mastered').length >= 30 },
    { id: 'cografya_master', name: 'Coğrafya Ustası', emoji: '🗺️', check: (_s, qs) => qs.filter(q => q.subject === 'Coğrafya' && q.srsStage === 'mastered').length >= 30 },
    { id: 'matematik_master', name: 'Matematik Ustası', emoji: '🧮', check: (_s, qs) => qs.filter(q => q.subject === 'Matematik' && q.srsStage === 'mastered').length >= 30 },
  ];

  // Review stats'ı localforage'dan yükle
  useEffect(() => {
    (async () => {
      const s = await localforage.getItem<QuestionReviewStats>('question_review_stats');
      if (s) setReviewStats(s);
    })();
  }, []);

  // Stats'ı kaydet
  const persistReviewStats = async (updated: QuestionReviewStats) => {
    await localforage.setItem('question_review_stats', updated);
    setReviewStats(updated);
  };

  // SM-2 algoritması — ease factor, interval, next review hesapla
  // quality: 0 = Bilmiyordum, 2 = Zor, 3 = Rahat, 5 = Kolay (Anki standardı)
  const scheduleQuestionSM2 = (q: SavedQuestion, quality: 0 | 2 | 3 | 5): SavedQuestion => {
    const now = Date.now();
    const DAY = 86400000;
    let ef = q.srsEaseFactor ?? 2.5;
    let interval = q.srsIntervalDays ?? 0;
    let reviewCount = (q.srsReviewCount ?? 0) + 1;
    let lapses = q.srsLapses ?? 0;
    let correctStreak = q.srsCorrectStreak ?? 0;
    let wrongStreak = q.srsWrongStreak ?? 0;

    if (quality === 0) {
      // Bilmiyordum — sıfırdan başla, 10dk sonra aynı oturumda, sonra 1 gün
      lapses += 1;
      interval = 0; // Aynı oturumda tekrar
      ef = Math.max(1.3, ef - 0.2);
      correctStreak = 0;
      wrongStreak += 1;
    } else {
      correctStreak += 1;
      wrongStreak = 0;
      if (quality === 2) {
        // Zor bildim
        interval = interval === 0 ? 1 : Math.max(1, Math.ceil(interval * 1.2));
        ef = Math.max(1.3, ef - 0.15);
      } else if (quality === 3) {
        // Rahat bildim (standart)
        if (interval === 0) interval = 1;
        else if (interval === 1) interval = 3;
        else interval = Math.ceil(interval * ef);
      } else if (quality === 5) {
        // Çok kolay
        if (interval === 0) interval = 2;
        else if (interval === 1) interval = 4;
        else interval = Math.ceil(interval * ef * 1.3);
        ef = Math.min(3.0, ef + 0.15);
      }
    }

    // Stage (aşama) belirle
    let stage: SavedQuestion['srsStage'] = 'new';
    if (lapses > 0 && correctStreak < 2) stage = 'learning';
    else if (interval < 7) stage = 'learning';
    else if (interval < 21) stage = 'review';
    else if (interval < 90) stage = 'mature';
    else stage = 'mastered';

    // Otomatik zorluk ayarı
    let newDifficulty = q.difficulty;
    if (wrongStreak >= 2) newDifficulty = 'Zor';
    else if (correctStreak >= 5) newDifficulty = 'Kolay';

    return {
      ...q,
      srsEaseFactor: ef,
      srsIntervalDays: interval,
      srsReviewCount: reviewCount,
      srsLapses: lapses,
      srsLastReviewedAt: now,
      srsNextReview: interval === 0 ? now + 600000 : now + (interval * DAY), // 10dk veya gün
      srsStage: stage,
      srsCorrectStreak: correctStreak,
      srsWrongStreak: wrongStreak,
      difficulty: newDifficulty,
    };
  };

  // Günlük görev — zamanı gelen sorular + yeni sorular
  const getUstasiQueue = (): SavedQuestion[] => {
    const now = Date.now();
    const pool = savedQuestions.filter(q =>
      q.correctAnswer &&
      (ustasiFilterSubject === '__all__' || q.subject === ustasiFilterSubject)
    );

    // Zamanı gelmiş sorular (review due)
    const dueQuestions = pool.filter(q => {
      if (!q.srsNextReview) return false;
      return q.srsNextReview <= now;
    });

    // Yeni sorular
    const newQuestions = pool.filter(q => !q.srsReviewCount);

    // ── ADAPTIF: Sınav yaklaştıkça hata günlüğü ekstra ekle ──
    // kritik (<30 gün): tüm hatalı sorular her oturumda tekrar
    // yogun (<60 gün): %50'si tekrar
    // orta (<100 gün): %30'u
    // normal (>=100 gün): standart SM-2
    const intensity = examIntensity();
    const errorPool = pool.filter(q =>
      (q.srsLapses || 0) > 0 &&
      // Çift eklememek için sadece due olmayanları al
      !dueQuestions.find(d => d.id === q.id)
    );
    let extraErrors: SavedQuestion[] = [];
    if (intensity === 'kritik') {
      extraErrors = [...errorPool];
    } else if (intensity === 'yogun') {
      extraErrors = errorPool.filter(() => Math.random() < 0.5);
    } else if (intensity === 'orta') {
      extraErrors = errorPool.filter(() => Math.random() < 0.3);
    }

    // Yeni soru limiti — sınav yaklaştıkça yeni daha az, tekrar daha çok
    let maxNew = ustasiMaxNew;
    if (intensity === 'kritik') maxNew = Math.max(5, Math.floor(ustasiMaxNew / 3));
    else if (intensity === 'yogun') maxNew = Math.max(8, Math.floor(ustasiMaxNew / 2));

    const newToAdd = newQuestions.slice(0, maxNew);

    const shuffledDue = [...dueQuestions].sort(() => Math.random() - 0.5);
    const shuffledExtra = [...extraErrors].sort(() => Math.random() - 0.5);
    const shuffledNew = [...newToAdd].sort(() => Math.random() - 0.5);

    return [...shuffledDue, ...shuffledExtra, ...shuffledNew];
  };

  const startUstasi = () => {
    const queue = getUstasiQueue();
    if (queue.length === 0) {
      alert('🎉 Bugün için çalışılacak soru yok! Ya hepsini bitirdin ya da yeni soru eklemen lazım. Filtreyi "Tümü" yap veya yeni sorular çöz.');
      return;
    }
    setUstasiQueue(queue);
    setUstasiIndex(0);
    setUstasiSelectedAnswer(null);
    setUstasiShowResult(false);
    setUstasiSessionStats({ correct: 0, wrong: 0, xpGained: 0, startTime: Date.now(), relapseQueue: [] });
    setMode('ustasi');
  };

  // Cevap seç
  const ustasiSelectAnswer = (answer: string) => {
    if (ustasiShowResult) return;
    setUstasiSelectedAnswer(answer);
    setUstasiShowResult(true);
  };

  // SM-2 quality buton
  const ustasiGrade = async (quality: 0 | 2 | 3 | 5) => {
    const q = ustasiQueue[ustasiIndex];
    if (!q) return;
    const isCorrect = ustasiSelectedAnswer === q.correctAnswer;

    // SM-2 güncellemesi
    const updated = scheduleQuestionSM2(q, quality);

    // Local state güncelle
    setSavedQuestions(prev => prev.map(sq => sq.id === q.id ? updated : sq));

    // Sunucuya gönder
    if (user) {
      try {
        await api.saveQuestion(user, { ...updated, uid: user.uid });
      } catch (e) {
        console.error('SM-2 save failed:', e);
      }
    } else {
      const all = savedQuestions.map(sq => sq.id === q.id ? updated : sq);
      await localforage.setItem('saved_questions', all);
    }

    // XP hesapla
    const xpMap = { 0: 0, 2: 5, 3: 10, 5: 15 };
    let xp = xpMap[quality];
    // Zorluk bonusu
    if (q.difficulty === 'Zor') xp = Math.floor(xp * 1.5);
    else if (q.difficulty === 'Kolay') xp = Math.floor(xp * 0.8);
    // Doğruluk bonusu
    if (isCorrect && quality >= 3) xp += 5;

    // Relapse queue — bilmediğim soru 10dk sonra yine gelsin (aynı oturumda)
    let newRelapseQueue = [...ustasiSessionStats.relapseQueue];
    if (quality === 0) {
      newRelapseQueue.push(updated);
    }

    // Session stats
    const newSessionStats = {
      ...ustasiSessionStats,
      correct: ustasiSessionStats.correct + (isCorrect ? 1 : 0),
      wrong: ustasiSessionStats.wrong + (isCorrect ? 0 : 1),
      xpGained: ustasiSessionStats.xpGained + xp,
      relapseQueue: newRelapseQueue,
    };
    setUstasiSessionStats(newSessionStats);

    // Global stats güncelle
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    let newStreak = reviewStats.dailyStreak;
    if (reviewStats.lastStudyDate !== today) {
      if (reviewStats.lastStudyDate === yesterday) newStreak += 1;
      else if (reviewStats.lastStudyDate === '') newStreak = 1;
      else newStreak = 1; // Seri kopmuş
    }

    // Haftalık istatistik
    const week = [...reviewStats.weeklyHistory];
    const todayEntry = week.find(w => w.date === today);
    if (todayEntry) {
      todayEntry.reviewed += 1;
      if (isCorrect) todayEntry.correct += 1;
    } else {
      week.push({ date: today, reviewed: 1, correct: isCorrect ? 1 : 0 });
    }
    // Sadece son 14 gün
    const weekFiltered = week.filter(w => {
      const diff = (Date.now() - new Date(w.date).getTime()) / 86400000;
      return diff < 14;
    });

    const newTotalXP = reviewStats.totalXP + xp;
    const newLevel = getLevelFromXP(newTotalXP);
    const leveledUp = newLevel > reviewStats.level;

    const newStats: QuestionReviewStats = {
      totalXP: newTotalXP,
      level: newLevel,
      dailyStreak: newStreak,
      lastStudyDate: today,
      totalReviews: reviewStats.totalReviews + 1,
      correctReviews: reviewStats.correctReviews + (isCorrect ? 1 : 0),
      achievements: reviewStats.achievements,
      weeklyHistory: weekFiltered,
    };

    // Başarım kontrolü
    const updatedQuestions = savedQuestions.map(sq => sq.id === q.id ? updated : sq);
    const newAchievements: string[] = [];
    for (const a of ACHIEVEMENTS) {
      if (!newStats.achievements.includes(a.id) && a.check(newStats, updatedQuestions)) {
        newAchievements.push(a.id);
      }
    }
    if (newAchievements.length > 0) {
      newStats.achievements = [...newStats.achievements, ...newAchievements];
      const first = ACHIEVEMENTS.find(a => a.id === newAchievements[0]);
      if (first) {
        setUstasiAchievementToast(`${first.emoji} ${first.name} kazanıldı!`);
        setTimeout(() => setUstasiAchievementToast(null), 3500);
      }
    }
    if (leveledUp) {
      setUstasiAchievementToast(`🎉 Seviye ${newLevel}'e yükseldin!`);
      setTimeout(() => setUstasiAchievementToast(null), 3500);
    }

    await persistReviewStats(newStats);

    // Sonraki soruya geç
    setTimeout(() => {
      setUstasiSelectedAnswer(null);
      setUstasiShowResult(false);

      // Oturumda soru kalmadıysa relapse queue'dan devam et
      if (ustasiIndex + 1 >= ustasiQueue.length) {
        if (newRelapseQueue.length > 0) {
          setUstasiQueue(newRelapseQueue);
          setUstasiIndex(0);
          setUstasiSessionStats(prev => ({ ...prev, relapseQueue: [] }));
        } else {
          // Bitti
          setUstasiIndex(ustasiIndex + 1); // oturum sonu ekranını tetikle
        }
      } else {
        setUstasiIndex(ustasiIndex + 1);
      }
    }, 300);
  };


  // ── YouTube'dan ezber kartı üretimi ──────────────────────────────────────
  const YTGEN_BASE = (import.meta as any).env?.VITE_YTGEN_BASE_URL || '/pdftest/ytgen';

  const ytgenFetchPlaylistInfo = async () => {
    if (!user) { alert('Giriş yapmanız gerekiyor.'); return; }
    if (!ytUrl.trim()) { alert('YouTube linki girin.'); return; }
    setYtLoading(true);
    setYtVideos([]);
    setYtPlaylistName(null);
    setYtSelected(new Set());
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${YTGEN_BASE}/playlist-info`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ytUrl.trim() }),
      });
      if (!res.ok) {
        const errText = await res.text();
        alert(`Link çözümlenemedi: ${errText}`);
        return;
      }
      const data = await res.json();
      setYtVideos(data.videos || []);
      setYtPlaylistName(data.playlistName || null);
      // Tek video ise otomatik seç
      if (data.videos?.length === 1) {
        setYtSelected(new Set([data.videos[0].id]));
      } else {
        // Playlist: varsayılan hepsini seç
        setYtSelected(new Set((data.videos || []).map((v: any) => v.id)));
      }
    } catch (err: any) {
      alert(`Hata: ${err.message || err}`);
    } finally {
      setYtLoading(false);
    }
  };

  const ytgenStartGeneration = async () => {
    if (!user) { alert('Giriş yapmanız gerekiyor.'); return; }
    if (ytSelected.size === 0) { alert('En az 1 video seçin.'); return; }
    const selectedVideos = ytVideos.filter(v => ytSelected.has(v.id));
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${YTGEN_BASE}/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videos: selectedVideos,
          playlistName: ytPlaylistName,
          subject: memorizeNewSubject || null,
          topic: memorizeNewTopic || null,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        alert(`Başlatılamadı: ${errText}`);
        return;
      }
      const data = await res.json();
      setYtJobId(data.jobId);
      setYtJobStatus({ status: 'processing', total: data.total, done: 0, cardsCount: 0, errors: [], current: '' });
      // Polling başlat
      if (ytPollRef.current) clearInterval(ytPollRef.current);
      ytPollRef.current = window.setInterval(() => ytgenPollJob(data.jobId), 3000);
    } catch (err: any) {
      alert(`Hata: ${err.message || err}`);
    }
  };

  const ytgenPollJob = async (jobId: string) => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${YTGEN_BASE}/job/${jobId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const status = await res.json();
      setYtJobStatus(status);
      if (status.status === 'completed' || status.status === 'error' || status.status === 'cancelled') {
        if (ytPollRef.current) {
          clearInterval(ytPollRef.current);
          ytPollRef.current = null;
        }
        // Tamamlandı — kartları yeniden yükle
        try {
          const memRes = await fetch(`${(import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api'}/memorize`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (memRes.ok) {
            const serverMem: MemorizeCard[] = await memRes.json();
            serverMem.sort((a, b) => b.createdAt - a.createdAt);
            setMemorizeCards(serverMem);
          }
        } catch {}
      }
    } catch (err) {
      console.error('ytgen poll error:', err);
    }
  };

  const ytgenCancel = async () => {
    if (!ytJobId || !user) return;
    try {
      const token = await user.getIdToken();
      await fetch(`${YTGEN_BASE}/job/${ytJobId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (ytPollRef.current) { clearInterval(ytPollRef.current); ytPollRef.current = null; }
      setYtJobId(null);
      setYtJobStatus(null);
    } catch {}
  };

  const ytgenReset = () => {
    if (ytPollRef.current) { clearInterval(ytPollRef.current); ytPollRef.current = null; }
    setYtUrl('');
    setYtVideos([]);
    setYtPlaylistName(null);
    setYtSelected(new Set());
    setYtJobId(null);
    setYtJobStatus(null);
  };


  const [rectDrawState, setRectDrawState] = useState<{page: number, startX: number, startY: number, currentX: number, currentY: number} | null>(null);

  const handleRectPointerDown = (e: React.PointerEvent<HTMLDivElement>, page: number) => {
    if (activeMarkTool !== 'rect') return;
    if (readOnlyLock) return; // FIX: okuma kilidi
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setRectDrawState({ page, startX: x, startY: y, currentX: x, currentY: y });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleRectPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!rectDrawState) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setRectDrawState(prev => prev ? { ...prev, currentX: x, currentY: y } : null);
  };

  const handleRectPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!rectDrawState) return;
    const x = Math.min(rectDrawState.startX, rectDrawState.currentX);
    const y = Math.min(rectDrawState.startY, rectDrawState.currentY);
    const width = Math.abs(rectDrawState.currentX - rectDrawState.startX);
    const height = Math.abs(rectDrawState.currentY - rectDrawState.startY);
    if (width > 2 && height > 2) {
      const newMark = { id: uuidv4(), page: rectDrawState.page, x, y, width, height, color: 'yellow' as const, markType: 'rect' as const };
      setPdfMarks(prev => [...prev, newMark]);
    }
    setRectDrawState(null);
  };

  const handlePageClick = (e: React.MouseEvent<HTMLDivElement>, page: number, isReviewMode: boolean = false) => {
    if (activeMarkTool === 'rect') return; // rect aracı pointer events ile çalışır
    if ((mode !== 'taking' && !isReviewMode) || isCropMode || isHighlightMode || isNoteCropMode) return;
    // FIX: Okuma kilidi aktifse tıklama hiçbir şey yapmaz
    if (readOnlyLock) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    
    const newMark = {
      id: uuidv4(),
      page,
      x,
      y,
      color: (activeMarkTool === 'green-tick' || activeMarkTool === 'green-dot') ? 'green' as const : 'red' as const,
      questionNumber: activeQuestion,
      markType: activeMarkTool === 'green-tick' ? 'tick' as const : (activeMarkTool === 'red-cross' ? 'cross' as const : (activeMarkTool === 'green-dot' ? 'green-dot' as const : 'dot' as const))
    };
    setPdfMarks(prev => [...prev, newMark]);
  };

  const handleMarkClick = (id: string, e: React.MouseEvent, isReviewMode: boolean = false) => {
    e.stopPropagation();
    if (mode !== 'taking' && !isReviewMode) return;
    // FIX: Okuma kilidi aktifse mark silinmez
    if (readOnlyLock) return;
    
    setPdfMarks(prev => prev.filter(m => m.id !== id));
  };

  const handleQuickMark = (option: string) => {
    const isTogglingOff = userAnswers[activeQuestion] === option;
    
    setUserAnswers((prev) => {
      if (isTogglingOff) {
        const newAnswers = { ...prev };
        delete newAnswers[activeQuestion];
        return newAnswers;
      }
      return { ...prev, [activeQuestion]: option };
    });

    if (!isTogglingOff) {
      setTimeout(() => {
        let nextQ = activeQuestion;
        if (activeQuestion < questionCount) {
          nextQ = activeQuestion + 1;
        } else {
          setQuestionCount(p => p + 1);
          nextQ = activeQuestion + 1;
        }
        scrollToQuestion(nextQ);
      }, 250);
    }
  };

  const handleCorrectAnswerSelect = (qNum: number, option: string) => {
    setCorrectAnswers((prev) => {
      if (prev[qNum] === option) {
        const newAnswers = { ...prev };
        delete newAnswers[qNum];
        return newAnswers;
      }
      return { ...prev, [qNum]: option };
    });
  };

  const handleFinishClick = () => {
    const answeredCount = Object.keys(userAnswers).length;
    if (answeredCount < questionCount) {
      setShowFinishModal(true);
    } else {
      finishExam();
    }
  };

  const confirmFinish = () => {
    setShowFinishModal(false);
    finishExam();
  };

  const finishExam = () => {
    setIsTimerRunning(false);
    setActiveQuestion(1);
    setMode('grading');
  };

  const calculateResults = () => {
    setMode('results');
  };

  const resetApp = async () => {
    setConfirmModal({
      isOpen: true,
      message: 'Testi sıfırlamak istediğinize emin misiniz? Cevaplar ve süre sıfırlanacak, işaretler korunacak.',
      onConfirm: async () => {
        setIsTimerRunning(false);
        setTimeElapsed(0);
        setUserAnswers({});
        setCorrectAnswers({});
        setActiveQuestion(1);
        // setPdfMarks([]) — işaretler korunuyor
        // setDrawings([]) — çizgiler korunuyor
        setMode('taking');
        setIsTimerRunning(false); // FIX: Sayaç otomatik başlamıyor, kullanıcı tıklar
        
        // Update in storage — işaretler ve çizgiler mevcut haliyle kalıyor
        if (currentSessionId) {
          const baseSession = sessions.find(s => s.id === currentSessionId);
          if (baseSession) {
            const updatedSession = {
              ...baseSession,
              userAnswers: {},
              correctAnswers: {},
              timeElapsed: 0,
              activeQuestion: 1,
              mode: 'taking' as const,
              pdfMarks: pdfMarks,   // işaretler korunuyor
              drawings: drawings,   // çizgiler korunuyor
              bookmarks: bookmarks, // FIX: bookmarks da korunuyor
              lastAccessed: Date.now()
            };
            await saveExamSession(updatedSession);
            setSessions(prev => prev.map(s => s.id === currentSessionId ? updatedSession : s));
          }
        }
      }
    });
  };

  const renderSetup = () => {
    const groupedSessions = sessions.reduce((acc, session) => {
      const subject = session.subject || 'Genel';
      if (!acc[subject]) acc[subject] = [];
      acc[subject].push(session);
      return acc;
    }, {} as Record<string, ExamSession[]>);

    return (
      <div className="flex flex-col items-center justify-start min-h-[100dvh] p-4 max-w-6xl mx-auto w-full animate-in fade-in slide-in-from-bottom-4 duration-500 relative pt-12">
        <div className="w-full flex flex-wrap justify-between items-center mb-6 gap-y-2">
          <div className="flex items-center gap-1 flex-wrap">
            <button
              onClick={() => setMode('saved_questions')}
              className="px-2.5 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-all flex items-center gap-1.5 border border-transparent hover:border-slate-700/50"
            >
              <BookOpen size={13} />
              <span className="text-xs font-medium tracking-wide">Sorular</span>
            </button>
            <button
              onClick={() => setMode('saved_notes' as any)}
              className="px-2.5 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-all flex items-center gap-1.5 border border-transparent hover:border-slate-700/50"
            >
              <StickyNote size={13} className="text-green-400" />
              <span className="text-xs font-medium tracking-wide">Notlarım</span>
              {todayReviewNotes.length > 0 && (
                <span className="text-[10px] bg-rose-600 text-white px-1.5 py-0.5 rounded-full font-bold animate-pulse">{todayReviewNotes.length}</span>
              )}
            </button>
            <button
              onClick={() => setMode('memorize')}
              className="px-2.5 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-all flex items-center gap-1.5 border border-transparent hover:border-slate-700/50"
            >
              <Book size={13} className="text-violet-400" />
              <span className="text-xs font-medium tracking-wide">Ezber</span>
              {todayMemorizeCards.length > 0 && (
                <span className="text-[10px] bg-rose-600 text-white px-1.5 py-0.5 rounded-full font-bold animate-pulse">{todayMemorizeCards.length}</span>
              )}
            </button>
            <button
              onClick={() => setMode('analiz')}
              className="px-2.5 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-all flex items-center gap-1.5 border border-transparent hover:border-slate-700/50"
              title="Analiz, hata günlüğü, sınav geri sayımı"
            >
              <span className="text-base leading-none">📊</span>
              <span className="text-xs font-medium tracking-wide">Analiz</span>
              {analyzeStats.errorBook.length > 0 && (
                <span className="text-[10px] bg-amber-600 text-white px-1.5 py-0.5 rounded-full font-bold">{analyzeStats.errorBook.length}</span>
              )}
            </button>
            <button
              onClick={() => setMode('calisma')}
              className={`px-2.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 border ${
                (studyState.phase === 'working' || studyState.phase === 'break')
                  ? 'text-emerald-300 bg-emerald-900/30 border-emerald-700/40 animate-pulse'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border-transparent hover:border-slate-700/50'
              }`}
              title="Çalışma sayacı, Pomodoro/Deep Work"
            >
              <span className="text-base leading-none">⏱</span>
              <span className="text-xs font-medium tracking-wide">Çalışma</span>
              {studyState.phase === 'working' && <span className="text-[9px] bg-emerald-600 text-white px-1.5 py-0.5 rounded-full font-bold">ON</span>}
            </button>
            <button
              onClick={() => { setShowTrackingModal(true); loadTrackingData(); }}
              className="px-2.5 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-all flex items-center gap-1.5 border border-transparent hover:border-slate-700/50"
            >
              <ListChecks size={13} />
              <span className="text-xs font-medium tracking-wide">Konu Takibi</span>
            </button>
          </div>
          
          <div className="flex items-center gap-2">
            {user ? (
              <div className="flex items-center gap-2 bg-slate-800/40 px-2.5 py-1.5 rounded-lg border border-slate-700/50">
                <User size={13} className="text-slate-300 shrink-0" />
                <span className="text-xs font-medium text-slate-300 max-w-[80px] truncate">{user.displayName}</span>
                <button onClick={logout} className="text-xs text-rose-400 hover:text-rose-300 font-medium shrink-0">Çıkış</button>
              </div>
            ) : (
              <button
                onClick={() => setShowLoginModal(true)}
                className="px-2.5 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2 shadow-lg shadow-blue-900/20"
              >
                Giriş Yap
              </button>
            )}
            <button
              onClick={() => setShowSettingsModal(true)}
              className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-all border border-transparent hover:border-slate-700/50"
            >
              <Settings size={16} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full max-w-6xl mx-auto">
          {/* Left/Main Column: Library */}
          <div className="lg:col-span-12 bg-slate-900/30 backdrop-blur-sm p-5 rounded-2xl border border-slate-800/40 flex flex-col shadow-sm">
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-800/40">
              <FolderOpen size={14} className="text-blue-400/80" />
              <h2 className="text-sm font-medium text-slate-200 tracking-wide">PDF Kütüphanesi</h2>
            </div>
            
            {/* Library Navigation */}
            <div className="flex-1 flex flex-col">
              {/* Breadcrumbs */}
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 mb-4 overflow-x-auto pb-1 custom-scrollbar">
                <button 
                  onClick={() => { setLibraryView('subjects'); setActiveSubject(null); setActiveCategory(null); }}
                  className={`hover:text-slate-300 transition-colors flex items-center gap-1 ${libraryView === 'subjects' ? 'text-blue-400/90' : ''}`}
                >
                  <Folder size={12} /> Dersler
                </button>
                {activeSubject && (
                  <>
                    <ChevronRight size={10} className="text-slate-700 shrink-0" />
                    <button 
                      onClick={() => { setLibraryView('categories'); setActiveCategory(null); }}
                      className={`hover:text-slate-300 transition-colors whitespace-nowrap ${libraryView === 'categories' ? 'text-blue-400/90' : ''}`}
                    >
                      {activeSubject}
                    </button>
                  </>
                )}
                {activeCategory && (
                  <>
                    <ChevronRight size={10} className="text-slate-700 shrink-0" />
                    <span className="text-blue-400/90 whitespace-nowrap">{activeCategory}</span>
                  </>
                )}
              </div>

              {/* Content Views */}
              {libraryView === 'subjects' && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {SUBJECTS.map(sub => (
                    <button
                      key={sub}
                      onClick={() => { setActiveSubject(sub); setLibraryView('categories'); }}
                      className="flex flex-col items-center justify-center gap-2 p-3 bg-slate-800/20 hover:bg-slate-800/60 border border-slate-700/30 hover:border-blue-500/30 rounded-xl transition-all group text-center"
                    >
                      <div className="w-8 h-8 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0 group-hover:bg-blue-500/20 transition-colors">
                        <Folder className="text-blue-400/80" size={16} />
                      </div>
                      <div className="min-w-0 w-full">
                        <div className="text-[11px] font-medium text-slate-300 group-hover:text-slate-200 whitespace-normal break-words leading-tight">{sub}</div>
                        <div className="text-[9px] text-slate-500 mt-1">{pdfLibrary.filter(p => p.subject === sub).length} Dosya</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {libraryView === 'categories' && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat}
                      onClick={() => { setActiveCategory(cat); setLibraryView('pdfs'); }}
                      className="flex flex-col items-center justify-center gap-2 p-3 bg-slate-800/20 hover:bg-slate-800/60 border border-slate-700/30 hover:border-emerald-500/30 rounded-xl transition-all group text-center"
                    >
                      <div className="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center shrink-0 group-hover:bg-emerald-500/20 transition-colors">
                        <FolderOpen className="text-emerald-400/80" size={16} />
                      </div>
                      <div className="min-w-0 w-full">
                        <div className="text-[11px] font-medium text-slate-300 group-hover:text-slate-200 whitespace-normal break-words leading-tight">{cat}</div>
                        <div className="text-[9px] text-slate-500 mt-1">{pdfLibrary.filter(p => p.subject === activeSubject && p.category === cat).length} Dosya</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {libraryView === 'pdfs' && (
                <div className="space-y-2 flex-1">
                  {pdfLibrary.filter(p => p.subject === activeSubject && p.category === activeCategory).length === 0 ? (
                    <div className="text-center py-8 text-slate-500 text-[11px] bg-slate-800/10 rounded-xl border border-slate-800/30 border-dashed">
                      Bu klasörde henüz PDF bulunmuyor.
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
                      {pdfLibrary.filter(p => p.subject === activeSubject && p.category === activeCategory).map(pdf => {
                        // FIX: PDF tamamlanma yüzdesi — readPages'e göre (eksik ise maxPageViewed fallback)
                        const relatedSession = sessions.find(s => s.pdfId === pdf.id) || sessions.find(s => s.name === pdf.name);
                        const total = relatedSession?.totalPages || 0;
                        const readPagesCount = (relatedSession?.readPages?.length) || 0;
                        const maxVw = relatedSession?.maxPageViewed || 0;
                        // readPages varsa onu kullan, yoksa maxPageViewed
                        const effectiveRead = readPagesCount > 0 ? readPagesCount : maxVw;
                        const pct = total > 0 ? Math.min(100, Math.round((effectiveRead / total) * 100)) : 0;
                        return (
                        <div key={pdf.id} className="flex items-center justify-between p-2 bg-slate-800/20 border border-slate-700/30 rounded-lg hover:border-blue-500/30 hover:bg-slate-800/50 transition-all group">
                          <div className="flex items-center gap-2.5 overflow-hidden cursor-pointer flex-1" onClick={() => openStoredPdf(pdf)}>
                            <div className="w-6 h-6 rounded-md bg-red-500/10 text-red-400/80 flex items-center justify-center shrink-0 group-hover:bg-red-500/20 transition-colors">
                              <File size={12} />
                            </div>
                            <div className="min-w-0 text-left flex-1">
                              <div className="text-[11px] font-medium text-slate-300 group-hover:text-blue-400/90 transition-colors whitespace-normal break-words leading-tight">{pdf.name}</div>
                              <div className="text-[9px] text-slate-500 flex gap-1.5 mt-1">
                                <span>{new Date(pdf.addedAt).toLocaleDateString()}</span>
                                <span>•</span>
                                <span>{(pdf.size / (1024 * 1024)).toFixed(2)} MB</span>
                                {total > 0 && (
                                  <>
                                    <span>•</span>
                                    <span className={pct >= 100 ? 'text-emerald-400 font-bold' : (pct >= 50 ? 'text-blue-400' : 'text-amber-400')}>
                                      {effectiveRead}/{total} %{pct}
                                    </span>
                                  </>
                                )}
                              </div>
                              {/* FIX: Tamamlanma barı — sadece session varsa */}
                              {total > 0 && (
                                <div className="mt-1 h-0.5 bg-slate-800 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full transition-all duration-500 ${pct >= 100 ? 'bg-emerald-500' : (pct >= 50 ? 'bg-blue-500' : 'bg-amber-500')}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                          <button 
                            onClick={(e) => deleteStoredPdf(pdf.id, e)}
                            className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-md transition-colors ml-2 shrink-0 opacity-0 group-hover:opacity-100"
                            title="Sil"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                        );
                      })}
                    </div>
                  )}
                  
                  <label className="flex items-center justify-center gap-1.5 w-full p-2 mt-3 bg-slate-800/40 hover:bg-slate-700/60 text-slate-400 hover:text-slate-200 border border-slate-700/50 rounded-lg cursor-pointer transition-all text-[11px] font-medium">
                    <Upload size={12} />
                    <span>Yeni PDF Ekle</span>
                    <input 
                      type="file" 
                      accept="application/pdf"
                      multiple
                      onChange={handleFileUploadToLibrary} 
                      className="hidden" 
                    />
                  </label>
                </div>
              )}
            </div>

            {Object.keys(uploadProgress).length > 0 && (
              <div className="mt-3 space-y-2">
                {Object.entries(uploadProgress).map(([id, {name, pct}]) => (
                  <div key={id} className="px-1">
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span className="truncate max-w-[80%]">{name}</span>
                      <span className="font-mono">{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full transition-all duration-200" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Storage Usage Bar */}
            {user && (
              <div className="mt-4 pt-4 border-t border-slate-800/40">
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Bulut Depolama Alanı</span>
                  <span className="text-[10px] font-medium text-slate-300">
                    {(storageUsed / (1024 * 1024)).toFixed(1)} MB / 4096 MB
                  </span>
                </div>
                <div className="w-full bg-slate-800/50 rounded-full h-1.5 overflow-hidden">
                  <div 
                    className={`h-full rounded-full ${storageUsed / STORAGE_LIMIT > 0.9 ? 'bg-rose-500' : 'bg-blue-500'}`}
                    style={{ width: `${Math.min(100, (storageUsed / STORAGE_LIMIT) * 100)}%` }}
                  ></div>
                </div>
                <p className="text-[9px] text-slate-500 mt-1.5 text-center">
                  PDF'leriniz Firebase Cloud Storage'da güvenle saklanır. Tarayıcı hafızasını yormaz.
                </p>
              </div>
            )}
          </div>


        </div>
      </div>
    );
  };

  const scrollToQuestion = (q: number) => {
    setActiveQuestion(q);
    
    const tryScroll = (retries = 3) => {
      const el = document.getElementById(`question-${q}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.backgroundColor = '#1e3a8a';
        el.style.transition = 'background-color 0.5s';
        setTimeout(() => {
          el.style.backgroundColor = '';
        }, 1000);
      } else if (retries > 0) {
        requestAnimationFrame(() => tryScroll(retries - 1));
      }
      
      const navEl = document.getElementById(`nav-question-${q}`);
      if (navEl) {
        navEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } else if (retries > 0 && !el) {
        // Only retry if both are missing
      }
    };
    
    tryScroll();
  };

  const renderQuestionNavigator = (answers: Record<number, string>) => {
    const questions = Array.from({ length: questionCount }, (_, i) => i + 1);
    return (
      <div className="flex gap-2 overflow-x-auto py-2 px-2 snap-x [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {questions.map(q => {
          const isAnswered = !!answers[q];
          return (
            <button
              id={`nav-question-${q}`}
              key={q}
              onClick={() => scrollToQuestion(q)}
              className={`shrink-0 w-9 h-9 rounded-lg text-sm font-bold flex items-center justify-center snap-start transition-all ${
                q === activeQuestion
                  ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-slate-900 ' + (isAnswered ? 'bg-blue-600 text-white' : 'bg-slate-700 text-white')
                  : isAnswered 
                    ? 'bg-blue-600/60 text-white border-transparent shadow-sm' 
                    : 'bg-slate-800 text-slate-400 border border-slate-700 hover:border-blue-500 hover:bg-slate-700'
              }`}
            >
              {q}
            </button>
          );
        })}
      </div>
    );
  };

  const renderGrid = (
    answers: Record<number, string>,
    onSelect: (q: number, opt: string) => void,
    highlightCorrect?: Record<number, string>,
    activeColorClass: string = "bg-blue-600 border-blue-600"
  ) => {
    const questions = Array.from({ length: questionCount }, (_, i) => i + 1);
    
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-3 pb-8">
        {questions.map((q) => {
          const selected = answers[q];
          const correct = highlightCorrect ? highlightCorrect[q] : null;
          
          let statusColor = "text-slate-300";
          if (highlightCorrect) {
            if (!selected) statusColor = "text-slate-600"; // Boş
            else if (selected === correct) statusColor = "text-emerald-400 font-bold"; // Doğru
            else statusColor = "text-rose-400 font-bold"; // Yanlış
          }

          return (
            <div id={`question-${q}`} key={q} className={`flex items-center justify-between p-2 rounded-lg transition-colors border-b border-slate-800 sm:border-none ${q === activeQuestion && !highlightCorrect ? 'bg-slate-800/80 ring-1 ring-slate-700' : 'hover:bg-slate-800/50'}`}>
              <span className={`w-8 text-sm font-medium ${statusColor}`}>{q}.</span>
              <div className="flex gap-1">
                {OPTIONS.map((opt) => {
                  const isSelected = selected === opt;
                  const isCorrect = highlightCorrect && correct === opt;
                  const isWrongSelected = highlightCorrect && isSelected && correct !== opt;
                  
                  let btnClass = "w-10 h-10 sm:w-9 sm:h-9 rounded-full text-sm font-medium flex items-center justify-center border transition-all duration-200 ";
                  
                  if (highlightCorrect) {
                    // Results mode styling
                    if (isCorrect) {
                      btnClass += "bg-emerald-600 border-emerald-600 text-white shadow-sm ring-2 ring-emerald-900 ring-offset-1 ring-offset-slate-900";
                    } else if (isWrongSelected) {
                      btnClass += "bg-rose-600 border-rose-600 text-white shadow-sm";
                    } else {
                      btnClass += "bg-slate-800 border-slate-700 text-slate-600 opacity-50";
                    }
                  } else {
                    // Interactive mode styling
                    if (isSelected) {
                      btnClass += `${activeColorClass} text-white shadow-md transform scale-105`;
                    } else {
                      btnClass += "bg-slate-800 border-slate-700 text-slate-400 hover:border-blue-500 hover:bg-slate-700 hover:text-slate-200";
                    }
                  }

                  return (
                    <button
                      key={opt}
                      onClick={() => !highlightCorrect && onSelect(q, opt)}
                      disabled={!!highlightCorrect}
                      className={btnClass}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="p-4 flex justify-center border-t border-slate-800/50 sm:col-span-full">
          <button 
            onClick={() => setQuestionCount(p => p + 10)} 
            className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1.5 px-4 py-2 rounded-lg hover:bg-blue-500/10 transition-colors"
          >
            <Plus size={16} /> 10 Soru Daha Ekle
          </button>
        </div>
      </div>
    );
  };

  // FIX: Akıcı çizim (Xodo benzeri) — aktif stroke için canvas ref, eski strokelar için SVG
  // React state update'i stroke bittiğinde 1 kez. Move sırasında doğrudan canvas'a çizim.
  const activeStrokeCanvasRefs = useRef<Map<number, HTMLCanvasElement | null>>(new Map());
  const activeStrokeRef = useRef<Stroke | null>(null);
  const activeStrokeLastPoint = useRef<{ x: number, y: number } | null>(null);

  const getActiveCanvas = (pageIndex: number): HTMLCanvasElement | null => {
    return activeStrokeCanvasRefs.current.get(pageIndex) || null;
  };

  // Aktif stroke'u canvas'a çiz (sadece son 2 nokta arası, incremental)
  const drawActiveSegment = (pageIndex: number, x: number, y: number) => {
    const canvas = getActiveCanvas(pageIndex);
    const stroke = activeStrokeRef.current;
    if (!canvas || !stroke || stroke.page !== pageIndex) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    const last = activeStrokeLastPoint.current;
    if (!last) return;
    const scale = pdfZoom / 100;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width * scale;
    ctx.globalAlpha = stroke.tool === 'highlighter' ? 0.4 : 1;
    ctx.globalCompositeOperation = stroke.tool === 'highlighter' ? 'multiply' : 'source-over';
    ctx.beginPath();
    // Quadratic curve smoothing: mid point between last and current
    const midX = (last.x + x) / 2 * scale;
    const midY = (last.y + y) / 2 * scale;
    ctx.moveTo(last.x * scale, last.y * scale);
    ctx.quadraticCurveTo(last.x * scale, last.y * scale, midX, midY);
    ctx.stroke();
    activeStrokeLastPoint.current = { x, y };
  };

  const clearActiveCanvas = (pageIndex: number) => {
    const canvas = getActiveCanvas(pageIndex);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const eraseStrokes = (x: number, y: number, pageIndex: number) => {
    const eraserRadius = 10 / (pdfZoom / 100);
    setDrawings(prev => {
      const filtered = prev.filter(stroke => {
        if (stroke.page !== pageIndex) return true;
        return !stroke.points.some(p => Math.hypot(p.x - x, p.y - y) < eraserRadius);
      });
      if (filtered.length !== prev.length && currentSessionId) {
        // FIX Drawing race condition: sessions state'inden stale veri okumak yerine
        // mevcut state değerlerini doğrudan kullan — pdfMarks/bookmarks kaybını önler
        const baseSession = sessions.find(s => s.id === currentSessionId);
        if (baseSession) {
          saveExamSession({
            ...baseSession,
            pdfMarks,
            bookmarks,
            userAnswers,
            correctAnswers,
            activeQuestion,
            pdfZoom,
            mode,
            drawings: filtered,
            lastAccessed: Date.now(),
          });
        }
      }
      return filtered;
    });
  };

  const handleDrawPointerDown = (e: React.PointerEvent<HTMLElement>, pageIndex: number) => {
    if (drawMode === 'none') return;
    if (readOnlyLock) return; // FIX: okuma kilidi
    if (stylusOnly && e.pointerType === 'touch') return;
    if (stylusOnly && e.pointerType !== 'pen' && drawMode !== 'eraser') return;

    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / (pdfZoom / 100);
    const y = (e.clientY - rect.top) / (pdfZoom / 100);

    if (drawMode === 'eraser') {
      eraseStrokes(x, y, pageIndex);
    } else {
      // FIX: State yerine ref kullan — re-render tetiklenmesin
      const stroke: Stroke = {
        id: uuidv4(),
        page: pageIndex,
        tool: drawMode as 'pen' | 'highlighter',
        color: drawMode === 'pen' ? drawColor : highlighterColor,
        width: drawMode === 'pen' ? drawWidth : 16,
        points: [{ x, y }]
      };
      activeStrokeRef.current = stroke;
      activeStrokeLastPoint.current = { x, y };
      // setCurrentStroke(stroke); // KALDIRILDI — canvas ile çiziliyor
      setCurrentStroke(stroke); // SVG fallback için ilk nokta
    }
  };

  const handleDrawPointerMove = (e: React.PointerEvent<HTMLElement>, pageIndex: number) => {
    if (drawMode === 'none') return;
    if (stylusOnly && e.pointerType === 'touch') return;

    const rect = e.currentTarget.getBoundingClientRect();

    if (drawMode === 'eraser' && e.buttons === 1) {
      const x = (e.clientX - rect.left) / (pdfZoom / 100);
      const y = (e.clientY - rect.top) / (pdfZoom / 100);
      eraseStrokes(x, y, pageIndex);
      return;
    }

    const stroke = activeStrokeRef.current;
    if (!stroke || stroke.page !== pageIndex) return;

    // FIX: Koalesce edilen event'leri topla — donmayı engeller, noktayı kaçırmaz
    const events = (e.nativeEvent as any).getCoalescedEvents
      ? (e.nativeEvent as any).getCoalescedEvents()
      : [e.nativeEvent];

    for (const ev of events) {
      const x = (ev.clientX - rect.left) / (pdfZoom / 100);
      const y = (ev.clientY - rect.top) / (pdfZoom / 100);
      stroke.points.push({ x, y });
      drawActiveSegment(pageIndex, x, y);
    }
    // Preview SVG'yi de güncellememek için state güncellemesi YAPMIYORUZ
  };

  const handleDrawPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    const finishedStroke = activeStrokeRef.current;
    if (finishedStroke) {
      // FIX: Aktif canvas'ı temizle — bu stroke artık SVG'de kalıcı olacak
      clearActiveCanvas(finishedStroke.page);
      activeStrokeRef.current = null;
      activeStrokeLastPoint.current = null;
      setDrawings(prev => {
        const newDrawings = [...prev, finishedStroke];
        if (currentSessionId) {
          const baseSession = sessions.find(s => s.id === currentSessionId);
          if (baseSession) {
            saveExamSession({
              ...baseSession,
              pdfMarks,
              bookmarks,
              userAnswers,
              correctAnswers,
              activeQuestion,
              pdfZoom,
              mode,
              drawings: newDrawings,
              lastAccessed: Date.now(),
            });
          }
        }
        return newDrawings;
      });
      setCurrentStroke(null);
    }
  };

  const renderDrawingOverlay = (pageIndex: number) => {
    return (
      <>
        {/* Eski strokelar — SVG (hafif, cache-friendly) */}
        <svg
          className="absolute top-0 left-0 w-full h-full z-[35] pointer-events-none"
        >
          {drawings.filter(d => d.page === pageIndex).map(stroke => (
            <polyline
              key={stroke.id}
              points={stroke.points.map(p => `${p.x * (pdfZoom/100)},${p.y * (pdfZoom/100)}`).join(' ')}
              fill="none"
              stroke={stroke.color}
              strokeWidth={stroke.width * (pdfZoom/100)}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={stroke.tool === 'highlighter' ? 0.4 : 1}
              style={{ mixBlendMode: stroke.tool === 'highlighter' ? 'multiply' : 'normal' }}
            />
          ))}
        </svg>
        {/* Aktif stroke — canvas (60-120fps, React re-render tetiklemiyor) */}
        <canvas
          ref={el => {
            if (el) {
              activeStrokeCanvasRefs.current.set(pageIndex, el);
              // Canvas boyutunu parent'a eşitle (high-DPI)
              const parent = el.parentElement;
              if (parent) {
                const dpr = window.devicePixelRatio || 1;
                const w = parent.clientWidth;
                const h = parent.clientHeight;
                if (el.width !== w * dpr || el.height !== h * dpr) {
                  el.width = w * dpr;
                  el.height = h * dpr;
                  el.style.width = w + 'px';
                  el.style.height = h + 'px';
                  const ctx = el.getContext('2d');
                  if (ctx) ctx.scale(dpr, dpr);
                }
              }
            } else {
              activeStrokeCanvasRefs.current.delete(pageIndex);
            }
          }}
          className="absolute top-0 left-0 w-full h-full z-[36] pointer-events-none"
        />
      </>
    );
  };

  const renderPDFInterface = (isGrading: boolean = false, isReview: boolean = false) => {
    const incorrectQs = isReview ? Array.from({length: questionCount}, (_, i) => i + 1)
      .filter(q => correctAnswers[q] && (userAnswers[q] !== correctAnswers[q] || !userAnswers[q]))
      .sort((a, b) => a - b) : [];

    // FIX PERFORMANS: Page-indexed map'ler — her sayfa için filter çağrısı yerine O(1) lookup
    const marksByPage = new Map<number, typeof pdfMarks>();
    for (const m of pdfMarks) {
      if (!marksByPage.has(m.page)) marksByPage.set(m.page, []);
      marksByPage.get(m.page)!.push(m);
    }
    const notesByPage = new Map<number, typeof savedNotes>();
    for (const n of savedNotes) {
      if (n.page && n.pdfId === currentPdfId && n.rect) {
        if (!notesByPage.has(n.page)) notesByPage.set(n.page, []);
        notesByPage.get(n.page)!.push(n);
      }
    }
    const questionsByPage = new Map<number, typeof savedQuestions>();
    for (const q of savedQuestions) {
      if (q.page && q.pdfId === currentPdfId && q.rect) {
        if (!questionsByPage.has(q.page)) questionsByPage.set(q.page, []);
        questionsByPage.get(q.page)!.push(q);
      }
    }
    const drawingsByPage = new Map<number, typeof drawings>();
    for (const d of drawings) {
      if (!drawingsByPage.has(d.page)) drawingsByPage.set(d.page, []);
      drawingsByPage.get(d.page)!.push(d);
    }
      
    return (
      <div className={`${isFullscreen ? 'fixed inset-0 z-[100]' : 'h-[100dvh]'} bg-slate-950 flex flex-col animate-in fade-in duration-300 overflow-hidden`}>
        {/* Header — Odak modunda gizli (sadece taking modunda focus çalışır) */}
        <div className={`bg-slate-900 px-2 sm:px-4 py-1.5 flex items-center justify-between shadow-md z-20 shrink-0 border-b border-slate-800 gap-2 overflow-x-auto scrollbar-none ${focusMode && mode === 'taking' && !isGrading && !isReview ? 'hidden' : ''}`}>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                if (window.confirm('Ana ekrana dönmek istediğinize emin misiniz?')) {
                  setCurrentSessionId(null);
                  setPdfUrl(null);
                  setMode('setup');
                }
              }}
              className="text-slate-400 hover:text-white p-1.5 rounded-lg transition-colors bg-slate-800 border border-slate-700 hover:bg-slate-700"
              title="Ana Ekrana Dön"
            >
              <Home size={18} />
            </button>
            {isReview ? (
              <>
                <button
                  onClick={() => {
                    setShowReviewPDF(false);
                    setPendingReviewScroll(null);
                  }}
                  className="text-slate-400 hover:text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <ArrowLeft size={16} /> Sonuçlara Dön
                </button>
                <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                  <button
                    onClick={() => { setIsCropMode(false); setIsHighlightMode(false); setIsNoteCropMode(false); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${!isCropMode && !isHighlightMode ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Kaydır (Pan)"
                  >
                    <Hand size={16} /> <span className="hidden sm:inline">Kaydır</span>
                  </button>
                  <button
                    onClick={() => { setIsHighlightMode(true); setIsCropMode(false); setIsNoteCropMode(false); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${isHighlightMode ? 'bg-yellow-600/20 text-yellow-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Vurgula"
                  >
                    <Highlighter size={16} /> <span className="hidden sm:inline">Vurgula</span>
                  </button>
                  <button
                    onClick={() => { setIsCropMode(true); setIsHighlightMode(false); setIsNoteCropMode(false); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${isCropMode ? 'bg-blue-600/20 text-blue-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Soru Kes"
                  >
                    <Crop size={16} /> <span className="hidden sm:inline">Kes</span>
                  </button>
                </div>
              </>
            ) : isGrading ? (
              <>
                <button
                  onClick={() => setMode('taking')}
                  className="text-slate-400 hover:text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <ArrowLeft size={16} /> Sınava Dön
                </button>
                <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                  <button
                    onClick={() => { setIsCropMode(false); setIsHighlightMode(false); setIsNoteCropMode(false); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${!isCropMode && !isHighlightMode ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Kaydır (Pan)"
                  >
                    <Hand size={16} /> <span className="hidden sm:inline">Kaydır</span>
                  </button>
                  <button
                    onClick={() => { setIsHighlightMode(true); setIsCropMode(false); setIsNoteCropMode(false); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${isHighlightMode ? 'bg-yellow-600/20 text-yellow-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Vurgula"
                  >
                    <Highlighter size={16} /> <span className="hidden sm:inline">Vurgula</span>
                  </button>
                  <button
                    onClick={() => { setIsCropMode(true); setIsHighlightMode(false); setIsNoteCropMode(false); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${isCropMode ? 'bg-blue-600/20 text-blue-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Soru Kes"
                  >
                    <Crop size={16} /> <span className="hidden sm:inline">Kes</span>
                  </button>
                </div>
                <button
                  onClick={() => setGradingViewMode('grid')}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border border-slate-700"
                >
                  Grid Görünümü
                </button>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                  <button
                    onClick={() => { setIsCropMode(false); setIsHighlightMode(false); setIsNoteCropMode(false); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${!isCropMode && !isHighlightMode ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Kaydır (Pan)"
                  >
                    <Hand size={16} /> <span className="hidden sm:inline">Kaydır</span>
                  </button>
                  <button
                    onClick={() => { setIsHighlightMode(true); setIsCropMode(false); setIsNoteCropMode(false); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${isHighlightMode ? 'bg-yellow-600/20 text-yellow-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Vurgula"
                  >
                    <Highlighter size={16} /> <span className="hidden sm:inline">Vurgula</span>
                  </button>
                  <button
                    onClick={() => { setIsCropMode(true); setIsHighlightMode(false); setIsNoteCropMode(false); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${isCropMode ? 'bg-blue-600/20 text-blue-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Soru Kes"
                  >
                    <Crop size={16} /> <span className="hidden sm:inline">Kes</span>
                  </button>
                </div>
                <div 
                  className="bg-slate-800 text-slate-300 px-3 py-1.5 rounded-lg flex items-center gap-2 font-mono text-sm font-medium border border-slate-700 cursor-pointer hover:bg-slate-700 transition-colors"
                  onClick={() => setIsTimerRunning(!isTimerRunning)}
                  title={isTimerRunning ? "Süreyi Durdur" : "Süreyi Başlat"}
                >
                  <Clock size={16} className={isTimerRunning ? "text-blue-400 animate-pulse" : ""} />
                  {formatTime(timeElapsed)}
                </div>
                {isSaving && (
                  <div className="text-[10px] text-slate-400 flex items-center gap-1 animate-pulse">
                    <RefreshCw size={10} className="animate-spin" /> Kaydediliyor
                  </div>
                )}
                {!isSaving && (
                  <div className="text-[10px] text-slate-500 flex items-center gap-1">
                    <CheckCircle size={10} /> Kaydedildi
                  </div>
                )}
              </div>
            )}
          </div>
          {isReview && (
            <div className="bg-slate-800 text-slate-300 px-3 py-1.5 rounded-lg text-sm font-medium border border-slate-700">
              İnceleme Modu
            </div>
          )}
        </div>

        {/* Bookmark Paneli — FIX #3: Duplicate panel kaldırıldı */}
        {showBookmarks && bookmarks.length > 0 && (
          <div className="absolute top-0 right-0 z-30 w-64 bg-slate-900 border-l border-slate-700 h-full overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 sticky top-0 bg-slate-900">
              <span className="text-sm font-bold text-white">📑 Bookmarklar</span>
              <button onClick={() => setShowBookmarks(false)} className="text-slate-400 hover:text-white">
                <X size={16} />
              </button>
            </div>
            <div className="divide-y divide-slate-800">
              {bookmarks.sort((a,b) => a.page - b.page).map(bm => (
                <div key={bm.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-800 cursor-pointer group"
                  onClick={() => {
                    const idx = twoPageView ? Math.floor((bm.page - 1) / 2) : bm.page - 1;
                    virtuosoRef.current?.scrollToIndex({ index: idx, behavior: 'smooth' });
                    setShowBookmarks(false);
                  }}
                >
                  <span className="text-yellow-400 text-sm">⭐</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white font-medium">Sayfa {bm.page}</p>
                    <p className="text-[10px] text-slate-500 truncate">{bm.note}</p>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); setBookmarks(prev => prev.filter(b => b.id !== bm.id)); }}
                    className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400"
                  ><X size={12} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Rect çizim preview */}
        {rectDrawState && (
          <div className="fixed pointer-events-none z-[200]" style={{
            position: 'fixed',
            border: '2px dashed rgba(59,130,246,0.8)',
            background: 'rgba(59,130,246,0.05)',
            borderRadius: '2px',
          }} />
        )}
        {/* PDF Viewer or Empty State */}
        <div ref={pdfContainerRef} className="flex-1 min-h-0 w-full bg-slate-950 relative flex flex-col">
          {/* FIX: Odak modu — minimal floating çıkış butonu + ilerleme barı */}
          {focusMode && mode === 'taking' && !isGrading && !isReview && pdfUrl && (
            <>
              {/* Sağ üstte küçük çıkış butonu */}
              <button
                onClick={() => setFocusMode(false)}
                className="fixed top-2 right-2 z-[80] bg-slate-900/70 backdrop-blur-md hover:bg-slate-800 text-slate-300 hover:text-white w-9 h-9 rounded-full flex items-center justify-center shadow-lg border border-slate-700/50 transition-all"
                title="Odak Modunu Kapat"
              >
                <X size={16} />
              </button>
              {/* FIX: Odak modunda not kes / soru kes butonları — küçük floating */}
              <div className="fixed bottom-4 right-2 z-[80] flex flex-col gap-2">
                <button
                  onClick={() => {
                    setIsNoteCropMode(prev => !prev);
                    setIsCropMode(false); setIsHighlightMode(false);
                    setReadOnlyLock(false); // Not kesebilmek için kilidi aç
                  }}
                  className={`backdrop-blur-md w-11 h-11 rounded-full flex items-center justify-center shadow-lg border transition-all ${isNoteCropMode ? 'bg-green-600 text-white border-green-500 animate-pulse' : 'bg-slate-900/70 hover:bg-green-800/60 text-green-400 border-green-700/50'}`}
                  title={isNoteCropMode ? 'Not Kesme: aç — alandan sürükle' : 'Not Kes (Odak)'}
                >
                  <StickyNote size={18} />
                </button>
                <button
                  onClick={() => {
                    setIsCropMode(prev => !prev);
                    setIsNoteCropMode(false); setIsHighlightMode(false);
                    setReadOnlyLock(false);
                  }}
                  className={`backdrop-blur-md w-11 h-11 rounded-full flex items-center justify-center shadow-lg border transition-all ${isCropMode ? 'bg-blue-600 text-white border-blue-500 animate-pulse' : 'bg-slate-900/70 hover:bg-blue-800/60 text-blue-400 border-blue-700/50'}`}
                  title={isCropMode ? 'Soru Kesme: aç — alandan sürükle' : 'Soru Kes (Odak)'}
                >
                  <Crop size={18} />
                </button>
                {/* FIX: Odakta "Buraya kadar okudum" butonu */}
                <button
                  onClick={() => {
                    const scrollIdx = currentScrollIndexRef.current || 0;
                    const currentPage = twoPageView ? scrollIdx * 2 + 1 : scrollIdx + 1;
                    const secondPage = twoPageView ? scrollIdx * 2 + 2 : null;
                    setReadPages(prev => {
                      const next = new Set(prev);
                      for (let p = 1; p <= currentPage; p++) next.add(p);
                      if (secondPage && numPages && secondPage <= numPages) next.add(secondPage);
                      return next;
                    });
                  }}
                  className={`backdrop-blur-md w-11 h-11 rounded-full flex items-center justify-center shadow-lg border transition-all ${(() => {
                    const scrollIdx = currentScrollIndexRef.current || 0;
                    const p = twoPageView ? scrollIdx * 2 + 1 : scrollIdx + 1;
                    return readPages.has(p)
                      ? 'bg-emerald-600 text-white border-emerald-500'
                      : 'bg-slate-900/70 hover:bg-emerald-800/60 text-emerald-400 border-emerald-700/50';
                  })()}`}
                  title="Buraya Kadar Okudum"
                >
                  <Check size={18} />
                </button>
              </div>
              {/* Üstte minimal ilerleme barı (sayfa hedefi varsa) */}
              {pageGoal > 0 && numPages && (() => {
                const currentPage = twoPageView
                  ? Math.min(numPages, (currentScrollIndexRef.current * 2) + 1)
                  : currentScrollIndexRef.current + 1;
                const progressPct = Math.min(100, Math.round((pagesRead / pageGoal) * 100));
                return (
                  <div className="fixed top-0 left-0 right-0 z-[75] pointer-events-none">
                    <div className="h-1 bg-slate-900/40 backdrop-blur-sm">
                      <div
                        className={`h-full transition-all duration-500 ${progressPct >= 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    <div className="absolute top-1.5 left-2 flex items-center gap-1.5 text-[10px] text-slate-400 bg-slate-900/70 backdrop-blur-md px-2 py-0.5 rounded-md border border-slate-800/50 pointer-events-auto">
                      <span className="font-mono">{currentPage}/{numPages}</span>
                      <span className="opacity-60">·</span>
                      <span className={progressPct >= 100 ? 'text-emerald-400 font-bold' : ''}>
                        {pagesRead}/{pageGoal} hedef (%{progressPct})
                      </span>
                    </div>
                  </div>
                );
              })()}
            </>
          )}
          {pdfUrl ? (
            <>
              {/* PDF Toolbar — Odak modunda gizli */}
              <div className={`bg-slate-900 text-slate-300 px-3 py-2 flex items-center justify-between shrink-0 text-sm shadow-md z-10 border-b border-slate-800 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] ${focusMode && mode === 'taking' && !isGrading && !isReview ? 'hidden' : ''}`}>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-slate-400 font-medium hidden sm:inline">PDF Görünümü</span>
                  
                  {/* Mark Tools (Moved from floating) */}
                  {(!isCropMode && !isHighlightMode && !isNoteCropMode && drawMode === 'none' && (mode === 'taking' || isReview)) && (
                    <div className="flex items-center gap-1 bg-slate-800/50 p-1 rounded-lg border border-slate-700/50">
                      <button 
                        onClick={() => setActiveMarkTool('red-dot')} 
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-all ${activeMarkTool === 'red-dot' ? 'bg-slate-700 ring-1 ring-red-500 shadow-sm' : 'hover:bg-slate-700/80 opacity-70 hover:opacity-100'}`}
                        title="Kırmızı Nokta"
                      >
                        <div className="w-3 h-3 rounded-full bg-red-500 border-2 border-slate-900 shadow-sm"></div>
                      </button>
                      <button 
                        onClick={() => setActiveMarkTool('green-dot')} 
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-all ${activeMarkTool === 'green-dot' ? 'bg-slate-700 ring-1 ring-emerald-500 shadow-sm' : 'hover:bg-slate-700/80 opacity-70 hover:opacity-100'}`}
                        title="Yeşil Nokta"
                      >
                        <div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-slate-900 shadow-sm"></div>
                      </button>
                      <button 
                        onClick={() => setActiveMarkTool('green-tick')} 
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-all ${activeMarkTool === 'green-tick' ? 'bg-slate-700 ring-1 ring-emerald-500 shadow-sm' : 'hover:bg-slate-700/80 opacity-70 hover:opacity-100'}`}
                        title="Doğru (Yeşil Tik)"
                      >
                        <Check className="text-emerald-500" size={14} strokeWidth={3} />
                      </button>
                      <button 
                        onClick={() => setActiveMarkTool('red-cross')} 
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-all ${activeMarkTool === 'red-cross' ? 'bg-slate-700 ring-1 ring-red-500 shadow-sm' : 'hover:bg-slate-700/80 opacity-70 hover:opacity-100'}`}
                        title="Yanlış (Kırmızı Çarpı)"
                      >
                        <X className="text-red-500" size={14} strokeWidth={3} />
                      </button>
                      {/* NOT KES butonu — rect butonu kaldırıldı, not kesme aracı */}
                      <button
                        onClick={() => { setIsNoteCropMode(prev => !prev); setIsCropMode(false); setIsHighlightMode(false); }}
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-all ${isNoteCropMode ? 'bg-green-700/40 ring-1 ring-green-400 shadow-sm' : 'hover:bg-slate-700/80 opacity-70 hover:opacity-100'}`}
                        title="Önemli Not Kes"
                      >
                        <StickyNote className="text-green-400" size={13} />
                      </button>
                    </div>
                  )}

                  {/* Drawing Tools */}
                  <div className="flex items-center gap-1 bg-slate-800/50 p-1 rounded-lg border border-slate-700/50 ml-2">
                    <button
                      onClick={() => setDrawMode('none')}
                      className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${drawMode === 'none' ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                      title="İşaretçi"
                    >
                      <MousePointer2 size={14} />
                    </button>
                    <button
                      onClick={() => setDrawMode('pen')}
                      className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${drawMode === 'pen' ? 'bg-slate-700 text-red-400 shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                      title="Tükenmez Kalem"
                    >
                      <Pen size={14} />
                    </button>
                    <button
                      onClick={() => setDrawMode('highlighter')}
                      className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${drawMode === 'highlighter' ? 'bg-slate-700 text-yellow-400 shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                      title="Fosforlu Kalem"
                    >
                      <Highlighter size={14} />
                    </button>
                    <button
                      onClick={() => setDrawMode('eraser')}
                      className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${drawMode === 'eraser' ? 'bg-slate-700 text-slate-200 shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                      title="Silgi"
                    >
                      <Eraser size={14} />
                    </button>
                    <div className="w-px h-4 bg-slate-700 mx-1"></div>
                    <button
                      onClick={() => setStylusOnly(!stylusOnly)}
                      className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${stylusOnly ? 'bg-blue-600/20 text-blue-400 shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                      title={stylusOnly ? "Avuç İçi Reddi (Açık) - Sadece Kalem" : "Avuç İçi Reddi (Kapalı) - Parmakla Çizilebilir"}
                    >
                      <Hand size={14} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <button 
                    onClick={() => {
                      const curIdx = currentScrollIndexRef.current || 0;
                      // FIX: Görünüm değişimi sırasında AYNI sayfada kal.
                      // Sıralama önemli: önce ref'i ve state'i yeni index'e ayarla,
                      // sonra twoPageView'i değiştir — Virtuoso re-mount olduğunda
                      // initialTopMostItemIndex doğru değeri okur.
                      if (twoPageView) {
                        // 2 sayfa → 1 sayfa: çift sayfa item index → tek sayfa item index
                        // Çift sayfa item'ı (curIdx) iki sayfa içerir: sol=curIdx*2+1, sağ=curIdx*2+2
                        // Sol sayfaya geç (kullanıcı solu görüyordu)
                        const newIdx = curIdx * 2;
                        currentScrollIndexRef.current = newIdx;
                        setLastSavedPage(newIdx);
                        setPendingReviewScroll(newIdx);
                        setTwoPageView(false);
                        // Re-mount sonrası ek garanti scroll
                        setTimeout(() => {
                          virtuosoRef.current?.scrollToIndex({ index: newIdx, behavior: 'auto' });
                        }, 100);
                      } else {
                        // 1 sayfa → 2 sayfa: tek sayfa item index → çift sayfa item index
                        // Hangi çift sayfa içinde olduğunu bul
                        const newIdx = Math.floor(curIdx / 2);
                        currentScrollIndexRef.current = newIdx;
                        setLastSavedPage(newIdx);
                        setPendingReviewScroll(newIdx);
                        setTwoPageView(true);
                        setTimeout(() => {
                          virtuosoRef.current?.scrollToIndex({ index: newIdx, behavior: 'auto' });
                        }, 100);
                      }
                    }} 
                    className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2 font-medium ${twoPageView ? 'bg-blue-600/20 text-blue-400' : 'hover:bg-slate-800'}`}
                  >
                    <span className="hidden sm:inline">{twoPageView ? 'Tek Sayfa' : 'İki Sayfa'}</span>
                    <span className="sm:hidden">{twoPageView ? '1' : '2'}</span>
                  </button>
                  {/* Zoom butonları */}
                  <div className="flex items-center gap-1 bg-slate-800 px-2 py-1 rounded-lg border border-slate-700">
                    <button onClick={handleZoomOut} className="text-slate-400 hover:text-white transition-colors" title="Uzaklaştır">
                      <ZoomOut size={15} />
                    </button>
                    <span className="text-xs text-slate-300 font-mono w-10 text-center">%{pdfZoom}</span>
                    <button onClick={handleZoomIn} className="text-slate-400 hover:text-white transition-colors" title="Yakınlaştır">
                      <ZoomIn size={15} />
                    </button>
                  </div>
                  {/* Bookmark butonu */}
                  <button
                    onClick={() => {
                      // FIX Bookmark page calc: twoPageView'da item index sayfa değil, çift sayfa
                      const scrollIdx = currentScrollIndexRef.current || 0;
                      const page = twoPageView ? scrollIdx * 2 + 1 : scrollIdx + 1;
                      const existing = bookmarks.find(b => b.page === page);
                      if (existing) {
                        setBookmarks(prev => prev.filter(b => b.page !== page));
                      } else {
                        setBookmarks(prev => [...prev, { id: uuidv4(), page, note: `Sayfa ${page}`, addedAt: Date.now() }]);
                      }
                    }}
                    className={`px-2 py-1.5 rounded-lg text-sm transition-colors ${(() => {
                      const scrollIdx = currentScrollIndexRef.current || 0;
                      const page = twoPageView ? scrollIdx * 2 + 1 : scrollIdx + 1;
                      return bookmarks.find(b => b.page === page)
                        ? 'text-yellow-400 bg-yellow-900/30' : 'text-slate-400 hover:bg-slate-800';
                    })()}`}
                    title="Sayfayı İşaretle"
                  >⭐</button>
                  {/* FIX: Okudum işareti — bu sayfayı okumuş olarak işaretle */}
                  <button
                    onClick={() => {
                      const scrollIdx = currentScrollIndexRef.current || 0;
                      const currentPage = twoPageView ? scrollIdx * 2 + 1 : scrollIdx + 1;
                      const secondPage = twoPageView ? scrollIdx * 2 + 2 : null;
                      setReadPages(prev => {
                        const next = new Set(prev);
                        const isRead = next.has(currentPage);
                        if (isRead) {
                          // Şu an işaretli — kaldırma: sadece "şu anki ve sonrası" değil, sadece bu sayfa ve sonrası
                          // (Kullanıcı isteği: "son okudum işaretlediğim sayfa kabul edilsin")
                          // Mantık: kullanıcı en son hangi sayfaya okudum dediyse ona kadar okunmuş say
                          // Yani kaldırma durumunda bu sayfadan sonrası silinir
                          for (const p of Array.from(next)) {
                            if (p >= currentPage) next.delete(p);
                          }
                        } else {
                          // Işaretleme: bu sayfa DAHIL ÖNCESİ hepsini okunmuş say
                          for (let p = 1; p <= currentPage; p++) next.add(p);
                          if (secondPage) next.add(secondPage);
                        }
                        return next;
                      });
                    }}
                    className={`px-2 py-1.5 rounded-lg text-sm transition-colors ${(() => {
                      const scrollIdx = currentScrollIndexRef.current || 0;
                      const page = twoPageView ? scrollIdx * 2 + 1 : scrollIdx + 1;
                      return readPages.has(page)
                        ? 'text-emerald-400 bg-emerald-900/30' : 'text-slate-400 hover:bg-slate-800';
                    })()}`}
                    title="Buraya Kadar Okudum (bu sayfa ve öncesi okunmuş sayılır)"
                  >✓</button>
                  {/* PDF Tema cycle: normal → dark → sepia → normal */}
                  <button
                    onClick={() => setPdfTheme(prev => prev === 'normal' ? 'dark' : (prev === 'dark' ? 'sepia' : 'normal'))}
                    className={`px-2 py-1.5 rounded-lg text-sm transition-colors ${pdfTheme === 'dark' ? 'text-amber-400 bg-amber-900/30' : (pdfTheme === 'sepia' ? 'text-orange-300 bg-orange-900/30' : 'text-slate-400 hover:bg-slate-800')}`}
                    title={pdfTheme === 'normal' ? 'Karanlık Mod' : (pdfTheme === 'dark' ? 'Sepya Mod (göz dostu)' : 'Normal (aydınlık)')}
                  >{pdfTheme === 'normal' ? '🌙' : (pdfTheme === 'dark' ? '📜' : '☀️')}</button>
                  {/* Kontrol kilidi — sadece okuma modu */}
                  <button
                    onClick={() => {
                      setReadOnlyLock(prev => !prev);
                      if (!readOnlyLock) {
                        // Kilit açılırken tüm araçları kapat
                        setIsCropMode(false); setIsHighlightMode(false); setIsNoteCropMode(false);
                        setDrawMode('none');
                      }
                    }}
                    className={`px-2 py-1.5 rounded-lg text-sm transition-colors ${readOnlyLock ? 'text-blue-400 bg-blue-900/30' : 'text-slate-400 hover:bg-slate-800'}`}
                    title={readOnlyLock ? "Kilit Açık — sadece okuma" : "Okuma Kilidi (yanlış araç açılmasın)"}
                  >{readOnlyLock ? '🔒' : '🔓'}</button>
                  {/* Odak / Okuma Modu — toolbar ve navigasyonu gizler */}
                  <button
                    onClick={() => setFocusMode(prev => !prev)}
                    className={`px-2 py-1.5 rounded-lg text-sm transition-colors ${focusMode ? 'text-green-400 bg-green-900/30' : 'text-slate-400 hover:bg-slate-800'}`}
                    title={focusMode ? "Odak Modunu Kapat" : "Odak Modu (sadece PDF)"}
                  >{focusMode ? '👁️' : '🎯'}</button>
                  {/* Sayfa Hedefi — tıkla ayarla */}
                  <button
                    onClick={() => {
                      const curr = pageGoal;
                      const input = window.prompt('Bu oturumda kaç sayfa okumak istiyorsun?\n(0 = hedef yok)', curr.toString());
                      if (input !== null) {
                        const n = parseInt(input);
                        if (!isNaN(n) && n >= 0) {
                          setPageGoal(n);
                          sessionStartPageRef.current = null;
                          setPagesRead(0);
                          maxPageReachedRef.current = 0;
                        }
                      }
                    }}
                    className={`px-2 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 ${pageGoal > 0 ? 'text-amber-400 bg-amber-900/20' : 'text-slate-400 hover:bg-slate-800'}`}
                    title="Sayfa Hedefi"
                  >
                    🎯
                    {pageGoal > 0 && (
                      <span className="tabular-nums">{pagesRead}/{pageGoal}</span>
                    )}
                  </button>
                  {bookmarks.length > 0 && (
                    <button
                      onClick={() => setShowBookmarks(prev => !prev)}
                      className="px-2 py-1.5 rounded-lg text-sm text-slate-400 hover:bg-slate-800 transition-colors"
                      title="Bookmarklar"
                    >📑<span className="text-xs font-bold text-yellow-400 ml-1">{bookmarks.length}</span></button>
                  )}
                  <div className="flex items-center gap-1 sm:gap-2 bg-slate-800 p-1 sm:px-2 rounded-lg border border-slate-700 mr-2">
                    <button 
                      onClick={() => {
                        const currentUrl = pdfUrl;
                        setPdfUrl(null);
                        setTimeout(() => setPdfUrl(currentUrl), 50);
                      }} 
                      className="p-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded-md transition-colors" 
                      title="PDF'i Yenile"
                    >
                      <RefreshCw size={16} />
                    </button>
                    {pdfMarks.length > 0 && (
                      <button
                        onClick={() => {
                          if (window.confirm(`Bu PDF'deki ${pdfMarks.length} işareti silmek istediğinize emin misiniz?`)) {
                            setPdfMarks([]);
                          }
                        }}
                        className="p-1 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-md transition-colors"
                        title={`${pdfMarks.length} işareti temizle`}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                  <button onClick={toggleFullscreen} className="px-3 py-1.5 hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-2 font-medium">
                    {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                    <span className="hidden sm:inline">{isFullscreen ? 'Küçült' : 'Tam Ekran'}</span>
                  </button>
                </div>
              </div>
              
              <div className="flex-1 w-full relative flex flex-col min-h-0 bg-slate-950/50" style={{ WebkitOverflowScrolling: 'touch' }}>
                <Document
                  key={pdfUrl || 'empty'}
                  file={pdfUrl}
                  options={pdfOptions}
                  onLoadSuccess={({ numPages }) => {
                    setNumPages(numPages);
                    setPdfError(null);
                    console.log("PDF loaded successfully with", numPages, "pages");
                  }}
                  onLoadError={(error) => {
                    console.error("Error while loading document! " + error.message);
                    setPdfError(error.message);
                  }}
                  onSourceError={(error) => {
                    console.error("Source error! " + error.message);
                    setPdfError("PDF kaynağı bulunamadı veya erişilemez durumda.");
                  }}
                  loading={
                    <div className="flex flex-col items-center justify-center h-64 text-slate-500 w-full">
                      <RefreshCw className="animate-spin mb-4" size={32} />
                      <p>PDF Yükleniyor...</p>
                    </div>
                  }
                  error={
                    <div className="flex flex-col items-center justify-center h-64 text-red-500 bg-red-500/10 rounded-xl p-6 text-center w-full max-w-md mx-auto mt-10">
                      <XCircle className="mb-4" size={48} />
                      <p className="font-bold text-lg mb-2">PDF Yüklenemedi</p>
                      <p className="text-sm opacity-80">{pdfError || "Bilinmeyen bir hata oluştu."}</p>
                      <p className="text-xs mt-4 opacity-60">Lütfen farklı bir PDF dosyası deneyin veya sayfayı yenileyin.</p>
                    </div>
                  }
                  className="w-full flex-1 min-h-0 flex flex-col"
                >
                  {numPages && (
                    <Virtuoso
                      ref={virtuosoRef}
                      initialTopMostItemIndex={pendingReviewScroll !== null ? pendingReviewScroll : currentScrollIndexRef.current}
                      rangeChanged={(range) => {
                        currentScrollIndexRef.current = range.startIndex;
                        // FIX #1b: pendingReviewScroll'u SADECE hedefe ulaşınca sıfırla.
                        // Virtuoso bazen ara index'lerden geçer, hemen sıfırlarsak hedefe varmaz.
                        if (pendingReviewScroll !== null && range.startIndex === pendingReviewScroll) {
                          setPendingReviewScroll(null);
                        }
                        // FIX: Scroll pozisyonunu state'e debounced yaz — auto-save tetiklensin
                        if (scrollSaveTimeoutRef.current) clearTimeout(scrollSaveTimeoutRef.current);
                        scrollSaveTimeoutRef.current = window.setTimeout(() => {
                          setLastSavedPage(range.startIndex);
                        }, 800);
                        // FIX: Sayfa hedefi — bu session'da okunan sayfa sayısını takip et
                        if (pageGoal > 0 && numPages) {
                          const currentPage = twoPageView ? (range.startIndex * 2) + 1 : range.startIndex + 1;
                          if (sessionStartPageRef.current === null) {
                            sessionStartPageRef.current = currentPage;
                            maxPageReachedRef.current = currentPage;
                          } else if (currentPage > maxPageReachedRef.current) {
                            maxPageReachedRef.current = currentPage;
                            const read = maxPageReachedRef.current - sessionStartPageRef.current;
                            setPagesRead(Math.max(0, read));
                          }
                        }
                        // FIX: PDF tamamlanma — en yüksek sayfa
                        if (numPages) {
                          const currentPage = twoPageView ? Math.min(numPages, (range.startIndex * 2) + 2) : range.startIndex + 1;
                          setMaxPageViewed(prev => Math.max(prev, currentPage));

                          // FIX: 5 saniye otomatik "okudum" — sayfa değişince önceki sayfanın durma süresine bak
                          const now = Date.now();
                          const dwell = dwellStartRef.current;
                          if (dwell && dwell.page !== currentPage) {
                            const elapsed = now - dwell.start;
                            if (elapsed >= 5000) {
                              // 5 saniyeden fazla durulmuş — okunmuş say
                              setReadPages(prev => {
                                if (prev.has(dwell.page)) return prev;
                                const next = new Set(prev);
                                next.add(dwell.page);
                                return next;
                              });
                            }
                          }
                          dwellStartRef.current = { page: currentPage, start: now };
                        }
                        setIsScrolling(true);
                        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
                        scrollTimeoutRef.current = setTimeout(() => setIsScrolling(false), 150);
                      }}
                      style={{ height: '100%', width: '100%', overflowX: 'auto', overflowY: 'auto', touchAction: 'pan-x pan-y pinch-zoom' }}
                      totalCount={twoPageView ? Math.ceil(numPages / 2) : numPages}
                      overscan={{ main: 800, reverse: 400 }}
                      increaseViewportBy={{ top: 300, bottom: 300 }}
                      components={{
                        Footer: () => <div className="h-32 w-full" />
                      }}
                      itemContent={(index) => {
                        if (twoPageView) {
                          const p1 = index * 2 + 1;
                          const p2 = index * 2 + 2;
                          return (
                            <div className="w-full flex justify-center py-4 px-2 sm:px-4 min-w-max">
                              <div className="flex bg-white shadow-2xl ring-1 ring-slate-800/50">
                                <div 
                                  className="relative inline-block border-r border-slate-300" 
                                  onClick={(e) => handlePageClick(e, p1, isReview)}
                                  onPointerDown={(e) => {
                                    if (activeMarkTool === 'rect') { handleRectPointerDown(e, p1); return; }
                                    if (drawMode !== 'none') {
                                      if (stylusOnly && e.pointerType === 'touch') return;
                                      e.stopPropagation();
                                      if (e.pointerType === 'pen') e.preventDefault();
                                      handleDrawPointerDown(e, p1);
                                    }
                                  }}
                                  onPointerMove={(e) => {
                                    if (rectDrawState) { handleRectPointerMove(e); return; }
                                    if (drawMode !== 'none') {
                                      if (stylusOnly && e.pointerType === 'touch') return;
                                      if (e.pointerType === 'pen') e.preventDefault();
                                      handleDrawPointerMove(e, p1);
                                    }
                                  }}
                                  onPointerUp={(e) => { if (rectDrawState) { handleRectPointerUp(e); return; } handleDrawPointerUp(e); }}
                                  onPointerCancel={handleDrawPointerUp}
                                >
                                  <Page 
                                    pageNumber={p1} 
                                    scale={pdfZoom / 100} 
                                    devicePixelRatio={OPTIMAL_DPR}
                                    className=""
                                    renderTextLayer={false}
                                    renderAnnotationLayer={false}
                                    loading={
                                      <div className="w-full max-w-[800px] aspect-[1/1.4] bg-slate-800/20 animate-pulse flex items-center justify-center text-slate-500">
                                        Sayfa {p1} Yükleniyor...
                                      </div>
                                    }
                                  />
                                  {renderDrawingOverlay(p1)}
                                  {isCropMode && (
                                    <div 
                                      className="absolute inset-0 z-40 cursor-crosshair touch-none"
                                      onPointerDown={(e) => handleCropStart(e, p1)}
                                      onPointerMove={handleCropMove}
                                      onPointerUp={handleCropEnd}
                                    >
                                      {cropState && cropState.page === p1 && (
                                        <div 
                                          className="absolute border-2 border-blue-500 bg-blue-500/20"
                                          style={{
                                            left: `${Math.min(cropState.startX, cropState.currentX)}%`,
                                            top: `${Math.min(cropState.startY, cropState.currentY)}%`,
                                            width: `${Math.abs(cropState.currentX - cropState.startX)}%`,
                                            height: `${Math.abs(cropState.currentY - cropState.startY)}%`
                                          }}
                                        />
                                      )}
                                    </div>
                                  )}
                                  {isNoteCropMode && (
                                    <div
                                      className="absolute inset-0 z-40 cursor-crosshair touch-none"
                                      style={{cursor: 'cell'}}
                                      onPointerDown={(e) => handleNoteCropStart(e, p1)}
                                      onPointerMove={handleNoteCropMove}
                                      onPointerUp={handleNoteCropEnd}
                                    >
                                      {noteCropState && noteCropState.page === p1 && (
                                        <div
                                          className="absolute" style={{border:"2px dashed rgba(34,197,94,0.9)",background:"transparent",borderRadius:2, 
                                            left: `${Math.min(noteCropState.startX, noteCropState.currentX)}%`,
                                            top: `${Math.min(noteCropState.startY, noteCropState.currentY)}%`,
                                            width: `${Math.abs(noteCropState.currentX - noteCropState.startX)}%`,
                                            height: `${Math.abs(noteCropState.currentY - noteCropState.startY)}%`,
                                            boxShadow: '0 0 0 1px rgba(34,197,94,0.4)'
                                          }}
                                        />
                                      )}
                                    </div>
                                  )}
                                  {/* Kaydedilen notların PDF üzerindeki yeşil alanı */}
                                  {(notesByPage.get(p1) || []).map(n => (
                                    <div key={n.id}
                                      className="absolute pointer-events-none z-30" style={{border:"2px dashed rgba(34,197,94,0.8)",borderRadius:2,background:"transparent",  left:`${n.rect!.x}%`, top:`${n.rect!.y}%`, width:`${n.rect!.width}%`, height:`${n.rect!.height}%` }}
                                      title={n.title || 'Önemli Not'}
                                    >
                                      <span className="absolute -top-4 right-0 bg-green-500 text-white text-[9px] px-1 rounded flex items-center gap-0.5"><StickyNote size={9}/>{n.title ? n.title.substring(0,12) : 'Not'}</span>
                                    </div>
                                  ))}
                                  {isHighlightMode && (
                                    <div 
                                      className="absolute inset-0 z-40 cursor-crosshair touch-none"
                                      onPointerDown={(e) => handleHighlightStart(e, p1)}
                                      onPointerMove={handleHighlightMove}
                                      onPointerUp={handleHighlightEnd}
                                      onPointerCancel={handleHighlightEnd}
                                    >
                                      {highlightState && highlightState.page === p1 && (
                                        <svg
                                          className="absolute inset-0 w-full h-full z-30 mix-blend-multiply pointer-events-none"
                                          viewBox="0 0 100 100"
                                          preserveAspectRatio="none"
                                        >
                                          <polyline
                                            points={highlightState.points.map(p => `${p.x},${p.y}`).join(' ')}
                                            fill="none"
                                            stroke="rgba(253, 224, 71, 0.6)"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                          />
                                        </svg>
                                      )}
                                    </div>
                                  )}
                                  {(questionsByPage.get(p1) || []).map(q => (
                                    <div
                                      key={q.id}
                                      className="absolute z-20 border-4 border-dashed border-red-500/80 bg-red-500/20 pointer-events-none rounded-md shadow-[0_0_15px_rgba(239,68,68,0.5)]"
                                      style={{
                                        left: `${q.rect!.x}%`,
                                        top: `${q.rect!.y}%`,
                                        width: `${q.rect!.width}%`,
                                        height: `${q.rect!.height}%`
                                      }}
                                    >
                                      <div className="absolute -top-10 -right-2 bg-red-600 text-white text-sm font-bold px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
                                        <Crop size={16} /> Kesilmiş Soru
                                      </div>
                                    </div>
                                  ))}
                                  {(marksByPage.get(p1) || []).map(mark => (
                                    mark.color === 'yellow' ? (
                                      mark.points ? (
                                        <svg
                                          key={mark.id}
                                          className="absolute inset-0 w-full h-full z-30 mix-blend-multiply pointer-events-none"
                                          viewBox="0 0 100 100"
                                          preserveAspectRatio="none"
                                        >
                                          <polyline
                                            points={mark.points.map(p => `${p.x},${p.y}`).join(' ')}
                                            fill="none"
                                            stroke="rgba(253, 224, 71, 0.6)"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            className="pointer-events-auto cursor-pointer hover:stroke-yellow-500 transition-colors"
                                            onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                          />
                                        </svg>
                                      ) : (
                                        <div
                                          key={mark.id}
                                          onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                          className="absolute bg-yellow-300/40 cursor-pointer z-30 hover:bg-yellow-400/50 transition-colors mix-blend-multiply"
                                          style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: `${mark.width}%`, height: `${mark.height}%` }}
                                          title="Vurguyu kaldır"
                                        />
                                      )
                                    ) : mark.markType === 'cross' ? (
                                      <div
                                        key={mark.id}
                                        onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                        className="absolute cursor-pointer transform -translate-x-1/2 -translate-y-1/2 z-50 flex items-center justify-center text-red-500 drop-shadow-md"
                                        style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))), height: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))) }}
                                        title="İşareti kaldır"
                                      >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
                                          <line x1="18" y1="6" x2="6" y2="18"></line>
                                          <line x1="6" y1="6" x2="18" y2="18"></line>
                                        </svg>
                                      </div>
                                    ) : mark.markType === 'tick' ? (
                                      <div
                                        key={mark.id}
                                        onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                        className="absolute cursor-pointer transform -translate-x-1/2 -translate-y-1/2 z-50 flex items-center justify-center text-emerald-500 drop-shadow-md"
                                        style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))), height: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))) }}
                                        title="İşareti kaldır"
                                      >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
                                          <polyline points="20 6 9 17 4 12"></polyline>
                                        </svg>
                                      </div>
                                    ) : mark.markType === 'rect' ? (
                                      <div
                                        key={mark.id}
                                        onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                        className="absolute cursor-pointer z-40 border-2 border-blue-400 rounded-sm"
                                        style={{ 
                                          left: `${mark.x}%`, top: `${mark.y}%`, 
                                          width: `${mark.width || 10}%`, height: `${mark.height || 8}%`,
                                          background: 'rgba(59,130,246,0.08)'
                                        }}
                                        title="Çerçeveyi kaldır"
                                      />
                                    ) : (
                                      <div
                                        key={mark.id}
                                        onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                        className={`absolute rounded-full cursor-pointer transform -translate-x-1/2 -translate-y-1/2 border-2 border-white shadow-md z-50 ${mark.color === 'green' ? 'bg-emerald-500/90 hover:bg-emerald-600' : 'bg-red-500/90 hover:bg-red-600'}`}
                                        style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: Math.round(Math.max(8, Math.min(28, 14 * (pdfZoom / 100)))), height: Math.round(Math.max(8, Math.min(28, 14 * (pdfZoom / 100)))) }}
                                        title="İşareti kaldır"
                                      />
                                    )
                                  ))}
                                  {/* FIX Bookmark: Sayfa üzerinde yıldız göster */}
                                  {bookmarks.find(b => b.page === p1) && (
                                    <div
                                      className="absolute top-1 right-1 z-50 pointer-events-none"
                                      title={`Bookmark: ${bookmarks.find(b => b.page === p1)?.note}`}
                                    >
                                      <span className="text-yellow-400 drop-shadow-md text-lg leading-none">⭐</span>
                                    </div>
                                  )}
                                </div>
                                {p2 <= numPages && (
                                  <div 
                                    className="relative inline-block" 
                                    onClick={(e) => handlePageClick(e, p2, isReview)}
                                    onPointerDown={(e) => {
                                      if (drawMode !== 'none') {
                                        if (stylusOnly && e.pointerType === 'touch') return;
                                        e.stopPropagation();
                                        if (e.pointerType === 'pen') e.preventDefault();
                                        handleDrawPointerDown(e, p2);
                                      }
                                    }}
                                    onPointerMove={(e) => {
                                      if (drawMode !== 'none') {
                                        if (stylusOnly && e.pointerType === 'touch') return;
                                        if (e.pointerType === 'pen') e.preventDefault();
                                        handleDrawPointerMove(e, p2);
                                      }
                                    }}
                                    onPointerUp={handleDrawPointerUp}
                                    onPointerCancel={handleDrawPointerUp}
                                  >
                                    <Page 
                                      pageNumber={p2} 
                                      scale={pdfZoom / 100} 
                                      devicePixelRatio={OPTIMAL_DPR}
                                      className=""
                                      renderTextLayer={false}
                                      renderAnnotationLayer={false}
                                      loading={
                                        <div className="w-full max-w-[800px] aspect-[1/1.4] bg-slate-800/20 animate-pulse flex items-center justify-center text-slate-500">
                                          Sayfa {p2} Yükleniyor...
                                        </div>
                                      }
                                    />
                                    {renderDrawingOverlay(p2)}
                                    {isCropMode && (
                                      <div 
                                        className="absolute inset-0 z-40 cursor-crosshair touch-none"
                                        onPointerDown={(e) => handleCropStart(e, p2)}
                                        onPointerMove={handleCropMove}
                                        onPointerUp={handleCropEnd}
                                      >
                                        {cropState && cropState.page === p2 && (
                                          <div 
                                            className="absolute border-2 border-blue-500 bg-blue-500/20"
                                            style={{
                                              left: `${Math.min(cropState.startX, cropState.currentX)}%`,
                                              top: `${Math.min(cropState.startY, cropState.currentY)}%`,
                                              width: `${Math.abs(cropState.currentX - cropState.startX)}%`,
                                              height: `${Math.abs(cropState.currentY - cropState.startY)}%`,
                                            }}
                                          />
                                        )}
                                      </div>
                                    )}
                                    {isNoteCropMode && (
                                      <div
                                        className="absolute inset-0 z-40 touch-none"
                                        style={{cursor:'cell'}}
                                        onPointerDown={(e) => handleNoteCropStart(e, p2)}
                                        onPointerMove={handleNoteCropMove}
                                        onPointerUp={handleNoteCropEnd}
                                      >
                                        {noteCropState && noteCropState.page === p2 && (
                                          <div className="absolute" style={{border:"2px dashed rgba(34,197,94,0.9)",background:"transparent",borderRadius:2, 
                                              left:`${Math.min(noteCropState.startX,noteCropState.currentX)}%`,
                                              top:`${Math.min(noteCropState.startY,noteCropState.currentY)}%`,
                                              width:`${Math.abs(noteCropState.currentX-noteCropState.startX)}%`,
                                              height:`${Math.abs(noteCropState.currentY-noteCropState.startY)}%`
                                            }}
                                          />
                                        )}
                                      </div>
                                    )}
                                    {(notesByPage.get(p2) || []).map(n => (
                                      <div key={n.id+"p2"} className="absolute pointer-events-none z-30" style={{border:"2px dashed rgba(34,197,94,0.8)",borderRadius:2,background:"transparent", left:`${n.rect!.x}%`,top:`${n.rect!.y}%`,width:`${n.rect!.width}%`,height:`${n.rect!.height}%`}}
                                      >
                                        <span className="absolute -top-4 right-0 bg-green-500 text-white text-[9px] px-1 rounded">{n.title || 'Not'}</span>
                                      </div>
                                    ))}
                                    {isHighlightMode && (
                                      <div 
                                        className="absolute inset-0 z-40 cursor-crosshair touch-none"
                                        onPointerDown={(e) => handleHighlightStart(e, p2)}
                                        onPointerMove={handleHighlightMove}
                                        onPointerUp={handleHighlightEnd}
                                        onPointerCancel={handleHighlightEnd}
                                      >
                                        {highlightState && highlightState.page === p2 && (
                                          <svg
                                            className="absolute inset-0 w-full h-full z-30 mix-blend-multiply pointer-events-none"
                                            viewBox="0 0 100 100"
                                            preserveAspectRatio="none"
                                          >
                                            <polyline
                                              points={highlightState.points.map(p => `${p.x},${p.y}`).join(' ')}
                                              fill="none"
                                              stroke="rgba(253, 224, 71, 0.6)"
                                              strokeWidth="1.5"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                            />
                                          </svg>
                                        )}
                                      </div>
                                    )}
                                    {(questionsByPage.get(p2) || []).map(q => (
                                      <div
                                        key={q.id}
                                        className="absolute z-20 border-4 border-dashed border-red-500/80 bg-red-500/20 pointer-events-none rounded-md shadow-[0_0_15px_rgba(239,68,68,0.5)]"
                                        style={{
                                          left: `${q.rect!.x}%`,
                                          top: `${q.rect!.y}%`,
                                          width: `${q.rect!.width}%`,
                                          height: `${q.rect!.height}%`
                                        }}
                                      >
                                        <div className="absolute -top-10 -right-2 bg-red-600 text-white text-sm font-bold px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
                                          <Crop size={16} /> Kesilmiş Soru
                                        </div>
                                      </div>
                                    ))}
                                    {(marksByPage.get(p2) || []).map(mark => (
                                      mark.color === 'yellow' ? (
                                        mark.points ? (
                                          <svg
                                            key={mark.id}
                                            className="absolute inset-0 w-full h-full z-30 mix-blend-multiply pointer-events-none"
                                            viewBox="0 0 100 100"
                                            preserveAspectRatio="none"
                                          >
                                            <polyline
                                              points={mark.points.map(p => `${p.x},${p.y}`).join(' ')}
                                              fill="none"
                                              stroke="rgba(253, 224, 71, 0.6)"
                                              strokeWidth="1.5"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              className="pointer-events-auto cursor-pointer hover:stroke-yellow-500 transition-colors"
                                              onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                            />
                                          </svg>
                                        ) : (
                                          <div
                                            key={mark.id}
                                            onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                            className="absolute bg-yellow-300/40 cursor-pointer z-30 hover:bg-yellow-400/50 transition-colors mix-blend-multiply"
                                            style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: `${mark.width}%`, height: `${mark.height}%` }}
                                            title="Vurguyu kaldır"
                                          />
                                        )
                                      ) : mark.markType === 'cross' ? (
                                        <div
                                          key={mark.id}
                                          onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                          className="absolute cursor-pointer transform -translate-x-1/2 -translate-y-1/2 z-50 flex items-center justify-center text-red-500 drop-shadow-md"
                                          style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))), height: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))) }}
                                          title="İşareti kaldır"
                                        >
                                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
                                            <line x1="18" y1="6" x2="6" y2="18"></line>
                                            <line x1="6" y1="6" x2="18" y2="18"></line>
                                          </svg>
                                        </div>
                                      ) : mark.markType === 'tick' ? (
                                        <div
                                          key={mark.id}
                                          onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                          className="absolute cursor-pointer transform -translate-x-1/2 -translate-y-1/2 z-50 flex items-center justify-center text-emerald-500 drop-shadow-md"
                                          style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))), height: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))) }}
                                          title="İşareti kaldır"
                                        >
                                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
                                            <polyline points="20 6 9 17 4 12"></polyline>
                                          </svg>
                                        </div>
                                      ) : mark.markType === 'rect' ? (
                                          <div
                                            key={mark.id}
                                            onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                            className="absolute cursor-pointer z-40 border-2 border-blue-400 rounded-sm"
                                            style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: `${mark.width || 10}%`, height: `${mark.height || 8}%`, background: 'rgba(59,130,246,0.08)' }}
                                            title="Çerçeveyi kaldır"
                                          />
                                        ) : (
                                          <div
                                            key={mark.id}
                                            onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                            className={`absolute rounded-full cursor-pointer transform -translate-x-1/2 -translate-y-1/2 border-2 border-white shadow-md z-50 ${mark.color === 'green' ? 'bg-emerald-500/90 hover:bg-emerald-600' : 'bg-red-500/90 hover:bg-red-600'}`}
                                            style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: Math.round(Math.max(8, Math.min(28, 14 * (pdfZoom / 100)))), height: Math.round(Math.max(8, Math.min(28, 14 * (pdfZoom / 100)))) }}
                                            title="İşareti kaldır"
                                          />
                                        )
                                      ))}
                                  {/* FIX Bookmark p2: Sayfa üzerinde yıldız göster */}
                                  {bookmarks.find(b => b.page === p2) && (
                                    <div className="absolute top-1 right-1 z-50 pointer-events-none">
                                      <span className="text-yellow-400 drop-shadow-md text-lg leading-none">⭐</span>
                                    </div>
                                  )}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div className="w-full flex justify-center py-4 px-2 sm:px-4 min-w-max">
                            <div 
                              className="relative inline-block bg-white shadow-2xl ring-1 ring-slate-800/50" 
                              onClick={(e) => handlePageClick(e, index + 1, isReview)}
                              onPointerDown={(e) => {
                                if (activeMarkTool === 'rect') { handleRectPointerDown(e, index + 1); return; }
                                if (drawMode !== 'none') {
                                  if (stylusOnly && e.pointerType === 'touch') return;
                                  e.stopPropagation();
                                  if (e.pointerType === 'pen') e.preventDefault();
                                  handleDrawPointerDown(e, index + 1);
                                }
                              }}
                              onPointerMove={(e) => {
                                if (rectDrawState) { handleRectPointerMove(e); return; }
                                if (drawMode !== 'none') {
                                  if (stylusOnly && e.pointerType === 'touch') return;
                                  if (e.pointerType === 'pen') e.preventDefault();
                                  handleDrawPointerMove(e, index + 1);
                                }
                              }}
                              onPointerUp={(e) => { if (rectDrawState) { handleRectPointerUp(e); return; } handleDrawPointerUp(e); }}
                              onPointerCancel={handleDrawPointerUp}
                            >
                              <Page 
                                pageNumber={index + 1} 
                                scale={pdfZoom / 100} 
                                devicePixelRatio={OPTIMAL_DPR}
                                className=""
                                renderTextLayer={false}
                                renderAnnotationLayer={false}
                                loading={
                                  <div className="w-full max-w-[800px] aspect-[1/1.4] bg-slate-800/20 animate-pulse flex items-center justify-center text-slate-500">
                                    Sayfa {index + 1} Yükleniyor...
                                  </div>
                                }
                              />
                              {renderDrawingOverlay(index + 1)}
                              {isCropMode && (
                                <div 
                                  className="absolute inset-0 z-40 cursor-crosshair touch-none"
                                  onPointerDown={(e) => handleCropStart(e, index + 1)}
                                  onPointerMove={handleCropMove}
                                  onPointerUp={handleCropEnd}
                                >
                                  {cropState && cropState.page === index + 1 && (
                                    <div 
                                      className="absolute border-2 border-blue-500 bg-blue-500/20"
                                      style={{
                                        left: `${Math.min(cropState.startX, cropState.currentX)}%`,
                                        top: `${Math.min(cropState.startY, cropState.currentY)}%`,
                                        width: `${Math.abs(cropState.currentX - cropState.startX)}%`,
                                        height: `${Math.abs(cropState.currentY - cropState.startY)}%`,
                                      }}
                                    />
                                  )}
                                </div>
                              )}
                              {isNoteCropMode && (
                                <div
                                  className="absolute inset-0 z-40 touch-none"
                                  style={{cursor:'cell'}}
                                  onPointerDown={(e) => handleNoteCropStart(e, index + 1)}
                                  onPointerMove={handleNoteCropMove}
                                  onPointerUp={handleNoteCropEnd}
                                >
                                  {noteCropState && noteCropState.page === index + 1 && (
                                    <div className="absolute" style={{border:"2px dashed rgba(34,197,94,0.9)",background:"transparent",borderRadius:2, 
                                        left:`${Math.min(noteCropState.startX,noteCropState.currentX)}%`,
                                        top:`${Math.min(noteCropState.startY,noteCropState.currentY)}%`,
                                        width:`${Math.abs(noteCropState.currentX-noteCropState.startX)}%`,
                                        height:`${Math.abs(noteCropState.currentY-noteCropState.startY)}%`
                                      }}
                                    />
                                  )}
                                </div>
                              )}
                              {(notesByPage.get(index + 1) || []).map(n => (
                                <div key={n.id+"s"} className="absolute pointer-events-none z-30" style={{border:"2px dashed rgba(34,197,94,0.8)",borderRadius:2,background:"transparent", left:`${n.rect!.x}%`,top:`${n.rect!.y}%`,width:`${n.rect!.width}%`,height:`${n.rect!.height}%`}}
                                >
                                  <span className="absolute -top-4 right-0 bg-green-500 text-white text-[9px] px-1 rounded">{n.title || 'Not'}</span>
                                </div>
                              ))}
                              {isHighlightMode && (
                                <div 
                                  className="absolute inset-0 z-40 cursor-crosshair touch-none"
                                  onPointerDown={(e) => handleHighlightStart(e, index + 1)}
                                  onPointerMove={handleHighlightMove}
                                  onPointerUp={handleHighlightEnd}
                                  onPointerCancel={handleHighlightEnd}
                                >
                                  {highlightState && highlightState.page === index + 1 && (
                                    <svg
                                      className="absolute inset-0 w-full h-full z-30 mix-blend-multiply pointer-events-none"
                                      viewBox="0 0 100 100"
                                      preserveAspectRatio="none"
                                    >
                                      <polyline
                                        points={highlightState.points.map(p => `${p.x},${p.y}`).join(' ')}
                                        fill="none"
                                        stroke="rgba(253, 224, 71, 0.6)"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  )}
                                </div>
                              )}
                              {(questionsByPage.get(index + 1) || []).map(q => (
                                <div
                                  key={q.id}
                                  className="absolute z-20 border-4 border-dashed border-red-500/80 bg-red-500/20 pointer-events-none rounded-md shadow-[0_0_15px_rgba(239,68,68,0.5)]"
                                  style={{
                                    left: `${q.rect!.x}%`,
                                    top: `${q.rect!.y}%`,
                                    width: `${q.rect!.width}%`,
                                    height: `${q.rect!.height}%`
                                  }}
                                >
                                  <div className="absolute -top-10 -right-2 bg-red-600 text-white text-sm font-bold px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
                                    <Crop size={16} /> Kesilmiş Soru
                                  </div>
                                </div>
                              ))}
                              {(marksByPage.get(index + 1) || []).map(mark => (
                                mark.color === 'yellow' ? (
                                  mark.points ? (
                                    <svg
                                      key={mark.id}
                                      className="absolute inset-0 w-full h-full z-30 mix-blend-multiply pointer-events-none"
                                      viewBox="0 0 100 100"
                                      preserveAspectRatio="none"
                                    >
                                      <polyline
                                        points={mark.points.map(p => `${p.x},${p.y}`).join(' ')}
                                        fill="none"
                                        stroke="rgba(253, 224, 71, 0.6)"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className="pointer-events-auto cursor-pointer hover:stroke-yellow-500 transition-colors"
                                        onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                      />
                                    </svg>
                                  ) : (
                                    <div
                                      key={mark.id}
                                      onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                      className="absolute bg-yellow-300/40 cursor-pointer z-30 hover:bg-yellow-400/50 transition-colors mix-blend-multiply"
                                      style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: `${mark.width}%`, height: `${mark.height}%` }}
                                      title="Vurguyu kaldır"
                                    />
                                  )
                                ) : mark.markType === 'cross' ? (
                                  <div
                                    key={mark.id}
                                    onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                    className="absolute cursor-pointer transform -translate-x-1/2 -translate-y-1/2 z-50 flex items-center justify-center text-red-500 drop-shadow-md"
                                    style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))), height: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))) }}
                                    title="İşareti kaldır"
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
                                      <line x1="18" y1="6" x2="6" y2="18"></line>
                                      <line x1="6" y1="6" x2="18" y2="18"></line>
                                    </svg>
                                  </div>
                                ) : mark.markType === 'tick' ? (
                                  <div
                                    key={mark.id}
                                    onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                    className="absolute cursor-pointer transform -translate-x-1/2 -translate-y-1/2 z-50 flex items-center justify-center text-emerald-500 drop-shadow-md"
                                    style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))), height: Math.round(Math.max(10, Math.min(36, 18 * (pdfZoom / 100)))) }}
                                    title="İşareti kaldır"
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
                                      <polyline points="20 6 9 17 4 12"></polyline>
                                    </svg>
                                  </div>
                                ) : mark.markType === 'rect' ? (
                                  <div
                                    key={mark.id}
                                    onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                    className="absolute cursor-pointer z-40 border-2 border-blue-400 rounded-sm"
                                    style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: `${mark.width || 10}%`, height: `${mark.height || 8}%`, background: 'rgba(59,130,246,0.08)' }}
                                    title="Çerçeveyi kaldır"
                                  />
                                ) : (
                                  <div
                                    key={mark.id}
                                    onClick={(e) => handleMarkClick(mark.id, e, isReview)}
                                    className={`absolute rounded-full cursor-pointer transform -translate-x-1/2 -translate-y-1/2 border-2 border-white shadow-md z-50 ${mark.color === 'green' ? 'bg-emerald-500/90 hover:bg-emerald-600' : 'bg-red-500/90 hover:bg-red-600'}`}
                                    style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: Math.round(Math.max(8, Math.min(28, 14 * (pdfZoom / 100)))), height: Math.round(Math.max(8, Math.min(28, 14 * (pdfZoom / 100)))) }}
                                    title="İşareti kaldır"
                                  />
                                )
                              ))}
                              {/* FIX Bookmark single-page: Sayfa üzerinde yıldız göster */}
                              {bookmarks.find(b => b.page === index + 1) && (
                                <div className="absolute top-1 right-1 z-50 pointer-events-none">
                                  <span className="text-yellow-400 drop-shadow-md text-lg leading-none">⭐</span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      }}
                    />
                  )}
                </Document>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-4">
              <div className="bg-slate-900 p-8 rounded-3xl shadow-xl border border-slate-800 max-w-md w-full text-center">
                <div className="w-16 h-16 bg-blue-900/30 text-blue-400 rounded-full flex items-center justify-center mx-auto mb-4">
                  <FileText size={32} />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">PDF Yüklenmedi</h2>
                <p className="text-slate-400 mb-6">Sınavı PDF olmadan çözüyorsunuz. Aşağıdaki optik formu kullanarak cevaplarınızı işaretleyebilirsiniz.</p>
              </div>
            </div>
          )}

          {/* Quick Mark Overlay — Odak modunda gizli */}
          <div 
            className={`absolute bottom-0 left-0 right-0 z-30 bg-slate-900/95 backdrop-blur-xl border-t border-slate-700 p-2 sm:p-3 shadow-[0_-10px_40px_rgba(0,0,0,0.8)] flex items-center gap-2 transform transition-all justify-between touch-pan-y ${focusMode && mode === 'taking' && !isGrading && !isReview ? 'hidden' : ''}`}
            onTouchStart={(e) => {
              if (isReview) return;
              const touch = e.touches[0];
              (e.currentTarget as any).startX = touch.clientX;
            }}
            onTouchEnd={(e) => {
              if (isReview) return;
              const touch = e.changedTouches[0];
              const startX = (e.currentTarget as any).startX;
              if (startX) {
                const diff = startX - touch.clientX;
                if (diff > 50) {
                  // Swipe left -> next question
                  if (activeQuestion < questionCount) {
                    setActiveQuestion(p => p + 1);
                    scrollToQuestion(activeQuestion + 1);
                  } else {
                    setQuestionCount(p => p + 1);
                    setActiveQuestion(p => p + 1);
                    scrollToQuestion(activeQuestion + 1);
                  }
                } else if (diff < -50) {
                  // Swipe right -> prev question
                  setActiveQuestion(p => Math.max(1, p - 1));
                  scrollToQuestion(Math.max(1, activeQuestion - 1));
                }
              }
            }}
          >
            {isReview ? (
              <div className="flex w-full items-center justify-between max-w-4xl mx-auto">
                <button
                  onClick={() => {
                    const currentIndex = incorrectQs.indexOf(activeQuestion);
                    if (currentIndex > 0) {
                      const prevQ = incorrectQs[currentIndex - 1];
                      setActiveQuestion(prevQ);
                      // Scroll yok — kullanıcı kendisi yönetir
                    }
                  }}
                  disabled={incorrectQs.indexOf(activeQuestion) <= 0}
                  className="px-4 py-2 text-slate-300 hover:text-white disabled:opacity-30 flex items-center gap-2 bg-slate-800 rounded-xl transition-colors"
                >
                  <ChevronLeft size={20} />
                  <span className="hidden sm:inline font-medium">Önceki Yanlış</span>
                </button>
                
                <div className="flex flex-col items-center">
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">Soru {activeQuestion}</span>
                  <div className="flex items-center gap-3 bg-slate-800/50 px-4 py-1.5 rounded-full border border-slate-700/50">
                    <span className="text-rose-400 font-bold text-sm">Senin: {userAnswers[activeQuestion] || 'Boş'}</span>
                    <span className="text-slate-600">|</span>
                    <span className="text-emerald-400 font-bold text-sm">Doğru: {correctAnswers[activeQuestion]}</span>
                  </div>
                </div>
                
                <button
                  onClick={() => {
                    const currentIndex = incorrectQs.indexOf(activeQuestion);
                    if (currentIndex < incorrectQs.length - 1 && currentIndex !== -1) {
                      const nextQ = incorrectQs[currentIndex + 1];
                      setActiveQuestion(nextQ);
                      // Scroll yok — kullanıcı kendisi yönetir
                    } else if (currentIndex === -1 && incorrectQs.length > 0) {
                      const nextQ = incorrectQs[0];
                      setActiveQuestion(nextQ);
                      // Scroll yok — kullanıcı kendisi yönetir
                    }
                  }}
                  disabled={incorrectQs.indexOf(activeQuestion) >= incorrectQs.length - 1 && incorrectQs.indexOf(activeQuestion) !== -1}
                  className="px-4 py-2 text-slate-300 hover:text-white disabled:opacity-30 flex items-center gap-2 bg-slate-800 rounded-xl transition-colors"
                >
                  <span className="hidden sm:inline font-medium">Sonraki Yanlış</span>
                  <ChevronRight size={20} />
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => {
                    setActiveQuestion(p => Math.max(1, p - 1));
                    scrollToQuestion(Math.max(1, activeQuestion - 1));
                  }}
                  disabled={activeQuestion === 1}
                  className="p-3 text-slate-400 hover:text-white disabled:opacity-30 transition-colors shrink-0 bg-slate-800 rounded-xl"
                >
                  <ChevronLeft size={24} />
                </button>

                <div className="flex flex-col items-center min-w-[3.5rem] shrink-0">
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Soru</span>
                  <span className="text-2xl font-black text-white leading-none mb-1">{activeQuestion}</span>
                  {isGrading ? (
                    <button 
                      onClick={calculateResults}
                      className="text-[9px] text-emerald-400 font-bold uppercase tracking-wider bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-0.5 rounded-full transition-colors mt-0.5"
                    >
                      SONUÇ
                    </button>
                  ) : (
                    <button 
                      onClick={handleFinishClick}
                      className="text-[9px] text-rose-400 font-bold uppercase tracking-wider bg-rose-500/10 hover:bg-rose-500/20 px-2 py-0.5 rounded-full transition-colors mt-0.5"
                    >
                      BİTİR
                    </button>
                  )}
                </div>

                <div className="flex gap-2 flex-1 justify-center max-w-md mx-auto">
                  {OPTIONS.map(opt => {
                    const isSelected = isGrading 
                      ? correctAnswers[activeQuestion] === opt 
                      : userAnswers[activeQuestion] === opt;
                    
                    let activeColorClass = isGrading
                      ? 'bg-emerald-600 text-white shadow-[0_0_15px_rgba(5,150,105,0.5)] transform scale-105 border-emerald-500'
                      : 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.5)] transform scale-105 border-blue-500';
                      
                    let hoverColorClass = isGrading
                      ? 'hover:border-emerald-500'
                      : 'hover:border-blue-500';
                      
                    let buttonClass = `flex-1 h-8 sm:h-8 sm:w-8 sm:flex-none rounded-lg text-sm font-bold transition-all duration-200 ${
                      isSelected
                        ? activeColorClass
                        : `bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 ${hoverColorClass} hover:text-white`
                    }`;

                    return (
                      <button
                        key={opt}
                        onClick={() => {
                          if (isGrading) {
                            handleCorrectAnswerSelect(activeQuestion, opt);
                            if (activeQuestion < questionCount) {
                              setActiveQuestion(p => p + 1);
                              scrollToQuestion(activeQuestion + 1);
                            }
                          } else {
                            handleQuickMark(opt);
                          }
                        }}
                        className={buttonClass}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => {
                      if (activeQuestion < questionCount) {
                        setActiveQuestion(p => p + 1);
                        scrollToQuestion(activeQuestion + 1);
                      } else {
                        setQuestionCount(p => p + 1);
                        setActiveQuestion(p => p + 1);
                        scrollToQuestion(activeQuestion + 1);
                      }
                    }}
                    className="p-3 text-slate-400 hover:text-white transition-colors bg-slate-800 rounded-xl"
                  >
                    <ChevronRight size={24} />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        






      </div>
    );
  };

  // FIX: Soru kayıt modalı — ana mount'tan çağrılır ki PDF olmasa bile çalışsın (fotoğraftan ekleme için)
  const renderQuestionCropModal = () => {
    if (!showCropModal || !cropImage) return null;
    return (
      <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
        <div className="bg-slate-900 rounded-2xl p-6 w-full max-w-md border border-slate-700 shadow-2xl max-h-[90dvh] overflow-y-auto">
          <h3 className="text-xl font-bold text-white mb-4">Soruyu Kaydet</h3>
          <div className="mb-4 max-h-48 overflow-auto rounded-lg border border-slate-800 bg-white">
            <img src={cropImage} alt="Kırpılan Soru" className="w-full h-auto object-contain" />
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Ders</label>
                <select
                  id="crop-subject"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                  value={cropSubject}
                  onChange={(e) => {
                    const subj = e.target.value;
                    setCropSubject(subj);
                    setCropTopic(lastTopicBySubject[subj] || '');
                  }}
                >
                  {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Konu</label>
                <select
                  id="crop-topic"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                  value={cropTopic}
                  onChange={e => setCropTopic(e.target.value)}
                >
                  <option value="">Konu Seçin (İsteğe Bağlı)</option>
                  {KPSS_TOPICS[cropSubject]?.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Zorluk</label>
                <select
                  id="crop-difficulty"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                  defaultValue="Orta"
                >
                  <option value="Kolay">Kolay</option>
                  <option value="Orta">Orta</option>
                  <option value="Zor">Zor</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Doğru Cevap</label>
                <select
                  id="crop-correct-answer"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                  defaultValue={correctAnswers[activeQuestion] || ""}
                >
                  <option value="">Belirtilmedi</option>
                  {OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Notlar</label>
              <textarea
                id="crop-notes"
                placeholder="Soruyla ilgili notlarınız..."
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 resize-none h-24"
              />
            </div>
          </div>
          <div className="flex gap-3 mt-6">
            <button
              onClick={() => { setShowCropModal(false); setCropImage(null); setCropState(null); }}
              className="flex-1 py-3 rounded-xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors"
            >
              İptal
            </button>
            <button id="app-save-btn"
              onClick={async () => {
                const subject = cropSubject;
                const topic = cropTopic;
                if (topic) setLastTopicBySubject(prev => ({ ...prev, [subject]: topic }));
                const difficulty = (document.getElementById('crop-difficulty') as HTMLSelectElement).value as 'Kolay' | 'Orta' | 'Zor';
                const correctAnswer = (document.getElementById('crop-correct-answer') as HTMLSelectElement).value;
                const notes = (document.getElementById('crop-notes') as HTMLTextAreaElement).value;

                const newQuestion: SavedQuestion = {
                  id: uuidv4(),
                  sessionId: currentSessionId || '',
                  questionNumber: activeQuestion,
                  subject,
                  topic: topic || undefined,
                  difficulty,
                  image: cropImage,
                  date: Date.now(),
                  correctAnswer: correctAnswer || undefined,
                  notes: notes || undefined,
                  pdfId: currentPdfId || undefined,
                  page: cropState?.page,
                  rect: cropState ? {
                    x: Math.min(cropState.startX, cropState.currentX),
                    y: Math.min(cropState.startY, cropState.currentY),
                    width: Math.abs(cropState.currentX - cropState.startX),
                    height: Math.abs(cropState.currentY - cropState.startY)
                  } : undefined
                };

                const updated = [newQuestion, ...savedQuestions];
                setSavedQuestions(updated);
                if (user) {
                  try {
                    let questionToSave: any = { ...newQuestion, uid: user.uid };
                    if (newQuestion.image && newQuestion.image.startsWith('data:')) {
                      const imageUrl = await api.uploadQuestionImage(user, newQuestion.id, newQuestion.image);
                      questionToSave.image = imageUrl;
                    }
                    await api.saveQuestion(user, questionToSave);
                    setSavedQuestions(prev => prev.map(q => q.id === newQuestion.id ? {...q, image: questionToSave.image} : q));
                  } catch (error: any) {
                    console.error("Error saving question:", error);
                    const msg = error?.message || String(error);
                    const status = error?.status || error?.response?.status || '';
                    alert(`❌ Soru sunucuya kaydedilemedi ${status ? '(' + status + ')' : ''}: ${msg}`);
                    setSavedQuestions(prev => prev.filter(q => q.id !== newQuestion.id));
                  }
                } else {
                  await localforage.setItem('saved_questions', updated);
                }

                setShowCropModal(false);
                setCropImage(null);
                setCropState(null);
              }}
              className="flex-1 py-3 rounded-xl font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-lg shadow-blue-900/20"
            >
              Kaydet
            </button>
            <button
              onClick={() => {
                if (!cropImage) return;
                try {
                  const arr = cropImage.split(',');
                  const mimeMatch = arr[0].match(/:(.*?);/);
                  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                  const bstr = atob(arr[1]);
                  let n = bstr.length;
                  const u8arr = new Uint8Array(n);
                  while (n--) u8arr[n] = bstr.charCodeAt(n);
                  const ext = mime.includes('png') ? 'png' : 'jpg';
                  let fileToShare: any;
                  try { fileToShare = new window.File([u8arr], `soru.${ext}`, { type: mime }); }
                  catch (err) {
                    fileToShare = new Blob([u8arr], { type: mime });
                    (fileToShare as any).name = `soru.${ext}`;
                  }
                  if (navigator.share) {
                    navigator.share({ files: [fileToShare] }).catch(() => {});
                  }
                } catch (e) {}
              }}
              className="px-2 py-3 rounded-xl font-bold text-white bg-green-600 hover:bg-green-700 transition-colors flex-1 flex items-center justify-center whitespace-nowrap text-sm"
              title="Sadece Gönder"
            >
              📤 Gönder
            </button>
            <button
              onClick={async () => {
                if (!cropImage) return;
                document.getElementById('app-save-btn')?.click();
                try {
                  const arr = cropImage.split(',');
                  const mimeMatch = arr[0].match(/:(.*?);/);
                  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                  const bstr = atob(arr[1]);
                  let n = bstr.length;
                  const u8arr = new Uint8Array(n);
                  while (n--) u8arr[n] = bstr.charCodeAt(n);
                  const ext = mime.includes('png') ? 'png' : 'jpg';
                  let fileToShare: any;
                  try { fileToShare = new window.File([u8arr], `soru.${ext}`, { type: mime }); }
                  catch (err) {
                    fileToShare = new Blob([u8arr], { type: mime });
                    (fileToShare as any).name = `soru.${ext}`;
                  }
                  if (navigator.share) {
                    try { await navigator.share({ files: [fileToShare] }); } catch (e) {}
                  }
                } catch (e) {}
              }}
              className="px-2 py-3 rounded-xl font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors flex-1 flex items-center justify-center whitespace-nowrap text-sm"
              title="Hem Uygulamaya Kaydet Hem Gönder"
            >
              🔄 İkisi de
            </button>
          </div>
        </div>
      </div>
    );
  };


  // ── NOT KAYDET MODALI (renderPDFInterface dışında, ana return içinde) ──
  // ── NOT SAYFA DÜZENLEYİCİSİ ─────────────────────────────────────────────────
  const buildNoteLayoutPDF = async () => {
    const selected = savedNotes.filter(n => noteLayoutSelected.has(n.id));
    if (selected.length === 0) return;
    setNoteLayoutBuilding(true);

    try {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const W = 210, H = 297;
      const margin = 10;
      const gap = 4;
      const cols = noteLayoutCols as number;
      const colW = (W - margin * 2 - gap * (cols - 1)) / cols;

      // Her sütun kendi y pozisyonunu tutar — kartlar çakışmaz
      const colY: number[] = Array(cols).fill(margin);

      const startNewPage = () => {
        doc.addPage();
        for (let i = 0; i < cols; i++) colY[i] = margin;
      };

      for (const note of selected) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = note.image;
        await new Promise<void>(res => { img.onload = () => res(); img.onerror = () => res(); });

        const ratio = img.width > 0 ? img.width / img.height : 1;
        const hasTitle = !!(note.title);
        const hasSrc = !!(note.pdfName || note.topic);
        const imgH = colW / ratio;
        const cardH = imgH + (hasTitle ? 6 : 0) + (hasSrc ? 5 : 0) + 4;

        // En kısa sütunu bul
        let col = 0;
        for (let i = 1; i < cols; i++) {
          if (colY[i] < colY[col]) col = i;
        }

        // Bu sütuna sığmıyorsa yeni sayfa
        if (colY[col] + cardH > H - margin) {
          startNewPage();
          col = 0;
        }

        const x = margin + col * (colW + gap);
        const y = colY[col];

        // Kart çiz
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(203, 213, 225);
        doc.roundedRect(x, y, colW, cardH, 2, 2, 'FD');

        let contentY = y + 2;

        if (hasTitle) {
          doc.setFontSize(7);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(30, 41, 59);
          doc.text(note.title!.substring(0, Math.floor(colW * 2.2)), x + 2, contentY + 3.5);
          contentY += 6;
        }

        doc.setFillColor(255, 255, 255);
        doc.rect(x + 1, contentY, colW - 2, imgH, 'F');
        try {
          const iw = colW - 2;
          const ih = iw / ratio;
          doc.addImage(img, 'JPEG', x + 1, contentY, iw, Math.min(ih, imgH));
        } catch {}
        contentY += imgH + 1;

        if (hasSrc) {
          doc.setFontSize(5.5);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(100, 116, 139);
          const parts: string[] = [];
          if (note.topic) parts.push(note.topic);
          if (note.pdfName) parts.push(`${note.pdfName}${note.page ? ` S.${note.page}` : ''}`);
          doc.text(parts.join('  ').substring(0, Math.floor(colW * 3.5)), x + 2, contentY + 3);
        }

        colY[col] += cardH + gap;
      }

      doc.save(`Notlarim_A4_${new Date().toLocaleDateString('tr-TR').replace(/[.]/g, '-')}.pdf`);
    } finally {
      setNoteLayoutBuilding(false);
    }
  };

  const renderNoteLayoutBuilder = () => {
    if (!showNoteLayoutBuilder) return null;

    // Filtrele
    let filtered = savedNotes;
    if (noteLayoutFilterSubject) filtered = filtered.filter(n => n.subject === noteLayoutFilterSubject);
    if (noteLayoutFilterTopic) filtered = filtered.filter(n => n.topic === noteLayoutFilterTopic);

    const allSelected = filtered.length > 0 && filtered.every(n => noteLayoutSelected.has(n.id));

    // Önizleme: seçilenlerin A4'teki dağılımını hesapla
    const selected = savedNotes.filter(n => noteLayoutSelected.has(n.id));
    const W_mm = 210, H_mm = 297, M_mm = 10, GAP_mm = 4;
    const colW_mm = (W_mm - M_mm * 2 - GAP_mm * (noteLayoutCols - 1)) / noteLayoutCols;
    // yaklaşık kart sayısı per sayfa (ortalama oran 1.4 kabul et)
    const avgCardH = colW_mm / 1.4 + 10;
    const cardsPerCol = Math.floor((H_mm - M_mm * 2) / (avgCardH + GAP_mm));
    const cardsPerPage = cardsPerCol * noteLayoutCols;
    const pageCount = Math.max(1, Math.ceil(selected.length / cardsPerPage));

    const allSubjects = [...new Set(savedNotes.map(n => n.subject))];
    const allTopics = noteLayoutFilterSubject
      ? [...new Set(savedNotes.filter(n => n.subject === noteLayoutFilterSubject).map(n => n.topic).filter(Boolean))]
      : [];

    return (
      <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-stretch animate-in fade-in duration-200">
        <div className="flex flex-col w-full max-w-5xl mx-auto bg-slate-900 shadow-2xl">
          {/* Başlık */}
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-800 bg-slate-900/80 shrink-0">
            <StickyNote className="text-green-400" size={20} />
            <h2 className="text-lg font-bold text-white">Not Sayfası Düzenleyici</h2>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs text-slate-400">{selected.length} not seçili</span>
              {selected.length > 0 && (
                <span className="text-xs text-slate-500">≈ {pageCount} sayfa</span>
              )}
              <button
                onClick={() => setShowNoteLayoutBuilder(false)}
                className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              ><X size={18} /></button>
            </div>
          </div>

          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* Sol panel — seçim & ayarlar */}
            <div className="w-72 shrink-0 border-r border-slate-800 flex flex-col bg-slate-900/50">
              {/* Ayarlar */}
              <div className="p-4 border-b border-slate-800 space-y-3 shrink-0">
                <div>
                  <label className="text-xs font-medium text-slate-400 mb-1.5 block">Sütun Sayısı</label>
                  <div className="flex gap-2">
                    {([1,2,3] as const).map(c => (
                      <button key={c} onClick={() => setNoteLayoutCols(c)}
                        className={`flex-1 py-2 rounded-lg text-sm font-bold transition-colors ${noteLayoutCols === c ? 'bg-green-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                      >{c}</button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium text-slate-400 mb-1 block">Ders</label>
                    <select value={noteLayoutFilterSubject}
                      onChange={e => { setNoteLayoutFilterSubject(e.target.value); setNoteLayoutFilterTopic(''); }}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-green-500"
                    >
                      <option value="">Tümü</option>
                      {allSubjects.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-400 mb-1 block">Konu</label>
                    <select value={noteLayoutFilterTopic} onChange={e => setNoteLayoutFilterTopic(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-green-500"
                    >
                      <option value="">Tümü</option>
                      {allTopics.map(t => <option key={t} value={t as string}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => {
                    const ids = new Set(noteLayoutSelected);
                    if (allSelected) filtered.forEach(n => ids.delete(n.id));
                    else filtered.forEach(n => ids.add(n.id));
                    setNoteLayoutSelected(ids);
                  }}
                    className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
                  >{allSelected ? 'Tümünü Kaldır' : 'Tümünü Seç'}</button>
                  <button onClick={() => setNoteLayoutSelected(new Set())}
                    className="px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                  >Temizle</button>
                </div>
              </div>

              {/* Not listesi */}
              <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                {filtered.length === 0 && (
                  <p className="text-xs text-slate-600 text-center py-8">Not bulunamadı</p>
                )}
                {filtered.map(note => {
                  const isSelected = noteLayoutSelected.has(note.id);
                  return (
                    <div key={note.id}
                      onClick={() => {
                        const ids = new Set(noteLayoutSelected);
                        isSelected ? ids.delete(note.id) : ids.add(note.id);
                        setNoteLayoutSelected(ids);
                      }}
                      className={`flex items-center gap-2.5 p-2 rounded-xl cursor-pointer transition-all border ${
                        isSelected ? 'bg-green-900/30 border-green-700/50' : 'bg-slate-800/40 border-transparent hover:bg-slate-800'
                      }`}
                    >
                      <div className={`w-4 h-4 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                        isSelected ? 'bg-green-500 border-green-500' : 'border-slate-600'
                      }`}>
                        {isSelected && <Check size={10} className="text-white" strokeWidth={3} />}
                      </div>
                      <div className="w-10 h-10 bg-white rounded overflow-hidden shrink-0">
                        <img src={note.image} alt="" className="w-full h-full object-cover mix-blend-multiply" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-slate-200 truncate">{note.title || '—'}</p>
                        <p className="text-[10px] text-slate-500 truncate">{note.subject}{note.topic ? ` › ${note.topic}` : ''}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Sağ panel — A4 önizleme */}
            <div className="flex-1 overflow-y-auto bg-slate-950 p-6 flex flex-col items-center gap-4">
              {selected.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-600">
                  <StickyNote size={48} className="mb-4 opacity-20" />
                  <p className="text-sm">Soldan not seçin</p>
                </div>
              ) : (
                <>
                  <p className="text-xs text-slate-500 self-start">A4 önizleme ({noteLayoutCols} sütun)</p>
                  {/* A4 önizleme sayfaları */}
                  {Array.from({ length: pageCount }, (_, pi) => {
                    const pageNotes = selected.slice(pi * cardsPerPage, (pi + 1) * cardsPerPage);
                    return (
                      <div key={pi} className="bg-white shadow-2xl rounded"
                        style={{ width: '100%', maxWidth: 480, aspectRatio: '210/297', padding: '3%', position: 'relative' }}
                      >
                        <p className="absolute top-1 right-2 text-[8px] text-slate-300">{pi + 1}</p>
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: `repeat(${noteLayoutCols}, 1fr)`,
                          gap: '2%',
                          height: '100%',
                          alignContent: 'start'
                        }}>
                          {pageNotes.map(note => (
                            <div key={note.id} style={{ border: '1px solid #e2e8f0', borderRadius: 4, overflow: 'hidden', background: '#f8fafc' }}>
                              {note.title && (
                                <div style={{ padding: '2px 4px', fontSize: 7, fontWeight: 600, color: '#1e293b', background: '#f1f5f9', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {note.title}
                                </div>
                              )}
                              <div style={{ background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <img src={note.image} alt="" style={{ width: '100%', objectFit: 'contain', mixBlendMode: 'multiply' }} />
                              </div>
                              {(note.topic || note.pdfName) && (
                                <div style={{ padding: '1px 3px', fontSize: 6, color: '#94a3b8', borderTop: '1px solid #e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {note.topic}{note.pdfName ? ` · ${note.pdfName}` : ''}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* Alt çubuk */}
          <div className="shrink-0 px-6 py-4 border-t border-slate-800 flex items-center justify-between bg-slate-900">
            <p className="text-xs text-slate-500">
              {selected.length} not seçili · {noteLayoutCols} sütun · ≈ {pageCount} A4 sayfa
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowNoteLayoutBuilder(false)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >İptal</button>
              <button
                onClick={buildNoteLayoutPDF}
                disabled={selected.length === 0 || noteLayoutBuilding}
                className="px-6 py-2 rounded-xl text-sm font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2 shadow-lg shadow-green-900/30"
              >
                {noteLayoutBuilding ? (
                  <><RefreshCw size={14} className="animate-spin" /> Oluşturuluyor...</>
                ) : (
                  <><FileText size={14} /> A4 PDF Oluştur</>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderNoteModal = () => showNoteModal && noteImage ? (
    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4">
      <div className="bg-slate-900 rounded-2xl p-6 w-full max-w-md border border-green-900/50 shadow-2xl shadow-green-900/20">
        <div className="flex items-center gap-2 mb-4">
          <StickyNote className="text-green-400" size={20} />
          <h3 className="text-xl font-bold text-white">Önemli Notu Kaydet</h3>
        </div>
        <div className="mb-4 max-h-48 overflow-auto rounded-xl border-2 border-green-500/30 bg-white">
          <img src={noteImage} alt="Kesilen Not" className="w-full h-auto object-contain" />
        </div>
        <div className="space-y-3">
          <input
            type="text"
            placeholder="Başlık (opsiyonel)"
            value={noteCropTitle}
            onChange={e => setNoteCropTitle(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-green-500 text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Ders</label>
              <select
                value={noteCropSubject}
                onChange={e => { setNoteCropSubject(e.target.value); setNoteCropTopic(lastTopicBySubject[e.target.value] || ''); }}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:border-green-500 text-sm"
              >
                {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Konu</label>
              <select
                value={noteCropTopic}
                onChange={e => setNoteCropTopic(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:border-green-500 text-sm"
              >
                <option value="">Konu Seçin</option>
                {KPSS_TOPICS[noteCropSubject]?.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* FIX: Kategori seçici — renkli butonlar */}
          <div className="mt-3">
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Kategori</label>
            <div className="grid grid-cols-5 gap-1.5">
              {(Object.entries(NOTE_CATEGORIES) as [keyof typeof NOTE_CATEGORIES extends infer K ? any : any, any][]).map(([key, cat]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setNoteCropCategory(key as any)}
                  className={`flex flex-col items-center gap-0.5 py-2 rounded-lg border transition-all ${noteCropCategory === key ? `${cat.bg} ${cat.border} ${cat.color} ring-2 ring-offset-1 ring-offset-slate-900 ring-current` : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-800'}`}
                >
                  <span className="text-base leading-none">{cat.emoji}</span>
                  <span className="text-[9px] font-medium">{cat.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-3 mt-5">
          <button
            onClick={() => { setShowNoteModal(false); setNoteImage(null); }}
            className="flex-1 py-3 rounded-xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors"
          >İptal</button>
          <button
            onClick={async () => {
              if (isSavingNote) return;
              setIsSavingNote(true);
              const note: SavedNote = {
                id: uuidv4(),
                subject: noteCropSubject,
                topic: noteCropTopic || undefined,
                title: noteCropTitle || undefined,
                image: noteImage!,
                date: Date.now(),
                pdfId: currentPdfId || undefined,
                pdfName: pdfLibrary.find(p => p.id === currentPdfId)?.name,
                page: noteCropPage,
                rect: noteCropRect || undefined,
                category: noteCropCategory, // FIX: Kategori kaydet
              };
              if (noteCropTopic) setLastTopicBySubject(prev => ({ ...prev, [noteCropSubject]: noteCropTopic }));
              await saveNote(note);
              setIsSavingNote(false);
              setShowNoteModal(false);
              setNoteImage(null);
            }}
            disabled={isSavingNote}
            className="flex-1 py-3 rounded-xl font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-60 transition-colors shadow-lg shadow-green-900/30 flex items-center justify-center gap-2"
          >
            {isSavingNote ? (
              <><RefreshCw size={16} className="animate-spin" /> Kaydediliyor...</>
            ) : (
              'Kaydet'
            )}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // Sadece görseller sıralı — A4'te mümkün olduğunca büyük
  // Grid PDF export: A4'te yan yana / alt alta, sığabildiği kadar
  const exportNotesImageOnly = async (notesToExport: SavedNote[], filename = 'Notlar_Gorseller.pdf') => {
    if (notesToExport.length === 0) return;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210, H = 297;
    const M = 6;         // sayfa kenar boşluğu
    const GAP = 3;       // notlar arası boşluk
    const LABEL_H = 5;   // etiket yüksekliği

    // Kolonları notta ortalama en/boy oranına göre belirle
    const COLS = 2;
    const colW = (W - M * 2 - GAP * (COLS - 1)) / COLS;

    const sorted = [...notesToExport].sort((a, b) =>
      (a.subject + (a.topic || '')).localeCompare(b.subject + (b.topic || ''))
    );

    // Önce tüm resimleri yükle, yüksekliklerini hesapla
    const items: { note: SavedNote; aspect: number }[] = [];
    await Promise.all(sorted.map(note => new Promise<void>(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { items.push({ note, aspect: img.naturalWidth / img.naturalHeight }); resolve(); };
      img.onerror = () => { items.push({ note, aspect: 1.5 }); resolve(); };
      img.src = note.image;
    })));
    // Sıralamayı koru (Promise.all sıralamayı bozabilir)
    items.sort((a, b) =>
      (a.note.subject + (a.note.topic || '')).localeCompare(b.note.subject + (b.note.topic || ''))
    );

    let col = 0;
    let y = M;
    let firstPage = true;

    for (const { note, aspect } of items) {
      const imgH = colW / aspect;
      const cellH = imgH + LABEL_H + GAP;
      const x = M + col * (colW + GAP);

      // Sayfa sonu kontrolü
      if (!firstPage && col === 0 && y + cellH > H - M) {
        doc.addPage();
        y = M;
      }
      firstPage = false;

      // Görsel
      try {
        const fmt = note.image.startsWith('data:image/png') ? 'PNG' : 'JPEG';
        doc.addImage(note.image, fmt, x, y, colW, imgH);
      } catch { }

      // Etiket
      doc.setFontSize(6);
      doc.setTextColor(100, 100, 100);
      const label = `${note.subject}${note.topic ? ' › ' + note.topic : ''}${note.title ? ' — ' + note.title : ''}`;
      doc.text(label, x, y + imgH + 3.5, { maxWidth: colW });

      col++;
      if (col >= COLS) {
        col = 0;
        y += cellH;
        // Bir sonraki satır için sayfa kontrolü
        if (y > H - M - 20) {
          doc.addPage();
          y = M;
        }
      }
    }

    doc.save(filename);
  };

  const exportNotesToPDF = async (
    notesToExport: SavedNote[],
    filename = 'Notlarim.pdf',
    layout: 'compact' | 'study' = 'study'
  ) => {
    if (notesToExport.length === 0) return;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 12;

    // Başlık sayfası
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, W, H, 'F');
    doc.setTextColor(34, 197, 94);
    doc.setFontSize(22); doc.setFont('helvetica', 'bold');
    doc.text('Önemli Notlarım', W / 2, 90, { align: 'center' });
    doc.setFontSize(11); doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text(`${notesToExport.length} not  •  ${new Date().toLocaleDateString('tr-TR')}`, W / 2, 102, { align: 'center' });
    const subjectGroups: Record<string, number> = {};
    notesToExport.forEach(n => { subjectGroups[n.subject] = (subjectGroups[n.subject] || 0) + 1; });
    let sy = 118;
    doc.setFontSize(9);
    Object.entries(subjectGroups).forEach(([s, c]) => {
      doc.setTextColor(100, 116, 139);
      doc.text(`${s}  (${c} not)`, W / 2, sy, { align: 'center' });
      sy += 7;
    });

    // Study layout — 2 sütun, konuya göre sıralı
    const cols = layout === 'compact' ? 3 : 2;
    const colW = (W - M * 2 - (cols - 1) * 5) / cols;
    const maxImgH = layout === 'compact' ? 45 : 70;
    let col = 0, y = M;
    let lastSubject = '';

    const sorted = [...notesToExport].sort((a, b) =>
      (a.subject + (a.topic || '')).localeCompare(b.subject + (b.topic || ''))
    );

    doc.addPage();

    for (const note of sorted) {
      if (layout === 'study' && note.subject !== lastSubject) {
        if (lastSubject !== '') { doc.addPage(); col = 0; y = M; }
        lastSubject = note.subject;
        doc.setFillColor(20, 83, 45);
        doc.roundedRect(M, y, W - M * 2, 8, 2, 2, 'F');
        doc.setTextColor(134, 239, 172); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
        doc.text(note.subject, M + 4, y + 5.5);
        y += 11;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = note.image;
      await new Promise<void>(res => { img.onload = () => res(); img.onerror = () => res(); });
      const ratio = img.width > 0 ? img.width / img.height : 1;
      let iw = colW - 4, ih = iw / ratio;
      if (ih > maxImgH) { ih = maxImgH; iw = ih * ratio; }
      const cardH = ih + (note.title ? 13 : 7) + (note.pdfName ? 5 : 0);

      if (y + cardH > H - M) {
        col++;
        if (col >= cols) {
          doc.addPage(); col = 0;
          if (layout === 'study' && lastSubject) {
            doc.setFillColor(20, 83, 45);
            doc.roundedRect(M, M, W - M * 2, 8, 2, 2, 'F');
            doc.setTextColor(134, 239, 172); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
            doc.text(lastSubject, M + 4, M + 5.5);
            y = M + 11;
          } else { y = M; }
        } else { y = M; }
      }

      const x = M + col * (colW + 5);
      doc.setFillColor(30, 41, 59); doc.setDrawColor(71, 85, 105);
      doc.roundedRect(x, y, colW, cardH, 2, 2, 'FD');

      if (note.title) {
        doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(226, 232, 240);
        doc.text(note.title.substring(0, 38), x + 2.5, y + 5);
      }
      const imgY = y + (note.title ? 7 : 2.5);
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(x + 2, imgY, colW - 4, ih, 1, 1, 'F');
      try { doc.addImage(img, 'JPEG', x + 2 + (colW - 4 - iw) / 2, imgY, iw, ih); } catch {}
      if (note.pdfName) {
        doc.setFontSize(5.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 116, 139);
        doc.text(`📄 ${note.pdfName}${note.page ? ` S.${note.page}` : ''}`.substring(0, 48), x + 2, y + cardH - 1.5);
      }
      y += cardH + 3;
    }

    doc.save(filename);
  };

  const renderSavedNotes = () => {
    // FIX: Kategori filtresi uygula
    const filteredNotes = notesFilterCategory
      ? savedNotes.filter(n => (n.category || 'diger') === notesFilterCategory)
      : savedNotes;
    const grouped: Record<string, Record<string, SavedNote[]>> = {};
    filteredNotes.forEach(n => {
      const subj = n.subject || 'Genel';
      const topic = n.topic || 'Konusuz';
      if (!grouped[subj]) grouped[subj] = {};
      if (!grouped[subj][topic]) grouped[subj][topic] = [];
      grouped[subj][topic].push(n);
    });
    // Kategori istatistikleri
    const categoryCounts: Record<string, number> = {};
    savedNotes.forEach(n => {
      const cat = n.category || 'diger';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });
    return (
      <div className="min-h-[100dvh] bg-slate-950 flex flex-col animate-in fade-in duration-300 overflow-x-hidden">
        <div className="bg-slate-900 border-b border-slate-800 px-3 py-2 flex items-center gap-1.5 flex-wrap w-full max-w-full">
          <button onClick={() => setMode('setup')} className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-800">
            <Home size={20} />
          </button>
          <StickyNote className="text-green-400" size={20} />
          <h1 className="text-lg font-bold text-white">Önemli Notlarım</h1>
          {/* FIX: Sayı kaldırıldı — kullanıcı istedi */}
          {savedNotes.length > 0 && (
            <div className="ml-auto flex items-center gap-1.5 flex-wrap justify-end">
              {/* FIX: Fotoğraftan Not Ekle */}
              <button
                onClick={() => { setPhotoUploadMode('note'); photoCameraInputRef.current?.click(); }}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-green-700/80 hover:bg-green-700 text-white rounded-lg text-xs font-bold transition-colors"
                title="Kamera ile not çek"
              >📷</button>
              <button
                onClick={() => { setPhotoUploadMode('note'); photoInputRef.current?.click(); }}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-green-700/80 hover:bg-green-700 text-white rounded-lg text-xs font-bold transition-colors"
                title="Galeriden not yükle"
              >🖼️</button>
              {/* Bugün Tekrar Butonu */}
              {todayReviewNotes.length > 0 && (
                <button
                  onClick={() => startNoteReview(todayReviewNotes)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-colors animate-pulse"
                >
                  🔴 Bugün ({todayReviewNotes.length})
                </button>
              )}
              {/* Tümünü Tekrar Et */}
              <button
                onClick={() => startNoteReview(savedNotes)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/80 hover:bg-amber-600 text-white rounded-lg text-xs font-bold transition-colors"
              >
                <Gamepad2 size={13} /> Tümü
              </button>
              {/* Sayfa Düzenleyici */}
              <button
                onClick={() => {
                  setNoteLayoutSelected(new Set(savedNotes.map(n => n.id)));
                  setNoteLayoutFilterSubject('');
                  setNoteLayoutFilterTopic('');
                  setShowNoteLayoutBuilder(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-bold transition-colors shadow-lg shadow-green-900/30"
              >
                <StickyNote size={13} /> Sayfa Düzenleyici
              </button>
              {/* PDF Export butonları */}
              <button
                onClick={() => exportNotesImageOnly(savedNotes, 'Notlar_Gorseller.pdf')}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg text-xs font-medium transition-colors border border-slate-700"
                title="Sadece görseller — A4 PDF"
              >
                <FileText size={12} />
              </button>
            </div>
          )}
        </div>

        {Object.keys(grouped).length > 1 && savedNotes.length > 0 && (
          <div className="bg-slate-900/50 border-b border-slate-800 px-4 py-2 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-slate-500 font-medium">Derse göre:</span>
            {Object.entries(grouped).map(([subject, topics]) => {
              const notes = Object.values(topics).flat();
              return (
                <button
                  key={subject}
                  onClick={() => {
                    setNoteLayoutSelected(new Set(notes.map(n => n.id)));
                    setNoteLayoutFilterSubject(subject);
                    setNoteLayoutFilterTopic('');
                    setShowNoteLayoutBuilder(true);
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 hover:bg-green-900/40 hover:text-green-400 text-slate-300 rounded text-[10px] font-medium transition-colors border border-slate-700"
                >
                  <StickyNote size={9} /> {subject} ({notes.length})
                </button>
              );
            })}
          </div>
        )}

        {/* FIX: Kategori filtre barı */}
        {savedNotes.length > 0 && (
          <div className="bg-slate-900/50 border-b border-slate-800 px-4 py-2 flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-slate-500 font-medium mr-1">Kategori:</span>
            <button
              onClick={() => setNotesFilterCategory('')}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${!notesFilterCategory ? 'bg-green-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
            >Tümü ({savedNotes.length})</button>
            {(['onemli','ornek','tanim','formul','diger'] as const).map(key => {
              const cat = NOTE_CATEGORIES[key];
              const count = categoryCounts[key] || 0;
              if (count === 0 && notesFilterCategory !== key) return null;
              return (
                <button
                  key={key}
                  onClick={() => setNotesFilterCategory(notesFilterCategory === key ? '' : key)}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors border ${notesFilterCategory === key ? `${cat.bg} ${cat.color} ${cat.border}` : 'bg-slate-800 text-slate-400 border-transparent hover:bg-slate-700'}`}
                >
                  <span>{cat.emoji}</span> {cat.label} <span className="opacity-60">({count})</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {filteredNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-500">
              <StickyNote size={48} className="mb-4 opacity-30" />
              <p className="text-sm">{notesFilterCategory ? 'Bu kategoride not yok.' : 'Henüz not kesmediniz.'}</p>
              <p className="text-xs mt-1 text-slate-600">PDF görüntüleme sırasında 📝 aracıyla not kesin veya aşağıdan fotoğraf ekleyin.</p>
              {!notesFilterCategory && (
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={() => { setPhotoUploadMode('note'); photoCameraInputRef.current?.click(); }}
                    className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-bold transition-colors"
                  >📷 Kamera</button>
                  <button
                    onClick={() => { setPhotoUploadMode('note'); photoInputRef.current?.click(); }}
                    className="flex items-center gap-1.5 px-4 py-2 bg-green-600/80 hover:bg-green-700 text-white rounded-xl text-sm font-bold transition-colors"
                  >🖼️ Galeri</button>
                </div>
              )}
            </div>
          ) : (
            Object.entries(grouped).map(([subject, topics]) => (
              <div key={subject} className="space-y-4">
                <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500"></div>
                  <h2 className="text-base font-bold text-white">{subject}</h2>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      onClick={() => startNoteReview(Object.values(topics).flat())}
                      className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-amber-400 hover:bg-amber-900/30 rounded transition-colors"
                    ><Gamepad2 size={10} /> Tekrar</button>
                    <button
                      onClick={() => exportNotesToPDF(Object.values(topics).flat(), `Notlar_${subject}.pdf`, 'study')}
                      className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-green-400 hover:bg-green-900/30 rounded transition-colors"
                    ><FileText size={10} /> PDF</button>
                  </div>
                </div>
                {Object.entries(topics).map(([topic, notes]) => (
                  <div key={topic} className="ml-3">
                    <div className="flex items-center gap-1.5 mb-3">
                      <NotebookPen size={12} className="text-green-400" />
                      <h3 className="text-xs font-semibold text-green-400 uppercase tracking-wider">{topic}</h3>
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          onClick={() => startNoteReview(notes)}
                          className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-amber-400 hover:bg-amber-900/20 rounded transition-colors"
                        ><Gamepad2 size={10} /> Tekrar</button>
                        <button
                          onClick={() => exportNotesToPDF(notes, `Notlar_${subject}_${topic}.pdf`, 'study')}
                          className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-slate-400 hover:text-green-400 hover:bg-green-900/20 rounded transition-colors"
                        ><FileText size={10} /> PDF</button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {notes.map(note => {
                        const stage = getNoteLearningStage(note);
                        const cat = NOTE_CATEGORIES[note.category || 'diger'];
                        return (
                        <div key={note.id} className={`bg-slate-900 border rounded-2xl overflow-hidden shadow-lg transition-all duration-300 group ${cat.border}`}>
                          <div className="p-2.5 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-sm leading-none shrink-0" title={cat.label}>{cat.emoji}</span>
                              <span className="text-xs text-slate-300 font-medium truncate">{note.title || cat.label}</span>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {/* Bilimsel öğrenme seviyesi */}
                              <span className={`text-[9px] px-1.5 py-0.5 rounded border ${stage.color}`} title={`${stage.label} · Aralık: ${note.intervalDays ?? 0}g · Tekrar: ${note.reviewCount ?? 0}`}>
                                {stage.emoji}
                              </span>
                              {note.page && <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">S.{note.page}</span>}
                              <button
                                onClick={() => exportNotesToPDF([note], `Not_${note.title || note.id}.pdf`, 'study')}
                                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-green-400 transition-all p-0.5"
                                title="PDF olarak indir"
                              ><FileText size={13} /></button>
                              <button
                                onClick={() => setConfirmModal({ isOpen: true, message: 'Bu notu silmek istiyor musunuz?', onConfirm: () => deleteNote(note.id) })}
                                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 transition-all p-0.5"
                              ><Trash2 size={14} /></button>
                            </div>
                          </div>
                          <div
                            className="bg-white p-1 flex justify-center min-h-[120px] items-center cursor-pointer"
                            onClick={() => exportNotesToPDF([note], `Not_${note.title || note.id}.pdf`, 'study')}
                            title="Tıkla → PDF indir"
                          >
                            <img src={note.image} alt={note.title || 'Not'} className="max-w-full max-h-48 object-contain mix-blend-multiply" />
                          </div>
                          {note.pdfName && (
                            <div className="px-2.5 py-1.5 bg-slate-800/40 text-[10px] text-slate-500 truncate">
                              📄 {note.pdfName}
                            </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    );
  };

  // Günün başlangıcını epoch ms olarak döner (00:00:00)
  const todayStart = () => {
    const d = new Date(); d.setHours(0,0,0,0); return d.getTime();
  };

  // Bugün tekrar edilmesi gereken notlar
  const todayReviewNotes = savedNotes.filter(n => {
    if (!n.nextReviewDate) return false;
    return n.nextReviewDate <= todayStart() + 86400000 - 1; // bugün veya geçmiş
  });

  const startNoteReview = (notes: SavedNote[]) => {
    const shuffled = [...notes].sort(() => Math.random() - 0.5);
    setNoteReviewNotes(shuffled);
    setNoteReviewIndex(0);
    setNoteReviewDone(new Set());
    setNoteReviewSkipped(new Set());
  };

  // Tekrar tarihini ayarla ve notu güncelle (ESKI: sabit gün — yedek olarak tutuluyor)
  const scheduleReview = async (note: SavedNote, daysFromNow: number) => {
    const d = new Date(); d.setHours(0,0,0,0);
    d.setDate(d.getDate() + daysFromNow);
    const updated: SavedNote = {
      ...note,
      nextReviewDate: d.getTime(),
      reviewCount: (note.reviewCount || 0) + (daysFromNow === 0 ? 0 : 1),
    };
    await updateNote(updated);
  };

  // FIX: Bilimsel tekrar (SM-2 benzeri) — kullanıcının kalite puanına göre
  // aralığı otomatik belirler. Quality: 0=Bilmiyorum, 1=Zor, 2=İyi, 3=Kolay
  // Aralıklar artan: yeni not için 1g → 3g → 7g → EF*son ile çarpılarak artar
  const scheduleReviewSM2 = async (note: SavedNote, quality: 0 | 1 | 2 | 3) => {
    const oldEase = note.easeFactor ?? 2.5;
    const oldInterval = note.intervalDays ?? 0;
    const oldReviews = note.reviewCount ?? 0;
    let newEase = oldEase;
    let newInterval: number;
    let newLapses = note.lapses ?? 0;

    if (quality === 0) {
      // Bilmiyorum — sıfırla, 1 gün sonra tekrar
      newInterval = 1;
      newLapses += 1;
      newEase = Math.max(1.3, oldEase - 0.2);
    } else {
      // 1=Zor, 2=İyi, 3=Kolay — EF güncelle
      // SM-2 formül: EF' = EF + (0.1 - (5-q')*(0.08+(5-q')*0.02)) for q'=3..5
      // Biz q'yu q+2'ye mapliyoruz: 1→3, 2→4, 3→5
      const q = quality + 2;
      newEase = Math.max(1.3, oldEase + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

      if (oldReviews === 0) {
        newInterval = 1; // ilk doğru tekrar
      } else if (oldReviews === 1) {
        newInterval = quality === 1 ? 2 : (quality === 3 ? 4 : 3); // ikinci tekrar
      } else {
        // Sonraki: önceki aralık × EF × kalite çarpanı
        const qMultiplier = quality === 1 ? 0.8 : (quality === 3 ? 1.3 : 1.0);
        newInterval = Math.round(oldInterval * newEase * qMultiplier);
        newInterval = Math.max(1, Math.min(newInterval, 180)); // max 6 ay
      }
    }

    const nextDate = new Date();
    nextDate.setHours(0, 0, 0, 0);
    nextDate.setDate(nextDate.getDate() + newInterval);

    const updated: SavedNote = {
      ...note,
      nextReviewDate: nextDate.getTime(),
      reviewCount: oldReviews + 1,
      easeFactor: Number(newEase.toFixed(2)),
      intervalDays: newInterval,
      lapses: newLapses,
      lastReviewedAt: Date.now(),
    };
    await updateNote(updated);
    return newInterval;
  };

  // FIX: Not "durumunu" belirle — bilimsel kategori (sayı yerine)
  const getNoteLearningStage = (note: SavedNote): { label: string; color: string; emoji: string } => {
    const reviews = note.reviewCount ?? 0;
    const interval = note.intervalDays ?? 0;
    const lapses = note.lapses ?? 0;

    if (reviews === 0) {
      return { label: 'Yeni', color: 'text-sky-400 bg-sky-900/30 border-sky-700/50', emoji: '🌱' };
    }
    if (reviews <= 2 || interval < 3) {
      return { label: 'Öğreniliyor', color: 'text-amber-400 bg-amber-900/30 border-amber-700/50', emoji: '📖' };
    }
    if (lapses > 2 && reviews < 5) {
      return { label: 'Zorlanıyor', color: 'text-rose-400 bg-rose-900/30 border-rose-700/50', emoji: '⚠️' };
    }
    if (interval < 14) {
      return { label: 'Pekiştiriliyor', color: 'text-emerald-400 bg-emerald-900/30 border-emerald-700/50', emoji: '🌿' };
    }
    if (interval < 45) {
      return { label: 'Öğrenildi', color: 'text-green-400 bg-green-900/30 border-green-700/50', emoji: '🌳' };
    }
    return { label: 'Kalıcı', color: 'text-violet-400 bg-violet-900/30 border-violet-700/50', emoji: '🏆' };
  };

  const renderNoteReview = () => {
    if (!noteReviewNotes || noteReviewNotes.length === 0) return null;

    const note = noteReviewNotes[noteReviewIndex];
    const total = noteReviewNotes.length;
    const doneCount = noteReviewDone.size;
    const skippedCount = noteReviewSkipped.size;
    const remaining = total - doneCount - skippedCount;
    const isFinished = doneCount + skippedCount >= total;

    const goNext = () => {
      let next = noteReviewIndex + 1;
      while (next < total && (noteReviewDone.has(noteReviewNotes[next].id) || noteReviewSkipped.has(noteReviewNotes[next].id))) {
        next++;
      }
      if (next >= total) {
        const firstSkipped = noteReviewNotes.findIndex(n => noteReviewSkipped.has(n.id));
        if (firstSkipped !== -1) setNoteReviewIndex(firstSkipped);
      } else {
        setNoteReviewIndex(next);
      }
    };

    const goPrev = () => {
      let prev = noteReviewIndex - 1;
      while (prev >= 0 && (noteReviewDone.has(noteReviewNotes[prev].id) || noteReviewSkipped.has(noteReviewNotes[prev].id))) {
        prev--;
      }
      if (prev >= 0) setNoteReviewIndex(prev);
    };

    const markSkip = () => {
      setNoteReviewSkipped(prev => new Set([...prev, note.id]));
      goNext();
    };

    const restartWithSkipped = () => {
      const skippedNotes = noteReviewNotes.filter(n => noteReviewSkipped.has(n.id));
      if (skippedNotes.length > 0) {
        setNoteReviewNotes([...skippedNotes].sort(() => Math.random() - 0.5));
        setNoteReviewIndex(0);
        setNoteReviewDone(new Set());
        setNoteReviewSkipped(new Set());
      }
    };

    // Tekrar planla ve bir sonraki nota geç (SM-2 ile)
    const handleScheduleSM2 = async (quality: 0 | 1 | 2 | 3) => {
      const nextInterval = await scheduleReviewSM2(note, quality);
      if (quality === 0) {
        // Bilmiyorum: "done" olarak işaretlenmez, aynı oturumda tekrar göreceğiz
        setNoteReviewSkipped(prev => new Set([...prev, note.id]));
      } else {
        setNoteReviewDone(prev => new Set([...prev, note.id]));
      }
      goNext();
      return nextInterval;
    };

    if (isFinished) {
      return (
        <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="text-6xl mb-6">🎉</div>
          <h2 className="text-2xl font-bold text-white mb-2">Tekrar Tamamlandı!</h2>
          <p className="text-slate-400 mb-8">{doneCount} not planlandı · {skippedCount} not atlandı</p>
          <div className="flex flex-col gap-3 w-full max-w-xs">
            {skippedCount > 0 && (
              <button onClick={restartWithSkipped} className="w-full py-3 rounded-2xl font-bold text-white bg-amber-600 hover:bg-amber-700 transition-colors">
                Atlananları Tekrar Et ({skippedCount})
              </button>
            )}
            <button onClick={() => startNoteReview(noteReviewNotes)} className="w-full py-3 rounded-2xl font-bold text-white bg-green-600 hover:bg-green-700 transition-colors">
              Baştan Başlat
            </button>
            <button onClick={() => setNoteReviewNotes(null)} className="w-full py-3 rounded-2xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors">
              Kapat
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col animate-in fade-in duration-300">
        {/* Header */}
        <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center gap-3 shrink-0">
          <button onClick={() => setNoteReviewNotes(null)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
            <X size={18} />
          </button>
          <StickyNote size={18} className="text-green-400" />
          <span className="font-bold text-white text-sm">Not Tekrar Modu</span>
          <span className="ml-auto text-xs text-slate-500">{doneCount} planlandı · {skippedCount} atlandı · {remaining} kaldı</span>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-slate-800 shrink-0">
          <div className="h-full bg-green-500 transition-all duration-300" style={{ width: `${((doneCount + skippedCount) / total) * 100}%` }} />
        </div>

        {/* Note card */}
        <div className="flex-1 flex flex-col items-center justify-center p-4 overflow-y-auto">
          <div className="flex items-center gap-2 mb-3 text-xs text-slate-500 flex-wrap justify-center">
            <span className="bg-slate-800 px-2 py-1 rounded-full">{note.subject}</span>
            {note.topic && <span className="bg-slate-800 px-2 py-1 rounded-full">{note.topic}</span>}
            {note.title && <span className="text-slate-400 font-medium">{note.title}</span>}
            {/* FIX: Sayı yerine bilimsel öğrenme seviyesi */}
            {(() => {
              const stage = getNoteLearningStage(note);
              return (
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${stage.color}`}>
                  {stage.emoji} {stage.label}
                </span>
              );
            })()}
          </div>

          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden border-2 border-green-500/30">
            <img src={note.image} alt={note.title || 'Not'} className="w-full h-auto object-contain max-h-[45vh]" />
          </div>

          {(note.pdfName || note.page) && (
            <p className="mt-2 text-[10px] text-slate-600">📄 {note.pdfName}{note.page ? ` · S.${note.page}` : ''}</p>
          )}
          <p className="mt-1 text-xs text-slate-600">{noteReviewIndex + 1} / {total}</p>

          {/* Bilimsel Tekrar — SM-2 Quality butonları */}
          <div className="w-full max-w-lg mt-4">
            <p className="text-xs text-slate-500 text-center mb-2 font-medium">Bu notu ne kadar iyi hatırladın?</p>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'Bilmiyorum', quality: 0 as const, preview: '1 gün', cls: 'bg-rose-600/80 hover:bg-rose-600 border-rose-500/30' },
                { label: 'Zor', quality: 1 as const, preview: 'yakın', cls: 'bg-amber-600/80 hover:bg-amber-600 border-amber-500/30' },
                { label: 'İyi', quality: 2 as const, preview: 'normal', cls: 'bg-emerald-700/80 hover:bg-emerald-700 border-emerald-500/30' },
                { label: 'Kolay', quality: 3 as const, preview: 'uzak', cls: 'bg-blue-700/80 hover:bg-blue-700 border-blue-500/30' },
              ].map(({ label, quality, preview, cls }) => (
                <button
                  key={quality}
                  onClick={() => handleScheduleSM2(quality)}
                  className={`${cls} text-white font-bold py-3 rounded-xl border transition-colors flex flex-col items-center gap-0.5`}
                >
                  <span className="text-xs">{label}</span>
                  <span className="text-[9px] opacity-70">{preview}</span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-slate-600 text-center mt-2">
              Bilimsel tekrar: Bildiğin notlar daha seyrek, unuttuğun notlar daha sık gösterilir.
            </p>
          </div>
        </div>

        {/* Alt navigasyon */}
        <div className="shrink-0 p-3 bg-slate-900/80 border-t border-slate-800">
          <div className="flex gap-3 max-w-lg mx-auto">
            <button onClick={goPrev} disabled={noteReviewIndex === 0} className="px-3 py-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-30 transition-colors">
              <ChevronLeft size={20} />
            </button>
            <button onClick={markSkip} className="flex-1 py-2.5 rounded-xl font-bold text-amber-400 bg-amber-900/30 hover:bg-amber-900/50 transition-colors text-sm">
              Atla →
            </button>
            <button onClick={goNext} className="px-3 py-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
              <ChevronRight size={22} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ── EZBER KARTLARI ────────────────────────────────────────────────────────
  // Ana Ezber sayfası: Ders > Konu gruplaması ile kartları gösterir
  const renderMemorize = () => {
    const grouped: Record<string, Record<string, MemorizeCard[]>> = {};
    // Filtre uygulanmamış gruplar (tüm kartlar)
    memorizeCards.forEach(c => {
      const subj = c.subject || 'Genel';
      const topic = c.topic || 'Konusuz';
      if (!grouped[subj]) grouped[subj] = {};
      if (!grouped[subj][topic]) grouped[subj][topic] = [];
      grouped[subj][topic].push(c);
    });

    const allSubjects = Object.keys(grouped);
    const visibleSubjects = memorizeFilterSubject ? [memorizeFilterSubject].filter(s => grouped[s]) : allSubjects;

    return (
      <div className="min-h-[100dvh] bg-slate-950 flex flex-col animate-in fade-in duration-300">
        {/* Header */}
        <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center gap-2 flex-wrap">
          <button onClick={() => setMode('setup')} className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-800">
            <Home size={20} />
          </button>
          <Book className="text-violet-400" size={20} />
          <h1 className="text-lg font-bold text-white">Ezber Kartları</h1>
          <span className="text-xs text-slate-500">{memorizeCards.length} kart</span>

          <div className="ml-auto flex items-center gap-2">
            {todayMemorizeCards.length > 0 && (
              <button
                onClick={() => startMemorizeReview(todayMemorizeCards)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-colors animate-pulse"
              >
                🔴 Bugün ({todayMemorizeCards.length})
              </button>
            )}
            {memorizeCards.length > 0 && (
              <button
                onClick={() => startMemorizeReview(memorizeCards)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/80 hover:bg-amber-600 text-white rounded-lg text-xs font-bold transition-colors"
              >
                <Gamepad2 size={13} /> Tümü
              </button>
            )}
            <button
              onClick={() => {
                setMemorizeAddMode('single');
                setMemorizeNewSubject(memorizeFilterSubject || '');
                setMemorizeNewTopic(memorizeFilterTopic || '');
                setMemorizeNewFront('');
                setMemorizeNewBack('');
                setMemorizeBulkText('');
                setShowAddMemorizeModal(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-xs font-bold transition-colors shadow-lg shadow-violet-900/30"
            >
              <Plus size={13} /> Yeni
            </button>
          </div>
        </div>

        {/* Filtre çubuğu */}
        {allSubjects.length > 0 && (
          <div className="bg-slate-900/50 border-b border-slate-800 px-4 py-2 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-slate-500 font-medium">Ders:</span>
            <button
              onClick={() => { setMemorizeFilterSubject(''); setMemorizeFilterTopic(''); }}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${!memorizeFilterSubject ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
            >Tümü</button>
            {allSubjects.map(s => (
              <button
                key={s}
                onClick={() => { setMemorizeFilterSubject(s); setMemorizeFilterTopic(''); }}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${memorizeFilterSubject === s ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
              >{s} <span className="opacity-60">({Object.values(grouped[s]).flat().length})</span></button>
            ))}
          </div>
        )}

        {/* İçerik */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {memorizeCards.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-96 text-slate-500 text-center px-6">
              <Book size={64} className="mb-4 opacity-30" />
              <p className="text-base font-medium text-slate-400 mb-2">Henüz ezber kartın yok.</p>
              <p className="text-xs text-slate-600 mb-6 max-w-md">Ezberlemek istediğin bilgileri kart olarak ekle. Örnek: "Van Gölü" → "Türkiye'nin en büyük gölü, sodalı yapıda"</p>
              <button
                onClick={() => { setMemorizeAddMode('single'); setShowAddMemorizeModal(true); }}
                className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-bold transition-colors shadow-lg shadow-violet-900/30"
              ><Plus size={16} /> İlk Kartını Oluştur</button>
            </div>
          ) : (
            visibleSubjects.map(subject => (
              <div key={subject} className="space-y-3">
                <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-violet-500"></div>
                  <h2 className="text-base font-bold text-white">{subject}</h2>
                  <span className="text-xs text-slate-500">({Object.values(grouped[subject]).flat().length} kart)</span>
                  <button
                    onClick={() => startMemorizeReview(Object.values(grouped[subject]).flat())}
                    className="ml-auto flex items-center gap-1 px-2 py-0.5 text-[10px] text-amber-400 hover:bg-amber-900/30 rounded transition-colors"
                  ><Gamepad2 size={10} /> Tekrar Et</button>
                </div>
                {Object.entries(grouped[subject]).map(([topic, cards]) => (
                  <div key={topic} className="ml-3">
                    <div className="flex items-center gap-1.5 mb-2">
                      <NotebookPen size={12} className="text-violet-400" />
                      <h3 className="text-xs font-semibold text-violet-400 uppercase tracking-wider">{topic}</h3>
                      <span className="text-slate-600 text-[10px]">({cards.length})</span>
                      <button
                        onClick={() => startMemorizeReview(cards)}
                        className="ml-auto flex items-center gap-1 px-2 py-0.5 text-[10px] text-amber-400 hover:bg-amber-900/30 rounded transition-colors"
                      ><Gamepad2 size={10} /> Tekrar</button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {cards.map(card => {
                        const stage = getMemorizeCardStage(card);
                        return (
                          <div key={card.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg hover:border-violet-900/50 transition-all duration-300 group">
                            <div className="p-3">
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <p className="text-sm font-semibold text-white flex-1 leading-snug">{card.front}</p>
                                <div className="flex items-center gap-1 shrink-0">
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded border ${stage.color}`} title={`Aralık: ${card.intervalDays ?? 0}g · Tekrar: ${card.reviewCount ?? 0}`}>
                                    {stage.emoji}
                                  </span>
                                  <button
                                    onClick={() => setConfirmModal({ isOpen: true, message: 'Bu kartı silmek istiyor musunuz?', onConfirm: () => deleteMemorizeCard(card.id) })}
                                    className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 transition-all"
                                  ><Trash2 size={12} /></button>
                                </div>
                              </div>
                              <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap">{card.back}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    );
  };

  // Ezber kart ekleme modalı
  const renderAddMemorizeModal = () => {
    if (!showAddMemorizeModal) return null;

    const handleSaveSingle = async () => {
      if (!memorizeNewSubject.trim() || !memorizeNewFront.trim() || !memorizeNewBack.trim()) {
        alert('Ders, ön yüz ve arka yüz gerekli.');
        return;
      }
      const card: MemorizeCard = {
        id: uuidv4(),
        subject: memorizeNewSubject.trim(),
        topic: memorizeNewTopic.trim() || 'Genel',
        front: memorizeNewFront.trim(),
        back: memorizeNewBack.trim(),
        createdAt: Date.now(),
      };
      await addMemorizeCard(card);
      // Ardışık ekleme için front/back'i sıfırla, konu aynı kalsın
      setMemorizeNewFront('');
      setMemorizeNewBack('');
    };

    const handleSaveBulk = async () => {
      if (!memorizeNewSubject.trim() || !memorizeBulkText.trim()) {
        alert('Ders ve kart içeriği gerekli.');
        return;
      }
      // Format: her satır "ön yüz :: arka yüz" veya "ön yüz = arka yüz" veya "ön yüz - arka yüz"
      const lines = memorizeBulkText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const cards: MemorizeCard[] = [];
      const skipped: string[] = [];
      for (const line of lines) {
        // Ayraç sırası: :: > = > -
        let parts: string[] | null = null;
        if (line.includes('::')) parts = line.split('::');
        else if (line.includes(' = ')) parts = line.split(' = ');
        else if (line.includes(' - ')) parts = line.split(' - ');
        else if (line.includes(':')) {
          const idx = line.indexOf(':');
          parts = [line.slice(0, idx), line.slice(idx + 1)];
        }

        if (!parts || parts.length < 2) {
          skipped.push(line);
          continue;
        }
        const front = parts[0].trim();
        const back = parts.slice(1).join(parts.length > 2 ? '::' : '').trim();
        if (!front || !back) {
          skipped.push(line);
          continue;
        }
        cards.push({
          id: uuidv4(),
          subject: memorizeNewSubject.trim(),
          topic: memorizeNewTopic.trim() || 'Genel',
          front, back,
          createdAt: Date.now(),
        });
      }
      if (cards.length === 0) {
        alert('Hiç geçerli kart bulunamadı. Format: "ön yüz :: arka yüz" veya "ön yüz: arka yüz"');
        return;
      }
      await addMemorizeCardsBulk(cards);
      const msg = skipped.length > 0
        ? `${cards.length} kart eklendi. ${skipped.length} satır atlandı (ayraç bulunamadı).`
        : `${cards.length} kart eklendi.`;
      alert(msg);
      setMemorizeBulkText('');
      setShowAddMemorizeModal(false);
    };

    return (
      <div className="fixed inset-0 z-[60] bg-black/80 flex items-end sm:items-center justify-center sm:p-4 overflow-y-auto">
        <div className="bg-slate-900 rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 w-full max-w-lg border border-violet-900/50 shadow-2xl shadow-violet-900/20 sm:my-4 max-h-[90dvh] overflow-y-auto overscroll-contain">
          <div className="flex items-center gap-2 mb-4">
            <Book className="text-violet-400" size={20} />
            <h3 className="text-lg font-bold text-white">Ezber Kartı Ekle</h3>
          </div>

          {/* Mode toggle */}
          <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700 mb-4">
            <button
              onClick={() => setMemorizeAddMode('single')}
              className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${memorizeAddMode === 'single' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >Tek Tek</button>
            <button
              onClick={() => setMemorizeAddMode('bulk')}
              className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${memorizeAddMode === 'bulk' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >Toplu</button>
            <button
              onClick={() => setMemorizeAddMode('youtube')}
              className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1 ${memorizeAddMode === 'youtube' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >📺 YouTube</button>
          </div>

          {/* Ders & Konu */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Ders</label>
              <input
                type="text"
                value={memorizeNewSubject}
                onChange={e => setMemorizeNewSubject(e.target.value)}
                placeholder="Coğrafya"
                list="memorize-subjects-list"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-violet-500 text-sm"
              />
              <datalist id="memorize-subjects-list">
                {SUBJECTS.map(s => <option key={s} value={s} />)}
                {Array.from(new Set(memorizeCards.map(c => c.subject))).map(s => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Konu</label>
              <input
                type="text"
                value={memorizeNewTopic}
                onChange={e => setMemorizeNewTopic(e.target.value)}
                placeholder="Göller"
                list="memorize-topics-list"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-violet-500 text-sm"
              />
              <datalist id="memorize-topics-list">
                {Array.from(new Set(memorizeCards.filter(c => !memorizeNewSubject || c.subject === memorizeNewSubject).map(c => c.topic))).map(t => <option key={t} value={t} />)}
              </datalist>
            </div>
          </div>

          {memorizeAddMode === 'single' ? (
            <>
              <div className="mb-3">
                <label className="block text-xs font-medium text-slate-400 mb-1">Ön Yüz (ipucu / soru)</label>
                <input
                  type="text"
                  value={memorizeNewFront}
                  onChange={e => setMemorizeNewFront(e.target.value)}
                  placeholder="Van Gölü"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-violet-500 text-sm"
                  autoFocus
                />
              </div>
              <div className="mb-4">
                <label className="block text-xs font-medium text-slate-400 mb-1">Arka Yüz (cevap / bilgi)</label>
                <textarea
                  value={memorizeNewBack}
                  onChange={e => setMemorizeNewBack(e.target.value)}
                  placeholder="Türkiye'nin en büyük gölü, sodalı..."
                  rows={3}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-violet-500 text-sm resize-none"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAddMemorizeModal(false)}
                  className="flex-1 py-2.5 rounded-xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors text-sm"
                >Kapat</button>
                <button
                  onClick={handleSaveSingle}
                  className="flex-1 py-2.5 rounded-xl font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors text-sm"
                >Ekle ve Devam Et</button>
              </div>
            </>
          ) : memorizeAddMode === 'bulk' ? (
            <>
              <div className="mb-3">
                <label className="block text-xs font-medium text-slate-400 mb-1">Toplu Kart Girişi</label>
                <p className="text-[10px] text-slate-500 mb-1">Her satıra bir kart. Ön yüz ve arka yüzü <code className="bg-slate-800 px-1 rounded">::</code>, <code className="bg-slate-800 px-1 rounded">=</code> veya <code className="bg-slate-800 px-1 rounded">:</code> ile ayır.</p>
                <textarea
                  value={memorizeBulkText}
                  onChange={e => setMemorizeBulkText(e.target.value)}
                  placeholder={`Van Gölü :: Türkiye'nin en büyük gölü, sodalı\nTuz Gölü :: Türkiye'nin ikinci büyük gölü\nBeyşehir Gölü :: Türkiye'nin en büyük tatlı su gölü\n\nveya\n\nFatih Sultan Mehmet = Panorama 1453\nNamık Kemal = Vatan Yahut Silistre`}
                  rows={10}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-violet-500 text-sm font-mono"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAddMemorizeModal(false)}
                  className="flex-1 py-2.5 rounded-xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors text-sm"
                >Kapat</button>
                <button
                  onClick={handleSaveBulk}
                  className="flex-1 py-2.5 rounded-xl font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors text-sm"
                >Toplu Ekle</button>
              </div>
            </>
          ) : (
            // YouTube sekmesi
            <>
              {!ytJobStatus ? (
                <>
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-slate-400 mb-1">YouTube Video / Playlist Linki</label>
                    <div className="flex gap-2">
                      <input
                        type="url"
                        value={ytUrl}
                        onChange={e => setYtUrl(e.target.value)}
                        placeholder="https://www.youtube.com/watch?v=... veya playlist?list=..."
                        className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-red-500 text-sm"
                      />
                      <button
                        onClick={ytgenFetchPlaylistInfo}
                        disabled={ytLoading || !ytUrl.trim()}
                        className="px-4 py-2 rounded-lg font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors text-sm flex items-center gap-1"
                      >
                        {ytLoading ? <RefreshCw size={14} className="animate-spin" /> : 'Getir'}
                      </button>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1">Türkçe altyazısı olan KPSS konu anlatım videoları için en iyi sonucu verir.</p>
                  </div>

                  {ytVideos.length > 0 && (
                    <>
                      {ytPlaylistName && (
                        <div className="mb-2 flex items-center gap-2 text-xs">
                          <span className="text-slate-400">📺 Playlist:</span>
                          <span className="text-white font-medium truncate">{ytPlaylistName}</span>
                          <span className="text-slate-500">({ytVideos.length} video)</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] text-slate-500">{ytSelected.size} / {ytVideos.length} video seçili</span>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setYtSelected(new Set(ytVideos.map(v => v.id)))}
                            className="text-[10px] text-violet-400 hover:text-violet-300"
                          >Tümünü Seç</button>
                          <span className="text-slate-600 text-[10px]">|</span>
                          <button
                            onClick={() => setYtSelected(new Set())}
                            className="text-[10px] text-slate-400 hover:text-slate-300"
                          >Temizle</button>
                        </div>
                      </div>

                      <div className="border border-slate-700 rounded-lg max-h-56 overflow-y-auto overscroll-contain mb-3">
                        {ytVideos.map((v, idx) => {
                          const selected = ytSelected.has(v.id);
                          return (
                            <label
                              key={v.id}
                              className={`flex items-start gap-2 p-2 cursor-pointer border-b border-slate-800 last:border-0 transition-colors ${selected ? 'bg-red-900/10' : 'hover:bg-slate-800/50'}`}
                            >
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => {
                                  setYtSelected(prev => {
                                    const next = new Set(prev);
                                    if (next.has(v.id)) next.delete(v.id);
                                    else next.add(v.id);
                                    return next;
                                  });
                                }}
                                className="mt-0.5 accent-red-500"
                              />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-white leading-snug">{idx + 1}. {v.title}</p>
                                {v.duration ? (
                                  <p className="text-[9px] text-slate-500 mt-0.5">
                                    {Math.floor(v.duration / 60)}:{String(v.duration % 60).padStart(2, '0')}
                                  </p>
                                ) : null}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => { ytgenReset(); setShowAddMemorizeModal(false); }}
                      className="flex-1 py-2.5 rounded-xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors text-sm"
                    >Kapat</button>
                    {ytVideos.length > 0 && (
                      <button
                        onClick={ytgenStartGeneration}
                        disabled={ytSelected.size === 0}
                        className="flex-1 py-2.5 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors text-sm"
                      >Kart Üret ({ytSelected.size})</button>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-500 text-center mt-2">
                    💡 Üretim arka planda devam eder. Modal'ı kapatabilirsin.
                  </p>
                </>
              ) : (
                // Progress view
                <>
                  <div className="mb-4 bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-3">
                      {ytJobStatus.status === 'processing' ? (
                        <RefreshCw size={16} className="text-red-400 animate-spin" />
                      ) : ytJobStatus.status === 'completed' ? (
                        <CheckCircle size={16} className="text-emerald-400" />
                      ) : (
                        <XCircle size={16} className="text-rose-400" />
                      )}
                      <span className="text-sm font-bold text-white">
                        {ytJobStatus.status === 'processing' && '📺 Kartlar üretiliyor...'}
                        {ytJobStatus.status === 'completed' && '✅ Tamamlandı!'}
                        {ytJobStatus.status === 'cancelled' && '⚠️ İptal edildi'}
                        {ytJobStatus.status === 'error' && '❌ Hata oluştu'}
                      </span>
                    </div>
                    {/* Progress bar */}
                    <div className="h-2 bg-slate-700 rounded-full overflow-hidden mb-2">
                      <div
                        className="h-full bg-gradient-to-r from-red-500 to-red-400 transition-all duration-500"
                        style={{ width: `${(ytJobStatus.done / Math.max(1, ytJobStatus.total)) * 100}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>{ytJobStatus.done} / {ytJobStatus.total} video</span>
                      <span className="font-bold text-emerald-400">{ytJobStatus.cardsCount} kart eklendi</span>
                    </div>
                    {ytJobStatus.current && ytJobStatus.status === 'processing' && (
                      <p className="text-[10px] text-slate-500 mt-2 truncate">
                        🔄 İşleniyor: {ytJobStatus.current}
                      </p>
                    )}
                    {ytJobStatus.errors && ytJobStatus.errors.length > 0 && (
                      <details className="mt-2">
                        <summary className="text-[10px] text-amber-400 cursor-pointer">
                          ⚠️ {ytJobStatus.errors.length} video atlandı
                        </summary>
                        <div className="mt-1 text-[9px] text-slate-500 max-h-24 overflow-y-auto">
                          {ytJobStatus.errors.map((e: string, i: number) => (
                            <p key={i} className="truncate">• {e}</p>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>

                  <div className="flex gap-2">
                    {ytJobStatus.status === 'processing' ? (
                      <>
                        <button
                          onClick={ytgenCancel}
                          className="flex-1 py-2.5 rounded-xl font-bold text-rose-400 bg-rose-900/20 hover:bg-rose-900/40 transition-colors text-sm border border-rose-700/30"
                        >İptal Et</button>
                        <button
                          onClick={() => setShowAddMemorizeModal(false)}
                          className="flex-1 py-2.5 rounded-xl font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors text-sm"
                        >Kapat (Arka planda devam)</button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => { ytgenReset(); }}
                          className="flex-1 py-2.5 rounded-xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors text-sm"
                        >Yeni Üretim</button>
                        <button
                          onClick={() => { ytgenReset(); setShowAddMemorizeModal(false); }}
                          className="flex-1 py-2.5 rounded-xl font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors text-sm"
                        >Kapat</button>
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  // Ezber tekrar ekranı — flashcard (ön yüz → tıkla arka yüz → SM-2 butonları)
  // ═══════════════════════════════════════════════════════════════════════
  // ⏱ ÇALIŞMA SAYACI — Render
  // ═══════════════════════════════════════════════════════════════════════
  const renderCalisma = () => {
    const preset = STUDY_PRESETS.find(p => p.id === studyState.mode)!;
    const now = Date.now();
    
    // Mevcut fazdaki geçen/kalan süre
    let phaseElapsed = 0;
    let phaseTarget = 0;
    let phaseRemaining = 0;
    if (studyState.phase === 'working' || studyState.phase === 'break') {
      phaseElapsed = Math.floor((now - studyState.phaseStartedAt) / 1000);
      const isLongBreak = studyState.phase === 'break' && 
        studyState.completedWorkBlocks > 0 && 
        studyState.completedWorkBlocks % preset.longBreakEvery === 0;
      if (studyState.phase === 'working') {
        phaseTarget = preset.id === 'flexible' ? 0 : preset.workMin * 60;
      } else {
        phaseTarget = (isLongBreak ? preset.longBreakMin : preset.breakMin) * 60;
      }
      phaseRemaining = Math.max(0, phaseTarget - phaseElapsed);
    } else if (studyState.phase === 'paused') {
      phaseElapsed = studyState.accumulatedInPhase;
      phaseTarget = preset.workMin * 60;
      phaseRemaining = Math.max(0, phaseTarget - phaseElapsed);
    }

    // Bugünün gerçek anlık toplamı (aktif çalışma varsa ekle)
    const liveTotal = studyState.todayTotalSeconds + 
      (studyState.phase === 'working' 
        ? Math.max(0, phaseElapsed - studyState.accumulatedInPhase) 
        : 0);
    const goalSec = studyGoalMinutes * 60;
    const goalProgress = Math.min(100, (liveTotal / goalSec) * 100);

    const formatMMSS = (sec: number) => {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    };
    const formatHMS = (sec: number) => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      if (h > 0) return `${h}s ${m}dk`;
      return `${m}dk`;
    };

    const todayBlocksLabel = studyState.completedWorkBlocks > 0
      ? `${studyState.completedWorkBlocks} blok tamamlandı`
      : 'Henüz blok yok';

    // Son 7 gün
    const last7 = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const rec = key === studyState.todayDate
        ? { date: key, totalSeconds: liveTotal }
        : studyHistory.find(h => h.date === key) || { date: key, totalSeconds: 0 };
      return { ...rec, dayLabel: ['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'][(d.getDay() + 6) % 7] };
    });
    const weekTotal = last7.reduce((s, d) => s + d.totalSeconds, 0);
    const weekAvg = Math.floor(weekTotal / 7);
    const maxDaySec = Math.max(goalSec, ...last7.map(d => d.totalSeconds));

    // Streak
    const computeStreak = () => {
      let streak = 0;
      const threshold = 60 * 60; // en az 1 saat sayılır
      for (let i = 0; i < 365; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const total = key === studyState.todayDate 
          ? liveTotal 
          : (studyHistory.find(h => h.date === key)?.totalSeconds || 0);
        if (total >= threshold) streak++;
        else if (i > 0) break;
      }
      return streak;
    };
    const streak = computeStreak();

    const isRunning = studyState.phase === 'working' || studyState.phase === 'break';

    return (
      <div className="min-h-[100dvh] bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex flex-col animate-in fade-in duration-300">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-slate-950/90 backdrop-blur-xl border-b border-slate-800 px-3 py-2.5 flex items-center justify-between">
          <button onClick={() => setMode('setup')} className="text-slate-400 hover:text-white p-1.5 rounded-lg bg-slate-800/60">
            <Home size={16} />
          </button>
          <h1 className="text-base font-bold text-white flex items-center gap-1.5">⏱ Çalışma Sayacı</h1>
          <div className="w-7" />
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Aktif faz — büyük sayaç */}
          <div className={`rounded-3xl p-6 border-2 transition-all ${
            studyState.phase === 'working' 
              ? 'bg-gradient-to-br from-emerald-950/60 to-green-950/40 border-emerald-500/40 shadow-lg shadow-emerald-900/30' 
              : studyState.phase === 'break' 
              ? 'bg-gradient-to-br from-amber-950/60 to-orange-950/40 border-amber-500/40' 
              : studyState.phase === 'paused'
              ? 'bg-gradient-to-br from-slate-900 to-slate-950 border-slate-600/40'
              : 'bg-gradient-to-br from-slate-900 to-slate-950 border-slate-700/40'
          }`}>
            <div className="text-center">
              <div className="text-[10px] uppercase tracking-widest text-slate-400 mb-1">
                {studyState.phase === 'working' && `${preset.icon} ODAKLAN`}
                {studyState.phase === 'break' && '☕ MOLA'}
                {studyState.phase === 'paused' && '⏸ DURAKLATILDI'}
                {studyState.phase === 'idle' && `${preset.icon} ${preset.name.toUpperCase()} HAZIR`}
              </div>
              <div className="text-6xl font-bold font-mono text-white my-2 leading-none tabular-nums">
                {studyState.phase === 'idle' 
                  ? formatMMSS(preset.workMin * 60)
                  : preset.id === 'flexible' && studyState.phase === 'working'
                  ? formatMMSS(phaseElapsed)
                  : formatMMSS(phaseRemaining)}
              </div>
              <div className="text-xs text-slate-400">
                {studyState.phase === 'working' && preset.id !== 'flexible' && `${formatMMSS(phaseElapsed)} çalışıldı`}
                {studyState.phase === 'working' && preset.id === 'flexible' && 'Ne kadar istersen'}
                {studyState.phase === 'break' && 'Molada dinlen, su iç'}
                {studyState.phase === 'paused' && 'Devam etmek için play tuşuna bas'}
                {studyState.phase === 'idle' && `${todayBlocksLabel} · ${preset.workMin}/${preset.breakMin} dk döngü`}
              </div>
            </div>

            {/* Progress bar */}
            {isRunning && preset.id !== 'flexible' && (
              <div className="mt-4 h-1.5 bg-slate-900/60 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all ${studyState.phase === 'working' ? 'bg-emerald-500' : 'bg-amber-500'}`}
                  style={{ width: `${phaseTarget > 0 ? (phaseElapsed / phaseTarget) * 100 : 0}%` }}
                />
              </div>
            )}

            {/* Controls */}
            <div className="flex items-center justify-center gap-2 mt-5">
              {studyState.phase === 'idle' && (
                <button
                  onClick={startStudyWork}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-8 py-3 rounded-xl text-sm shadow-lg shadow-emerald-900/40 transition-all"
                >▶ Başlat</button>
              )}
              {studyState.phase === 'working' && (
                <>
                  <button
                    onClick={pauseStudy}
                    className="bg-slate-700 hover:bg-slate-600 text-white font-bold px-5 py-2.5 rounded-xl text-xs transition-colors"
                  >⏸ Duraklat</button>
                  <button
                    onClick={() => startStudyBreak(false)}
                    className="bg-amber-600 hover:bg-amber-500 text-white font-bold px-5 py-2.5 rounded-xl text-xs transition-colors"
                  >☕ Mola Al</button>
                  <button
                    onClick={stopStudy}
                    className="bg-rose-700 hover:bg-rose-600 text-white font-bold px-4 py-2.5 rounded-xl text-xs transition-colors"
                  >⏹</button>
                </>
              )}
              {studyState.phase === 'break' && (
                <>
                  <button
                    onClick={resumeStudyWork}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-6 py-2.5 rounded-xl text-xs transition-colors"
                  >▶ Çalışmaya Dön</button>
                  <button
                    onClick={stopStudy}
                    className="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-2.5 rounded-xl text-xs transition-colors"
                  >⏹ Bitir</button>
                </>
              )}
              {studyState.phase === 'paused' && (
                <>
                  <button
                    onClick={startStudyWork}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-6 py-2.5 rounded-xl text-xs"
                  >▶ Devam</button>
                  <button
                    onClick={stopStudy}
                    className="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-2.5 rounded-xl text-xs"
                  >⏹ Bitir</button>
                </>
              )}
            </div>
          </div>

          {/* Bugünkü hedef */}
          <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-slate-200">🎯 Bugünkü Hedef</h3>
              <span className={`text-xs font-bold ${goalProgress >= 100 ? 'text-emerald-400' : 'text-blue-400'}`}>
                {formatHMS(liveTotal)} / {Math.floor(studyGoalMinutes/60)}s {studyGoalMinutes%60}dk
              </span>
            </div>
            <div className="h-3 bg-slate-900/60 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all ${
                  goalProgress >= 100 ? 'bg-emerald-500' : 
                  goalProgress >= 75 ? 'bg-blue-500' : 
                  goalProgress >= 40 ? 'bg-amber-500' : 'bg-rose-500'
                }`}
                style={{ width: `${goalProgress}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-1.5 text-[10px] text-slate-500">
              <span>%{Math.round(goalProgress)} tamamlandı</span>
              <span>
                {studyCustomGoal > 0 
                  ? 'Manuel hedef' 
                  : examDate ? `Sınava göre adaptif (${Math.max(0, Math.ceil((new Date(examDate).getTime() - Date.now()) / 86400000))}g)` : 'Varsayılan'}
              </span>
            </div>
          </div>

          {/* Mod seçimi */}
          {studyState.phase === 'idle' && (
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
              <h3 className="text-sm font-bold text-slate-200 mb-3">⚙️ Çalışma Modu</h3>
              <div className="grid grid-cols-2 gap-2">
                {STUDY_PRESETS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setStudyState(s => ({ ...s, mode: p.id }))}
                    className={`text-left rounded-xl p-3 border transition-all ${
                      studyState.mode === p.id
                        ? 'bg-blue-600/20 border-blue-500/40 ring-1 ring-blue-500/40'
                        : 'bg-slate-900/40 border-slate-700/30 hover:border-slate-600/50'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-lg">{p.icon}</span>
                      <span className="text-xs font-bold text-white">{p.name}</span>
                    </div>
                    <div className="text-[10px] text-slate-400 mb-1">
                      {p.id === 'flexible' ? 'Sınırsız süre' : `${p.workMin}/${p.breakMin} dk`}
                    </div>
                    <div className="text-[9px] text-slate-500 leading-tight">{p.description}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Son 7 gün grafik */}
          <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-slate-200">📈 Son 7 Gün</h3>
              <div className="text-right">
                <div className="text-[10px] text-slate-500">Haftalık ort.</div>
                <div className="text-xs font-bold text-blue-400">{formatHMS(weekAvg)}/gün</div>
              </div>
            </div>
            <div className="flex items-end justify-between gap-1.5 h-24">
              {last7.map((d, i) => {
                const hitGoal = d.totalSeconds >= goalSec;
                const heightPct = maxDaySec > 0 ? (d.totalSeconds / maxDaySec) * 100 : 0;
                const isToday = i === 6;
                return (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                    <div className="flex-1 w-full flex flex-col justify-end">
                      <div
                        className={`w-full rounded-t-md transition-all ${
                          hitGoal ? 'bg-emerald-500' :
                          d.totalSeconds > goalSec * 0.5 ? 'bg-blue-500' :
                          d.totalSeconds > 0 ? 'bg-amber-500' : 'bg-slate-700'
                        } ${isToday ? 'ring-2 ring-white/20' : ''}`}
                        style={{ height: `${Math.max(2, heightPct)}%` }}
                        title={`${d.dayLabel}: ${formatHMS(d.totalSeconds)}`}
                      />
                    </div>
                    <div className={`text-[9px] ${isToday ? 'text-white font-bold' : 'text-slate-500'}`}>
                      {d.dayLabel}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-3 text-[9px] text-slate-400">
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-emerald-500 rounded-sm" /> Hedefe ulaştın</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-blue-500 rounded-sm" /> &gt;%50</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-amber-500 rounded-sm" /> Eksik</span>
            </div>
          </div>

          {/* Streak + istatistik */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-orange-400">🔥 {streak}</div>
              <div className="text-[9px] text-slate-400">gün seri</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-blue-400">{studyState.completedWorkBlocks}</div>
              <div className="text-[9px] text-slate-400">bugün blok</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-violet-400">{formatHMS(weekTotal)}</div>
              <div className="text-[9px] text-slate-400">bu hafta</div>
            </div>
          </div>

          {/* Manuel hedef */}
          <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
            <h3 className="text-sm font-bold text-slate-200 mb-2">🎛 Günlük Hedefi Özelleştir</h3>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={720}
                value={studyCustomGoal || ''}
                onChange={e => setStudyCustomGoal(Math.max(0, Math.min(720, parseInt(e.target.value) || 0)))}
                placeholder="Dakika (boş = adaptif)"
                className="flex-1 bg-slate-900/60 border border-slate-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600"
              />
              {studyCustomGoal > 0 && (
                <button
                  onClick={() => setStudyCustomGoal(0)}
                  className="text-xs text-slate-400 hover:text-rose-400 px-2"
                >Temizle</button>
              )}
            </div>
            <div className="text-[10px] text-slate-500 mt-1">
              {studyCustomGoal > 0 
                ? `Manuel: ${Math.floor(studyCustomGoal/60)}s ${studyCustomGoal%60}dk`
                : `Adaptif — sınav yaklaştıkça hedef otomatik artar (şu an ${Math.floor(studyGoalMinutes/60)}s ${studyGoalMinutes%60}dk)`}
            </div>
          </div>

          {/* Bildirim ayarları */}
          <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
            <h3 className="text-sm font-bold text-slate-200 mb-2">🔔 Bildirimler</h3>
            <label className="flex items-center justify-between py-1.5 cursor-pointer">
              <div>
                <div className="text-xs text-white">🌐 Tarayıcı bildirimi</div>
                <div className="text-[10px] text-slate-500">Mola başlar/biter uyarısı</div>
              </div>
              <input
                type="checkbox"
                checked={studyBrowserNotifOn}
                onChange={e => setStudyBrowserNotifOn(e.target.checked)}
                className="w-4 h-4"
              />
            </label>
            <label className="flex items-center justify-between py-1.5 cursor-pointer">
              <div>
                <div className="text-xs text-white">📱 Telegram bildirimi</div>
                <div className="text-[10px] text-slate-500">Başla/bitir/mola mesajları</div>
              </div>
              <input
                type="checkbox"
                checked={studyTelegramOn}
                onChange={e => setStudyTelegramOn(e.target.checked)}
                className="w-4 h-4"
              />
            </label>
          </div>

          {/* Bilimsel not */}
          <div className="bg-gradient-to-br from-indigo-950/40 to-violet-950/30 border border-indigo-700/30 rounded-2xl p-4 text-xs text-indigo-200/80 leading-relaxed">
            <div className="font-bold text-indigo-300 mb-1">💡 Bilimsel Not</div>
            <p>Odaklanma süresi 20-90 dk arası sağlıklıdır. Sürekli &gt;8 saat çalışmak verimi düşürür (overlearning). 
               Ardışık günlerde çalışmamak &gt; 2 gün → öğrenilen bilgilerin %40'ı 7 gün içinde unutulur (Ebbinghaus).</p>
          </div>

          <div className="h-4" />
        </div>
      </div>
    );
  };


  // ═══════════════════════════════════════════════════════════════════════
  // 📊 ANALİZ — Zayıf Konu + Hata Günlüğü + Sınav Geri Sayımı
  // ═══════════════════════════════════════════════════════════════════════
  const renderAnaliz = () => {
    const days = daysToExam();
    const intensity = examIntensity();
    const intensityColor = {
      'normal': 'text-emerald-400 bg-emerald-900/20 border-emerald-700/30',
      'orta': 'text-blue-400 bg-blue-900/20 border-blue-700/30',
      'yogun': 'text-amber-400 bg-amber-900/20 border-amber-700/30',
      'kritik': 'text-rose-400 bg-rose-900/20 border-rose-700/30',
    }[intensity];
    const intensityLabel = {
      'normal': '📚 Normal Tempo',
      'orta': '⚡ Orta Tempo',
      'yogun': '🔥 Yoğun Tempo',
      'kritik': '🚨 Kritik Dönem',
    }[intensity];

    return (
      <div className="min-h-[100dvh] bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex flex-col animate-in fade-in duration-300">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-slate-950/90 backdrop-blur-xl border-b border-slate-800 px-3 py-2.5 flex items-center justify-between">
          <button
            onClick={() => setMode('setup')}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg bg-slate-800/60"
          ><Home size={16} /></button>
          <h1 className="text-base font-bold text-white flex items-center gap-1.5">📊 Analiz & Hatalarım</h1>
          <div className="w-7" />
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* SINAV GERİ SAYIMI */}
          <div className={`rounded-2xl p-4 border ${intensityColor}`}>
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider opacity-70 mb-0.5">KPSS Önlisans Sınavı</div>
                {days !== null ? (
                  <>
                    <div className="text-3xl font-bold leading-none">
                      {days === 0 ? 'BUGÜN!' : `${days} gün`}
                    </div>
                    <div className="text-xs opacity-80 mt-1">{intensityLabel}</div>
                  </>
                ) : (
                  <>
                    <div className="text-sm font-bold">Tarih belirlenmemiş</div>
                    <div className="text-[11px] opacity-80 mt-0.5">Sistem akıllı tekrar için tarihi bilmesi gerek</div>
                  </>
                )}
              </div>
              <input
                type="date"
                value={examDate}
                onChange={e => persistExamDate(e.target.value)}
                className="bg-slate-900/60 border border-slate-700/50 rounded-lg px-2 py-1 text-xs text-white"
              />
            </div>
            {days !== null && days > 0 && (
              <div className="text-[11px] opacity-90 leading-relaxed">
                {intensity === 'kritik' && '⚠️ Yeni soru ekleme azaltıldı, tüm hataların her oturumda tekrar gelir. Eski tekrarları pekiştirme zamanı.'}
                {intensity === 'yogun' && '💪 Hatalı soruların %50\'si bonus tekrar olarak eklendi. Yeni soru sayısı düşürüldü.'}
                {intensity === 'orta' && '📖 Hatalı soruların %30\'u bonus tekrar olarak eklendi. Tempoyu artırma vakti.'}
                {intensity === 'normal' && '🎯 Standart SM-2 algoritması aktif. Yeni soru ekleyerek tabanı genişletme zamanı.'}
              </div>
            )}
          </div>

          {/* GENEL DURUM */}
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-cyan-400">{analyzeStats.totalQuestions}</div>
              <div className="text-[9px] text-slate-400">Toplam Soru</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-blue-400">{analyzeStats.reviewedQuestions}</div>
              <div className="text-[9px] text-slate-400">Çalışıldı</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-violet-400">{analyzeStats.masteredCount}</div>
              <div className="text-[9px] text-slate-400">🏆 Kalıcı</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-rose-400">{analyzeStats.errorBook.length}</div>
              <div className="text-[9px] text-slate-400">📕 Hatalı</div>
            </div>
          </div>

          {/* DERS BAZLI BAŞARI */}
          {Object.keys(analyzeStats.bySubject).length > 0 && (
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
              <h3 className="text-sm font-bold text-slate-200 mb-3">📖 Ders Bazlı Performans</h3>
              <div className="space-y-2">
                {Object.entries(analyzeStats.bySubject)
                  .sort((a, b) => b[1].total - a[1].total)
                  .map(([subj, s]) => {
                    const masteredPct = s.total > 0 ? (s.mastered / s.total) * 100 : 0;
                    const errorPct = s.total > 0 ? (s.wrong / s.total) * 100 : 0;
                    return (
                      <div key={subj}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-white font-medium">{subj}</span>
                          <span className="text-slate-400">{s.total} soru</span>
                        </div>
                        <div className="h-2 bg-slate-900/60 rounded-full overflow-hidden flex">
                          <div className="bg-emerald-500" style={{ width: `${masteredPct}%` }} title="Kalıcı" />
                          <div className="bg-rose-500" style={{ width: `${errorPct}%` }} title="Hatalı" />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-slate-500 mt-0.5">
                          <span>🏆 {s.mastered} kalıcı</span>
                          <span>📕 {s.wrong} hatalı</span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* EN ZAYIF KONULAR */}
          {analyzeStats.weakest.length > 0 && (
            <div className="bg-rose-950/20 border border-rose-700/30 rounded-2xl p-4">
              <h3 className="text-sm font-bold text-rose-300 mb-2 flex items-center gap-1.5">
                ⚠️ En Zayıf Konuların
                <span className="text-[10px] text-slate-500 font-normal">(en çok yanlış bildiklerin)</span>
              </h3>
              <div className="space-y-1.5">
                {analyzeStats.weakest.slice(0, 5).map((t, i) => (
                  <button
                    key={`${t.subject}-${t.topic}`}
                    onClick={() => {
                      setUstasiFilterSubject(t.subject);
                      setMode('setup');
                      setTimeout(() => alert(`Önce ⚡ KPSS Ustası'na git → ${t.subject} dersi seçildi → Başla`), 100);
                    }}
                    className="w-full flex items-center justify-between bg-rose-900/20 hover:bg-rose-900/30 border border-rose-700/20 rounded-xl px-3 py-2 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="text-rose-400 font-bold text-sm">{i + 1}.</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{t.topic}</div>
                        <div className="text-[10px] text-rose-300/70">{t.subject} • {t.total} soru</div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-lg font-bold text-rose-400">%{Math.round(t.errorRate * 100)}</div>
                      <div className="text-[9px] text-slate-500">hata oranı</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* HATA GÜNLÜĞÜ */}
          {analyzeStats.errorBook.length > 0 && (
            <div className="bg-amber-950/20 border border-amber-700/30 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-amber-300 flex items-center gap-1.5">
                  📕 Hatalarım Günlüğü
                  <span className="text-[10px] text-slate-500 font-normal">({analyzeStats.errorBook.length} soru)</span>
                </h3>
                <button
                  onClick={() => {
                    // Sadece hatalı soruları queue'ya at
                    const errorQ = analyzeStats.errorBook;
                    if (errorQ.length === 0) { alert('Hatalı soru yok!'); return; }
                    setUstasiQueue([...errorQ].sort(() => Math.random() - 0.5));
                    setUstasiIndex(0);
                    setUstasiSelectedAnswer(null);
                    setUstasiShowResult(false);
                    setUstasiSessionStats({ correct: 0, wrong: 0, xpGained: 0, startTime: Date.now(), relapseQueue: [] });
                    setMode('ustasi');
                  }}
                  className="text-xs bg-amber-600 hover:bg-amber-500 text-white font-bold px-3 py-1.5 rounded-lg transition-colors"
                >Hepsini Tekrar Et</button>
              </div>
              <div className="space-y-2 max-h-72 overflow-y-auto overscroll-contain">
                {analyzeStats.errorBook.slice(0, 20).map((q) => {
                  const lapses = q.srsLapses || 0;
                  const lastDate = q.srsLastReviewedAt ? new Date(q.srsLastReviewedAt).toLocaleDateString('tr') : 'Hiç';
                  return (
                    <div
                      key={q.id}
                      className="bg-amber-900/10 border border-amber-700/20 rounded-xl p-2 flex gap-2 items-center"
                    >
                      <img src={q.image} alt="Soru" className="w-14 h-14 rounded-lg object-cover bg-white shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] text-white truncate">{q.subject}{q.topic ? ` / ${q.topic}` : ''}</div>
                        <div className="text-[9px] text-amber-300/70 mt-0.5">
                          ❌ {lapses} kez yanlış • Son: {lastDate}
                        </div>
                      </div>
                      <div className="text-right shrink-0 px-1">
                        <div className="text-[11px] font-bold text-amber-400">{getStageEmoji(q.srsStage)}</div>
                        <div className="text-[9px] text-slate-500">{getStageLabel(q.srsStage)}</div>
                      </div>
                    </div>
                  );
                })}
                {analyzeStats.errorBook.length > 20 && (
                  <div className="text-center text-[10px] text-slate-500 pt-1">
                    +{analyzeStats.errorBook.length - 20} soru daha…
                  </div>
                )}
              </div>
            </div>
          )}

          {/* EN GÜÇLÜ KONULAR */}
          {analyzeStats.strongest.length > 0 && (
            <div className="bg-emerald-950/20 border border-emerald-700/30 rounded-2xl p-4">
              <h3 className="text-sm font-bold text-emerald-300 mb-2 flex items-center gap-1.5">
                💪 En Güçlü Konuların
              </h3>
              <div className="grid grid-cols-2 gap-1.5">
                {analyzeStats.strongest.slice(0, 6).map(t => (
                  <div
                    key={`${t.subject}-${t.topic}`}
                    className="bg-emerald-900/15 border border-emerald-700/20 rounded-lg px-2 py-1.5"
                  >
                    <div className="text-[11px] text-white truncate">{t.topic}</div>
                    <div className="text-[9px] text-emerald-400">{t.subject} • %{Math.round((1 - t.errorRate) * 100)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TELEGRAM HATIRLATMA AYARI */}
          <div className="bg-blue-950/20 border border-blue-700/30 rounded-2xl p-4">
            <h3 className="text-sm font-bold text-blue-300 mb-2 flex items-center gap-1.5">
              🤖 Telegram Hatırlatmaları
            </h3>
            <p className="text-[11px] text-slate-300 leading-relaxed mb-2">
              Telegram botun her sabah 08:00'da bekleyen soru sayını ve günlük performansını mesaj atacak.
            </p>
            <div className="text-[10px] text-slate-400 space-y-0.5">
              <div>• <span className="text-emerald-400">100+ gün</span>: Günde 1 mesaj (sabah)</div>
              <div>• <span className="text-blue-400">60-100 gün</span>: Günde 1 mesaj + akşam ek</div>
              <div>• <span className="text-amber-400">30-60 gün</span>: Günde 2 mesaj (sabah + akşam)</div>
              <div>• <span className="text-rose-400">&lt;30 gün</span>: Günde 3 mesaj (sabah + öğle + akşam)</div>
            </div>
            {days !== null && (
              <div className="mt-2 text-[10px] text-blue-300 font-medium">
                Şu anki tempo: {intensityLabel}
              </div>
            )}
          </div>

          <div className="h-4" />
        </div>
      </div>
    );
  };


  // ═══════════════════════════════════════════════════════════════════════
  // ⚡ KPSS USTASI — Render
  // ═══════════════════════════════════════════════════════════════════════
  const renderUstasi = () => {
    const q = ustasiQueue[ustasiIndex];
    const sessionTotal = ustasiQueue.length;
    const sessionDone = ustasiIndex;
    const isFinished = !q || ustasiIndex >= ustasiQueue.length;
    const sessionAccuracy = ustasiSessionStats.correct + ustasiSessionStats.wrong > 0
      ? Math.round((ustasiSessionStats.correct / (ustasiSessionStats.correct + ustasiSessionStats.wrong)) * 100)
      : 0;
    const dueCount = savedQuestions.filter(sq =>
      sq.correctAnswer && sq.srsNextReview && sq.srsNextReview <= Date.now()
    ).length;
    const newCount = savedQuestions.filter(sq => sq.correctAnswer && !sq.srsReviewCount).length;

    // Oturum sonu ekranı
    if (isFinished) {
      const elapsed = Math.round((Date.now() - ustasiSessionStats.startTime) / 60000);
      return (
        <div className="min-h-[100dvh] bg-gradient-to-br from-slate-950 via-violet-950/20 to-slate-950 flex items-center justify-center p-4 animate-in fade-in duration-500">
          <div className="max-w-md w-full bg-slate-900/80 backdrop-blur-xl border border-violet-500/30 rounded-3xl p-6 shadow-2xl shadow-violet-900/20">
            <div className="text-center mb-6">
              <div className="text-6xl mb-3">🎉</div>
              <h2 className="text-2xl font-bold text-white mb-1">Oturum Tamamlandı!</h2>
              <p className="text-sm text-slate-400">Bilimsel tekrar tamamlandı</p>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="bg-emerald-950/40 border border-emerald-700/30 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-emerald-400">{ustasiSessionStats.correct}</div>
                <div className="text-[10px] text-emerald-200/60">Doğru</div>
              </div>
              <div className="bg-rose-950/40 border border-rose-700/30 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-rose-400">{ustasiSessionStats.wrong}</div>
                <div className="text-[10px] text-rose-200/60">Yanlış</div>
              </div>
              <div className="bg-violet-950/40 border border-violet-700/30 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-violet-400">+{ustasiSessionStats.xpGained}</div>
                <div className="text-[10px] text-violet-200/60">XP kazandın</div>
              </div>
              <div className="bg-amber-950/40 border border-amber-700/30 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-amber-400">%{sessionAccuracy}</div>
                <div className="text-[10px] text-amber-200/60">Başarı</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-3 mb-5 text-center">
              <p className="text-xs text-slate-400">Süre: <span className="text-white font-bold">{elapsed} dk</span> • Seviye: <span className="text-violet-300 font-bold">{reviewStats.level}</span> • Seri: <span className="text-orange-400 font-bold">🔥 {reviewStats.dailyStreak}</span></p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setMode('saved_questions')}
                className="flex-1 py-3 rounded-xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors text-sm"
              >Sorular</button>
              <button
                onClick={() => { setUstasiShowStats(true); }}
                className="flex-1 py-3 rounded-xl font-bold text-white bg-violet-600 hover:bg-violet-500 transition-colors text-sm"
              >📊 İstatistikler</button>
            </div>
            <button
              onClick={() => {
                const q = getUstasiQueue();
                if (q.length === 0) {
                  alert('Bugün için başka soru kalmadı!');
                  return;
                }
                setUstasiQueue(q);
                setUstasiIndex(0);
                setUstasiSessionStats({ correct: 0, wrong: 0, xpGained: 0, startTime: Date.now(), relapseQueue: [] });
              }}
              className="w-full mt-2 py-2.5 rounded-xl font-medium text-violet-300 bg-violet-950/40 hover:bg-violet-900/40 transition-colors text-xs border border-violet-700/30"
            >Yeni Oturum Başlat</button>
          </div>
        </div>
      );
    }

    const isCorrect = ustasiSelectedAnswer === q.correctAnswer;
    const answers = ['A', 'B', 'C', 'D', 'E'];

    return (
      <div className="min-h-[100dvh] bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex flex-col animate-in fade-in duration-300">
        {/* Başarım toast */}
        {ustasiAchievementToast && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-gradient-to-r from-amber-500 to-yellow-500 text-amber-950 px-5 py-3 rounded-full font-bold shadow-2xl animate-in slide-in-from-top duration-500">
            {ustasiAchievementToast}
          </div>
        )}

        {/* Header */}
        <div className="sticky top-0 z-20 bg-slate-950/90 backdrop-blur-xl border-b border-violet-900/30 px-3 py-2">
          <div className="flex items-center justify-between gap-2 mb-2">
            <button
              onClick={() => {
                if (confirm('Oturumu bitir? İlerlemen kaydedildi.')) {
                  setMode('saved_questions');
                }
              }}
              className="text-slate-400 hover:text-white p-1.5 rounded-lg transition-colors bg-slate-800/60"
            ><X size={16} /></button>
            <div className="flex-1 flex items-center gap-2 text-xs">
              <span className="text-violet-300 font-bold">⚡ {sessionDone + 1}/{sessionTotal}</span>
              <span className="text-orange-400">🔥 {reviewStats.dailyStreak}</span>
              <span className="text-emerald-400">+{ustasiSessionStats.xpGained} XP</span>
            </div>
            <button
              onClick={() => setUstasiShowStats(true)}
              className="text-slate-400 hover:text-white p-1.5 rounded-lg transition-colors bg-slate-800/60"
              title="İstatistikler"
            >📊</button>
          </div>
          {/* Progress bar */}
          <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
              style={{ width: `${((sessionDone + 1) / sessionTotal) * 100}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="text-slate-400">{getStageEmoji(q.srsStage)} {getStageLabel(q.srsStage)}</span>
              <span className="text-slate-600">•</span>
              <span className={q.difficulty === 'Zor' ? 'text-rose-400' : (q.difficulty === 'Kolay' ? 'text-emerald-400' : 'text-amber-400')}>
                {q.difficulty}
              </span>
              <span className="text-slate-600">•</span>
              <span className="text-slate-500">{q.subject}{q.topic ? ` / ${q.topic}` : ''}</span>
            </div>
            <div className="text-[10px] text-slate-500">
              {q.srsReviewCount ? `${q.srsReviewCount}. tekrar` : 'Yeni soru'}
            </div>
          </div>
        </div>

        {/* Soru görüntüsü */}
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <div className="max-w-2xl mx-auto">
            <div className="bg-white rounded-2xl overflow-hidden shadow-2xl shadow-black/50 mb-4">
              <img src={q.image} alt="Soru" className="w-full h-auto" />
            </div>

            {/* Cevap seçenekleri */}
            {!ustasiShowResult ? (
              <div className="grid grid-cols-5 gap-2 mb-4">
                {answers.map(ans => (
                  <button
                    key={ans}
                    onClick={() => ustasiSelectAnswer(ans)}
                    className="aspect-square rounded-xl bg-slate-800 hover:bg-violet-600 border border-slate-700 hover:border-violet-400 text-white font-bold text-xl transition-all hover:scale-105 active:scale-95"
                  >{ans}</button>
                ))}
              </div>
            ) : (
              <>
                {/* Sonuç */}
                <div className={`rounded-2xl p-4 mb-3 border-2 ${isCorrect ? 'bg-emerald-950/40 border-emerald-500/50' : 'bg-rose-950/40 border-rose-500/50'}`}>
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-2xl ${isCorrect ? 'bg-emerald-500/20' : 'bg-rose-500/20'}`}>
                      {isCorrect ? '✓' : '✗'}
                    </div>
                    <div className="flex-1">
                      <p className={`font-bold ${isCorrect ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {isCorrect ? 'Doğru!' : 'Yanlış'}
                      </p>
                      <p className="text-xs text-slate-400">
                        Senin cevabın: <span className="font-bold text-white">{ustasiSelectedAnswer}</span> • Doğru cevap: <span className="font-bold text-emerald-400">{q.correctAnswer}</span>
                      </p>
                    </div>
                  </div>
                  {q.notes && (
                    <div className="mt-3 pt-3 border-t border-slate-700/30">
                      <p className="text-[10px] font-bold text-slate-400 mb-1">NOTLAR</p>
                      <p className="text-xs text-slate-200 whitespace-pre-wrap">{q.notes}</p>
                    </div>
                  )}
                </div>

                {/* SM-2 butonları */}
                <div className="bg-slate-900/80 border border-slate-700/50 rounded-2xl p-3">
                  <p className="text-[10px] text-center text-slate-400 mb-2">🧠 Bu soruyu ne kadar kolay hatırladın?</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => ustasiGrade(0)}
                      className="py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm transition-all active:scale-95 flex flex-col items-center gap-0.5"
                    >
                      <span className="text-lg">😰</span>
                      <span className="text-xs">Bilmiyordum</span>
                      <span className="text-[9px] opacity-70">10dk sonra tekrar</span>
                    </button>
                    <button
                      onClick={() => ustasiGrade(2)}
                      className="py-3 rounded-xl bg-orange-600 hover:bg-orange-500 text-white font-bold text-sm transition-all active:scale-95 flex flex-col items-center gap-0.5"
                    >
                      <span className="text-lg">🤔</span>
                      <span className="text-xs">Zor Bildim</span>
                      <span className="text-[9px] opacity-70">Yakında yine</span>
                    </button>
                    <button
                      onClick={() => ustasiGrade(3)}
                      className="py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm transition-all active:scale-95 flex flex-col items-center gap-0.5"
                    >
                      <span className="text-lg">😊</span>
                      <span className="text-xs">Rahat Bildim</span>
                      <span className="text-[9px] opacity-70">Standart aralık</span>
                    </button>
                    <button
                      onClick={() => ustasiGrade(5)}
                      className="py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm transition-all active:scale-95 flex flex-col items-center gap-0.5"
                    >
                      <span className="text-lg">🎯</span>
                      <span className="text-xs">Çok Kolay</span>
                      <span className="text-[9px] opacity-70">Uzun aralık</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  // İstatistik modal
  const renderUstasiStatsModal = () => {
    if (!ustasiShowStats) return null;
    const accuracyPct = reviewStats.totalReviews > 0
      ? Math.round((reviewStats.correctReviews / reviewStats.totalReviews) * 100) : 0;
    const nextLevelXP = getXPForNextLevel(reviewStats.level);
    const prevLevelXP = XP_LEVELS[reviewStats.level - 1] || 0;
    const levelProgress = Math.min(100, Math.round(((reviewStats.totalXP - prevLevelXP) / (nextLevelXP - prevLevelXP)) * 100));

    const stageCount = {
      new: savedQuestions.filter(q => q.correctAnswer && !q.srsReviewCount).length,
      learning: savedQuestions.filter(q => q.srsStage === 'learning').length,
      review: savedQuestions.filter(q => q.srsStage === 'review').length,
      mature: savedQuestions.filter(q => q.srsStage === 'mature').length,
      mastered: savedQuestions.filter(q => q.srsStage === 'mastered').length,
    };

    const bySubject: Record<string, { total: number; mastered: number }> = {};
    for (const q of savedQuestions.filter(sq => sq.correctAnswer)) {
      if (!bySubject[q.subject]) bySubject[q.subject] = { total: 0, mastered: 0 };
      bySubject[q.subject].total += 1;
      if (q.srsStage === 'mastered') bySubject[q.subject].mastered += 1;
    }

    return (
      <div className="fixed inset-0 z-[70] bg-black/80 flex items-end sm:items-center justify-center sm:p-4 animate-in fade-in" onClick={() => setUstasiShowStats(false)}>
        <div
          className="bg-slate-900 rounded-t-3xl sm:rounded-3xl w-full max-w-lg border border-violet-700/30 shadow-2xl max-h-[90dvh] overflow-y-auto overscroll-contain"
          onClick={e => e.stopPropagation()}
        >
          <div className="sticky top-0 bg-slate-900/95 backdrop-blur-sm border-b border-slate-700/50 p-4 flex items-center justify-between">
            <h2 className="text-xl font-bold text-white flex items-center gap-2">📊 KPSS Ustası İstatistikler</h2>
            <button onClick={() => setUstasiShowStats(false)} className="text-slate-400 hover:text-white"><X size={20} /></button>
          </div>

          <div className="p-4 space-y-4">
            {/* Seviye */}
            <div className="bg-gradient-to-br from-violet-900/40 to-fuchsia-900/30 border border-violet-500/30 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-xs text-violet-300">Seviye</div>
                  <div className="text-3xl font-bold text-white">{reviewStats.level}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-violet-300">Toplam XP</div>
                  <div className="text-2xl font-bold text-violet-200">{reviewStats.totalXP}</div>
                </div>
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-400" style={{ width: `${levelProgress}%` }} />
              </div>
              <div className="text-[10px] text-violet-300/70 mt-1 text-right">
                {nextLevelXP - reviewStats.totalXP} XP • Seviye {reviewStats.level + 1}
              </div>
            </div>

            {/* Genel */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-orange-950/40 border border-orange-700/30 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-orange-400">🔥 {reviewStats.dailyStreak}</div>
                <div className="text-[10px] text-orange-300/70">Günlük Seri</div>
              </div>
              <div className="bg-blue-950/40 border border-blue-700/30 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-blue-400">{reviewStats.totalReviews}</div>
                <div className="text-[10px] text-blue-300/70">Toplam Tekrar</div>
              </div>
              <div className="bg-emerald-950/40 border border-emerald-700/30 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-emerald-400">%{accuracyPct}</div>
                <div className="text-[10px] text-emerald-300/70">Başarı</div>
              </div>
            </div>

            {/* Aşama dağılımı */}
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
              <h3 className="text-xs font-bold text-slate-300 mb-3">📚 Öğrenme Aşamaları</h3>
              <div className="space-y-2">
                {[
                  { key: 'new', emoji: '🌱', label: 'Yeni', color: 'bg-slate-500' },
                  { key: 'learning', emoji: '📖', label: 'Öğreniliyor', color: 'bg-amber-500' },
                  { key: 'review', emoji: '🌿', label: 'Pekiştiriliyor', color: 'bg-blue-500' },
                  { key: 'mature', emoji: '🌳', label: 'Öğrenildi', color: 'bg-emerald-500' },
                  { key: 'mastered', emoji: '🏆', label: 'Kalıcı', color: 'bg-violet-500' },
                ].map(s => {
                  const count = stageCount[s.key as keyof typeof stageCount];
                  const total = Object.values(stageCount).reduce((a, b) => a + b, 0) || 1;
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div key={s.key}>
                      <div className="flex items-center justify-between text-[10px] mb-0.5">
                        <span className="text-slate-300">{s.emoji} {s.label}</span>
                        <span className="text-slate-400">{count} • %{pct}</span>
                      </div>
                      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className={`h-full ${s.color} transition-all`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Ders bazlı */}
            {Object.keys(bySubject).length > 0 && (
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
                <h3 className="text-xs font-bold text-slate-300 mb-3">📖 Ders Bazlı İlerleme</h3>
                <div className="space-y-2">
                  {Object.entries(bySubject).map(([subj, s]) => {
                    const pct = s.total > 0 ? Math.round((s.mastered / s.total) * 100) : 0;
                    return (
                      <div key={subj}>
                        <div className="flex items-center justify-between text-[10px] mb-0.5">
                          <span className="text-slate-200 font-medium">{subj}</span>
                          <span className="text-slate-400">{s.mastered}/{s.total} kalıcı • %{pct}</span>
                        </div>
                        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-400 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Başarımlar */}
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
              <h3 className="text-xs font-bold text-slate-300 mb-3">🏅 Başarımlar ({reviewStats.achievements.length}/{ACHIEVEMENTS.length})</h3>
              <div className="grid grid-cols-3 gap-2">
                {ACHIEVEMENTS.map(a => {
                  const earned = reviewStats.achievements.includes(a.id);
                  return (
                    <div
                      key={a.id}
                      className={`rounded-xl p-2 text-center transition-all ${earned ? 'bg-gradient-to-br from-amber-500/20 to-yellow-500/10 border border-amber-500/40' : 'bg-slate-900/60 border border-slate-700/30 opacity-40'}`}
                      title={a.name}
                    >
                      <div className="text-2xl">{a.emoji}</div>
                      <div className="text-[9px] font-medium text-slate-300 leading-tight mt-0.5">{a.name}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Son 7 gün */}
            {reviewStats.weeklyHistory.length > 0 && (
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4">
                <h3 className="text-xs font-bold text-slate-300 mb-3">📅 Son 7 Gün</h3>
                <div className="flex items-end justify-between gap-1 h-20">
                  {Array.from({ length: 7 }).map((_, i) => {
                    const d = new Date(Date.now() - (6 - i) * 86400000).toISOString().split('T')[0];
                    const entry = reviewStats.weeklyHistory.find(w => w.date === d);
                    const count = entry?.reviewed || 0;
                    const maxC = Math.max(1, ...reviewStats.weeklyHistory.map(w => w.reviewed));
                    const h = count > 0 ? Math.max(8, (count / maxC) * 100) : 4;
                    return (
                      <div key={d} className="flex-1 flex flex-col items-center gap-1">
                        <div className="flex-1 w-full flex items-end">
                          <div className="w-full bg-violet-500/60 rounded-t" style={{ height: `${h}%` }} title={`${d}: ${count} soru`} />
                        </div>
                        <div className="text-[9px] text-slate-500">{new Date(d).toLocaleDateString('tr', { weekday: 'short' }).substring(0, 2)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };


  const renderMemorizeReview = () => {
    if (!memorizeReviewCards || memorizeReviewCards.length === 0) return null;

    const card = memorizeReviewCards[memorizeReviewIndex];
    const total = memorizeReviewCards.length;
    const doneCount = memorizeReviewDone.size;
    const remaining = total - doneCount;
    const isFinished = doneCount >= total;

    const goNext = () => {
      let next = memorizeReviewIndex + 1;
      while (next < total && memorizeReviewDone.has(memorizeReviewCards[next].id)) next++;
      if (next >= total) {
        // Bitirildi ama atlananlar da var — baştan başla
        const firstUndone = memorizeReviewCards.findIndex(c => !memorizeReviewDone.has(c.id));
        if (firstUndone !== -1) {
          setMemorizeReviewIndex(firstUndone);
        }
      } else {
        setMemorizeReviewIndex(next);
      }
      setMemorizeReviewShowBack(false);
    };

    const handleScheduleSM2 = async (quality: 0 | 1 | 2 | 3) => {
      await scheduleMemorizeCardSM2(card, quality);
      if (quality === 0) {
        // Bilmiyorum: aynı oturumda tekrar göreceğiz (done olarak işaretleme)
      } else {
        setMemorizeReviewDone(prev => new Set([...prev, card.id]));
      }
      goNext();
    };

    if (isFinished) {
      return (
        <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col items-center justify-center p-6">
          <div className="text-6xl mb-6">🎉</div>
          <h2 className="text-2xl font-bold text-white mb-2">Tekrar Tamamlandı!</h2>
          <p className="text-slate-400 mb-8">{doneCount} kart tamamlandı</p>
          <div className="flex flex-col gap-3 w-full max-w-xs">
            <button onClick={() => startMemorizeReview(memorizeReviewCards)} className="w-full py-3 rounded-2xl font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors">Baştan Başlat</button>
            <button onClick={() => setMemorizeReviewCards(null)} className="w-full py-3 rounded-2xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors">Kapat</button>
          </div>
        </div>
      );
    }

    const stage = getMemorizeCardStage(card);

    return (
      <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col animate-in fade-in duration-300">
        {/* Header */}
        <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center gap-3 shrink-0">
          <button onClick={() => setMemorizeReviewCards(null)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
            <X size={18} />
          </button>
          <Book size={18} className="text-violet-400" />
          <span className="font-bold text-white text-sm">Ezber Tekrar</span>
          <span className="ml-auto text-xs text-slate-500">{doneCount} tamamlandı · {remaining} kaldı</span>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-slate-800 shrink-0">
          <div className="h-full bg-violet-500 transition-all duration-300" style={{ width: `${(doneCount / total) * 100}%` }} />
        </div>

        {/* Card */}
        <div className="flex-1 flex flex-col items-center justify-center p-4 overflow-y-auto">
          <div className="flex items-center gap-2 mb-3 text-xs text-slate-500 flex-wrap justify-center">
            <span className="bg-slate-800 px-2 py-1 rounded-full">{card.subject}</span>
            <span className="bg-slate-800 px-2 py-1 rounded-full">{card.topic}</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${stage.color}`}>
              {stage.emoji} {stage.label}
            </span>
          </div>

          {/* Kart yüzü */}
          <div
            className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl shadow-2xl w-full max-w-lg border-2 border-violet-500/30 p-8 min-h-[200px] flex flex-col items-center justify-center cursor-pointer select-none"
            onClick={() => setMemorizeReviewShowBack(prev => !prev)}
          >
            {!memorizeReviewShowBack ? (
              <>
                <p className="text-[10px] uppercase tracking-wider text-violet-400 font-bold mb-4">Ön Yüz</p>
                <p className="text-2xl font-bold text-white text-center leading-relaxed">{card.front}</p>
                <p className="text-[10px] text-slate-500 mt-6">👆 Cevabı görmek için tıkla</p>
              </>
            ) : (
              <>
                <p className="text-[10px] uppercase tracking-wider text-violet-400 font-bold mb-2">Ön Yüz</p>
                <p className="text-sm text-slate-300 text-center mb-4 italic">{card.front}</p>
                <div className="w-full border-t border-violet-500/20 my-2"></div>
                <p className="text-[10px] uppercase tracking-wider text-green-400 font-bold mb-3 mt-2">Arka Yüz</p>
                <p className="text-lg text-white text-center leading-relaxed whitespace-pre-wrap">{card.back}</p>
              </>
            )}
          </div>

          <p className="mt-3 text-xs text-slate-600">{memorizeReviewIndex + 1} / {total}</p>

          {/* SM-2 butonları — sadece arka yüz açıldığında aktif */}
          <div className="w-full max-w-lg mt-4">
            {memorizeReviewShowBack ? (
              <>
                <p className="text-xs text-slate-500 text-center mb-2 font-medium">Bu kartı ne kadar iyi hatırladın?</p>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'Bilmiyorum', quality: 0 as const, preview: '1 gün', cls: 'bg-rose-600/80 hover:bg-rose-600 border-rose-500/30' },
                    { label: 'Zor', quality: 1 as const, preview: 'yakın', cls: 'bg-amber-600/80 hover:bg-amber-600 border-amber-500/30' },
                    { label: 'İyi', quality: 2 as const, preview: 'normal', cls: 'bg-emerald-700/80 hover:bg-emerald-700 border-emerald-500/30' },
                    { label: 'Kolay', quality: 3 as const, preview: 'uzak', cls: 'bg-blue-700/80 hover:bg-blue-700 border-blue-500/30' },
                  ].map(({ label, quality, preview, cls }) => (
                    <button
                      key={quality}
                      onClick={() => handleScheduleSM2(quality)}
                      className={`${cls} text-white font-bold py-3 rounded-xl border transition-colors flex flex-col items-center gap-0.5`}
                    >
                      <span className="text-xs">{label}</span>
                      <span className="text-[9px] opacity-70">{preview}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <button
                onClick={() => setMemorizeReviewShowBack(true)}
                className="w-full py-3 rounded-xl font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors"
              >Cevabı Göster</button>
            )}
          </div>
        </div>
      </div>
    );
  };


  const renderGrading = () => {
    return (
      <div className="min-h-[100dvh] bg-slate-950 flex flex-col animate-in fade-in duration-300">
        <div className="sticky top-0 z-10 bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between shadow-sm">
          <div className="flex gap-2">
            <button
              onClick={() => {
                setCurrentSessionId(null);
                setPdfUrl(null);
                setMode('setup');
              }}
              className="text-slate-400 hover:text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <ArrowLeft size={16} /> Ana Menü
            </button>
            <button
              onClick={() => setMode('taking')}
              className="text-slate-400 hover:text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              Sınava Dön
            </button>
            {pdfUrl && (
              <button
                onClick={() => setGradingViewMode('pdf')}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 shadow-sm"
              >
                PDF Üzerinde İşaretle
              </button>
            )}
          </div>
          <button
            onClick={calculateResults}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 shadow-sm"
          >
            Sonuçları Gör <ListChecks size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-8 max-w-7xl mx-auto w-full">
          <div className="bg-slate-900 p-6 rounded-2xl shadow-sm border border-slate-800 mb-8">
            <h2 className="text-xl font-bold text-white mb-2">Cevap Anahtarı Girişi</h2>
            <p className="text-sm text-slate-400">
              Lütfen doğru cevapları işaretleyin. Sadece işaretlediğiniz sorular değerlendirilecektir.
              Eğer cevap anahtarını girmek istemiyorsanız, doğrudan sonuçları görebilirsiniz (hepsi boş sayılır).
            </p>
          </div>
          <div className="bg-slate-900 p-6 rounded-2xl shadow-sm border border-slate-800">
            {renderGrid(correctAnswers, handleCorrectAnswerSelect, undefined, "bg-emerald-600 border-emerald-600")}
          </div>
        </div>
      </div>
    );
  };

  const startGameMode = (questions: SavedQuestion[], previousAnswers?: Record<string, string>) => {
    // Yanlış yapılanları 2x, boş bırakılanları 1.5x ağırlıkla karıştır
    const weighted: SavedQuestion[] = [];
    questions.forEach(q => {
      const prev = previousAnswers?.[q.id];
      if (!prev) {
        // Boş — 2 kez ekle
        weighted.push(q, q);
      } else if (prev !== q.correctAnswer) {
        // Yanlış — 3 kez ekle
        weighted.push(q, q, q);
      } else {
        // Doğru — 1 kez ekle
        weighted.push(q);
      }
    });
    
    // Fisher-Yates shuffle
    const shuffled = [...weighted];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    // Duplicate'leri kaldır ama sırayı koru
    const seen = new Set<string>();
    const final = shuffled.filter(q => {
      if (seen.has(q.id)) return false;
      seen.add(q.id);
      return true;
    });
    
    setGameModeQuestions(final);
    setCurrentGameQuestionIndex(0);
    setGameModeAnswers({});
    setGameModeFinished(false);
  };

  const generatePdfFromCroppedQuestions = async (
    questionsToInclude: SavedQuestion[] = savedQuestions, 
    filename: string = 'Kesilen_Sorular_Testi.pdf', 
    action: 'save' | 'print' = 'save',
    answerKeyPosition: 'bottom-right' | 'end' = 'end'
  ) => {
    if (questionsToInclude.length === 0) return;

    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = 210; // A4 portrait width
    const pageHeight = 297; // A4 portrait height
    const margin = 10;
    const columnSpacing = 5;
    const columnWidth = (pageWidth - margin * 2 - columnSpacing * 2) / 3;
    const maxImageHeight = 30; // Limit height to fit ~8 questions per column
    const numberWidth = 6; // Space for the question number

    let currentColumn = 0; // 0, 1, 2
    let currentY = margin;
    let questionIndex = 0;

    const answers: { num: number, ans: string }[] = [];

    for (let i = 0; i < questionsToInclude.length; i++) {
      const q = questionsToInclude[i];
      questionIndex++;

      if (q.correctAnswer) {
        answers.push({ num: questionIndex, ans: q.correctAnswer });
      }

      // Load image to get dimensions
      const img = new Image();
      img.src = q.image;
      await new Promise(resolve => { img.onload = resolve; });

      const imgRatio = img.width / img.height;
      
      // Calculate dimensions to fit within columnWidth and maxImageHeight
      let renderWidth = columnWidth - numberWidth;
      let renderHeight = renderWidth / imgRatio;

      if (renderHeight > maxImageHeight) {
        renderHeight = maxImageHeight;
        // Kullanıcının isteği üzerine en-boy oranını bozarak sütun genişliğini (çizgiye kadar) dolduruyoruz
        // renderWidth = renderHeight * imgRatio;
      }

      // Check if we need a new page or new column
      if (currentY + renderHeight + 4 > pageHeight - margin) {
        if (currentColumn < 2) {
          currentColumn++;
          currentY = margin;
        } else {
          // Draw separator lines before adding new page
          doc.setDrawColor(200, 200, 200);
          doc.line(margin + columnWidth + columnSpacing / 2, margin, margin + columnWidth + columnSpacing / 2, pageHeight - margin);
          doc.line(margin + columnWidth * 2 + columnSpacing * 1.5, margin, margin + columnWidth * 2 + columnSpacing * 1.5, pageHeight - margin);
          
          doc.addPage();
          currentColumn = 0;
          currentY = margin;
        }
      }

      const xOffset = margin + currentColumn * (columnWidth + columnSpacing);
      
      // Draw question number next to the image
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(50, 50, 50);
      doc.text(`${questionIndex}-`, xOffset, currentY + 4);
      
      // Draw image next to the number
      const imgX = xOffset + numberWidth;
      doc.addImage(img, 'JPEG', imgX, currentY, renderWidth, renderHeight);

      // Draw answer at bottom right if selected
      if (answerKeyPosition === 'bottom-right' && q.correctAnswer) {
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(220, 38, 38); // Red color for answer
        // Position at the bottom right of the image
        const ansX = imgX + renderWidth - 1;
        const ansY = currentY + renderHeight - 1;
        doc.text(`Cevap: ${q.correctAnswer}`, ansX, ansY, { align: 'right' });
      }

      currentY += renderHeight + 4; // Add some spacing after the question
    }

    // Draw separator lines for the last page
    doc.setDrawColor(200, 200, 200);
    doc.line(margin + columnWidth + columnSpacing / 2, margin, margin + columnWidth + columnSpacing / 2, pageHeight - margin);
    doc.line(margin + columnWidth * 2 + columnSpacing * 1.5, margin, margin + columnWidth * 2 + columnSpacing * 1.5, pageHeight - margin);

    // Add answers page if there are any answers and position is 'end'
    if (answers.length > 0 && answerKeyPosition === 'end') {
      doc.addPage();
      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text('Cevap Anahtarı', margin, margin + 5);
      
      doc.setFontSize(11);
      doc.setFont("helvetica", "normal");
      let ansY = margin + 15;
      let ansX = margin;
      
      answers.forEach((ans) => {
        doc.text(`${ans.num}. ${ans.ans}`, ansX, ansY);
        ansY += 6;
        if (ansY > pageHeight - margin) {
          ansY = margin + 15;
          ansX += 30;
        }
      });
    }

    if (action === 'save') {
      doc.save(filename);
    } else if (action === 'print') {
      doc.autoPrint();
      const blob = doc.output('blob');
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    }
  };

  const renderGameMode = () => {
    if (!gameModeQuestions || gameModeQuestions.length === 0) return null;

    const currentQ = gameModeQuestions[currentGameQuestionIndex];
    const isLastQuestion = currentGameQuestionIndex === gameModeQuestions.length - 1;

    const handleAnswer = (opt: string) => {
      if (gameModeFinished) return;
      setGameModeAnswers(prev => ({ ...prev, [currentQ.id]: opt }));
      
      // Auto-advance after a short delay
      setTimeout(() => {
        if (currentGameQuestionIndex === gameModeQuestions.length - 1) {
          setGameModeFinished(true);
        } else {
          setCurrentGameQuestionIndex(prev => prev + 1);
        }
      }, 500); // 500ms delay for fast transition
    };

    const handleNext = () => {
      if (isLastQuestion) {
        setGameModeFinished(true);
      } else {
        setCurrentGameQuestionIndex(prev => prev + 1);
      }
    };

    const handlePrev = () => {
      setCurrentGameQuestionIndex(prev => Math.max(0, prev - 1));
    };

    const closeGameMode = () => {
      setGameModeQuestions(null);
    };

    const retryGameMode = () => {
      // Yanlışları ön plana çıkararak tekrar başlat
      startGameMode(gameModeQuestions, gameModeAnswers);
    };

    let correctCount = 0;
    let wrongCount = 0;
    let emptyCount = 0;
    const wrongQuestions: SavedQuestion[] = [];

    if (gameModeFinished) {
      gameModeQuestions.forEach(q => {
        const userAns = gameModeAnswers[q.id];
        if (!userAns) {
          emptyCount++;
          wrongQuestions.push(q); // Count empty as wrong for review
        }
        else if (userAns === q.correctAnswer) correctCount++;
        else {
          wrongCount++;
          wrongQuestions.push(q);
        }
      });
    }

    const formatTime = (seconds: number) => {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    return (
      <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col animate-in fade-in duration-300">
        {/* Header */}
        <div className="bg-slate-900 px-4 py-3 flex items-center justify-between shadow-md z-20 shrink-0 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <button
              onClick={closeGameMode}
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
            <div>
              <h2 className="text-lg font-bold text-white leading-tight">Test Modu</h2>
              <p className="text-xs text-slate-400">{gameModeQuestions.length} Soru</p>
            </div>
          </div>
          {!gameModeFinished && (
            <div className="flex items-center gap-3">
              <div className={`text-sm font-bold px-3 py-1.5 rounded-lg border flex items-center gap-2 ${gameModeTimeLeft <= 10 ? 'text-rose-400 bg-rose-900/30 border-rose-800/50 animate-pulse' : 'text-emerald-400 bg-emerald-900/30 border-emerald-800/50'}`}>
                <Clock size={16} /> {formatTime(gameModeTimeLeft)}
              </div>
              <div className="text-sm font-bold text-blue-400 bg-blue-900/30 px-3 py-1.5 rounded-lg border border-blue-800/50">
                {currentGameQuestionIndex + 1} / {gameModeQuestions.length}
              </div>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center justify-center">
          {gameModeFinished ? (
            <div className="bg-slate-900 p-8 rounded-3xl shadow-xl border border-slate-800 max-w-md w-full text-center">
              <div className="w-20 h-20 bg-emerald-900/30 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-6">
                <CheckCircle size={40} />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">Tebrikler!</h2>
              <p className="text-slate-400 mb-4">Testi tamamladınız.</p>
              <button
                onClick={retryGameMode}
                className="w-full mb-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-2xl transition-colors flex items-center justify-center gap-2"
              >
                <RefreshCw size={18} /> Tekrar Dene (Yanlışlar Önce)
              </button>
              
              <div className="grid grid-cols-3 gap-4 mb-8">
                <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-2xl p-4">
                  <p className="text-3xl font-bold text-emerald-400 mb-1">{correctCount}</p>
                  <p className="text-xs font-medium text-emerald-500 uppercase tracking-wider">Doğru</p>
                </div>
                <div className="bg-rose-900/20 border border-rose-800/50 rounded-2xl p-4">
                  <p className="text-3xl font-bold text-rose-400 mb-1">{wrongCount}</p>
                  <p className="text-xs font-medium text-rose-500 uppercase tracking-wider">Yanlış</p>
                </div>
                <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-4">
                  <p className="text-3xl font-bold text-slate-300 mb-1">{emptyCount}</p>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Boş</p>
                </div>
              </div>
              
              {wrongQuestions.length > 0 && (
                <div className="mb-8 text-left">
                  <h3 className="text-lg font-bold text-white mb-4 border-b border-slate-800 pb-2">Öğrenme Odaklı: Yanlış ve Boş Sorular</h3>
                  <div className="space-y-6 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
                    {wrongQuestions.map((wq, idx) => (
                      <div key={wq.id} className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
                        <div className="flex justify-between items-center mb-3">
                          <span className="text-sm font-medium text-slate-300">Soru {gameModeQuestions.findIndex(q => q.id === wq.id) + 1}</span>
                          <span className="text-xs font-bold px-2 py-1 rounded bg-emerald-900/50 text-emerald-400 border border-emerald-800/50">
                            Doğru Cevap: {wq.correctAnswer || '?'}
                          </span>
                        </div>
                        <div className="bg-white rounded-lg p-2">
                          <img src={wq.image} alt="Soru" className="w-full h-auto object-contain max-h-48" />
                        </div>
                        <div className="mt-3 text-sm text-slate-400">
                          Senin Cevabın: <span className="font-bold text-rose-400">{gameModeAnswers[wq.id] || 'Boş'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              <button
                onClick={closeGameMode}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-xl font-bold text-lg transition-colors shadow-lg shadow-blue-900/20"
              >
                Kapat
              </button>
            </div>
          ) : (
            <div className="w-full max-w-2xl flex flex-col items-center">
              <div className="bg-white rounded-2xl p-2 mb-6 w-full shadow-2xl">
                <img src={currentQ.image} alt={`Soru ${currentGameQuestionIndex + 1}`} className="w-full h-auto object-contain rounded-xl max-h-[60vh]" />
              </div>
              
              <div className="w-full grid grid-cols-5 gap-3 mb-8">
                {OPTIONS.map(opt => {
                  const isSelected = gameModeAnswers[currentQ.id] === opt;
                  const isCorrectAnswer = currentQ.correctAnswer === opt;
                  
                  let btnClass = "py-4 rounded-2xl font-bold text-xl transition-all active:scale-95 ";
                  
                  if (gameModeAnswers[currentQ.id]) {
                    if (isCorrectAnswer) {
                      btnClass += "bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 ring-2 ring-emerald-400 ring-offset-2 ring-offset-slate-950";
                    } else if (isSelected) {
                      btnClass += "bg-rose-500 text-white shadow-lg shadow-rose-500/30 ring-2 ring-rose-400 ring-offset-2 ring-offset-slate-950";
                    } else {
                      btnClass += "bg-slate-800 text-slate-500 border border-slate-700 opacity-50";
                    }
                  } else {
                    btnClass += "bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 hover:text-white";
                  }
                  
                  return (
                    <button
                      key={opt}
                      onClick={() => handleAnswer(opt)}
                      disabled={!!gameModeAnswers[currentQ.id]}
                      className={btnClass}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
              
              <div className="w-full flex justify-between gap-4">
                <button
                  onClick={handlePrev}
                  disabled={currentGameQuestionIndex === 0}
                  className="flex-1 py-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:hover:bg-slate-800 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
                >
                  <ArrowLeft size={20} /> Önceki
                </button>
                <button
                  onClick={handleNext}
                  className={`flex-1 py-4 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-2 ${
                    isLastQuestion 
                      ? 'bg-emerald-600 hover:bg-emerald-700 shadow-lg shadow-emerald-900/20' 
                      : 'bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-900/20'
                  }`}
                >
                  {isLastQuestion ? 'Bitir' : 'Sonraki'} <ArrowRight size={20} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderSavedQuestions = () => {
    const grouped = savedQuestions.reduce((acc, sq) => {
      if (!acc[sq.subject]) acc[sq.subject] = [];
      acc[sq.subject].push(sq);
      return acc;
    }, {} as Record<string, SavedQuestion[]>);

    return (
      <div className="min-h-[100dvh] bg-slate-950 flex flex-col animate-in fade-in duration-300 overflow-x-hidden">
        <div className="sticky top-0 z-10 bg-slate-950/80 backdrop-blur-md border-b border-slate-800/50 px-2 py-2 flex items-center justify-between shadow-sm flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setCurrentSessionId(null);
                setPdfUrl(null);
                setMode('setup');
              }}
              className="text-slate-400 hover:text-white p-1.5 rounded-lg transition-colors bg-slate-800 border border-slate-700 hover:bg-slate-700"
              title="Ana Ekrana Dön"
            >
              <Home size={16} />
            </button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {/* ⚡ KPSS USTASI — bilimsel tekrar */}
            <button
              onClick={() => {
                const answeredCount = savedQuestions.filter(q => q.correctAnswer).length;
                if (answeredCount === 0) {
                  alert('Bilimsel tekrar için cevabı olan soru gerekli. Soruları kaydederken "Doğru Cevap" alanını doldur.');
                  return;
                }
                startUstasi();
              }}
              className="text-white bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 shadow-lg shadow-violet-900/30"
              title="KPSS Ustası — bilimsel tekrar sistemi"
            >⚡ KPSS Ustası</button>
            {/* FIX: Fotoğraftan Soru Ekle butonları */}
            <button
              onClick={() => { setPhotoUploadMode('question'); photoCameraInputRef.current?.click(); }}
              className="text-white bg-blue-600 hover:bg-blue-700 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
              title="Kamera ile çek"
            >📷 Kamera</button>
            <button
              onClick={() => { setPhotoUploadMode('question'); photoInputRef.current?.click(); }}
              className="text-white bg-blue-600/80 hover:bg-blue-700 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
              title="Galeriden seç"
            >🖼️ Galeri</button>
            <button
              onClick={async () => {
                if (savedQuestions.length === 0) return;
                
                const zip = new JSZip();
                
                await Promise.all(savedQuestions.map(async (q) => {
                  const folderPath = `${q.subject}/${q.difficulty}`;
                  const folder = zip.folder(folderPath);
                  
                  if (folder) {
                    let finalImage = q.image;
                    if (q.notes || q.correctAnswer || q.topic) {
                      finalImage = await createImageWithNotes(q.image, q);
                    }
                    
                    // Extract base64 data
                    const base64Data = finalImage.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
                    const filename = `Soru_${q.questionNumber}_${new Date(q.date).getTime()}.jpg`;
                    folder.file(filename, base64Data, {base64: true});
                  }
                }));
                
                const content = await zip.generateAsync({type:"blob"});
                saveAs(content, "Kaydedilen_Sorular.zip");
              }}
              disabled={savedQuestions.length === 0}
              className="text-slate-400 hover:text-white disabled:opacity-30 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 bg-slate-800"
            >
              İndir (ZIP)
            </button>
            <button
              onClick={() => {
                setTestBuilderSubject('');
                setTestBuilderTopic('');
                setTestBuilderQuestionCount(0);
                setShowTestBuilderModal(true);
              }}
              disabled={savedQuestions.length === 0}
              className="text-white hover:text-white disabled:opacity-30 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 shadow-sm"
              title="Kesilen sorulardan özel sınav oluştur"
            >
              <FileText size={14} /> Sınav Oluştur
            </button>
            <button
              onClick={() => setMode('setup')}
              className="text-slate-400 hover:text-white px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
            >
              <ArrowLeft size={14} /> Ana Menü
            </button>
          </div>
        </div>
        
        <div className="flex-1 p-4 md:p-6 lg:p-8 max-w-7xl mx-auto w-full">
          {savedQuestions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-[60vh] text-slate-500 animate-in fade-in zoom-in duration-500">
              <div className="w-24 h-24 bg-slate-900 rounded-full flex items-center justify-center mb-6 border border-slate-800 shadow-inner">
                <BookOpen size={40} className="text-slate-600" />
              </div>
              <h3 className="text-xl font-medium text-slate-300 mb-2">Henüz Soru Kaydedilmedi</h3>
              <p className="text-slate-500 max-w-sm text-center">
                PDF üzerinden çözdüğünüz testlerdeki önemli soruları keserek buraya kaydedebilir, daha sonra tekrar çözmek için özel sınavlar oluşturabilirsiniz.
              </p>
              <button
                onClick={() => setMode('setup')}
                className="mt-8 bg-blue-600/10 text-blue-400 hover:bg-blue-600/20 border border-blue-500/20 px-6 py-3 rounded-xl font-medium transition-all flex items-center gap-2"
              >
                <ArrowLeft size={18} /> Ana Menüye Dön
              </button>
            </div>
          ) : (
            <div className="space-y-8">
              {Object.entries(grouped).map(([subject, questions]) => (
                <div key={subject}>
                  <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-2">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                      {subject} <span className="text-sm font-normal text-slate-500 ml-2">({(questions as SavedQuestion[]).length} soru)</span>
                    </h2>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => startGameMode(questions as SavedQuestion[])}
                        className="text-white hover:text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/30"
                        title={`${subject} soruları ile test modu başlat`}
                      >
                        <Gamepad2 size={14} /> Test Modu
                      </button>
                      <button
                        onClick={() => {
                          setTestBuilderSubject(subject);
                          setTestBuilderTopic('');
                          setTestBuilderQuestionCount(0);
                          setShowTestBuilderModal(true);
                        }}
                        className="text-white hover:text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 border border-blue-500/30"
                        title={`${subject} sorularından PDF test oluştur`}
                      >
                        <FileText size={14} /> PDF Oluştur
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {(questions as SavedQuestion[]).map(q => (
                      <div key={q.id} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg group hover:border-slate-700 hover:shadow-xl hover:shadow-blue-900/10 transition-all duration-300 flex flex-col">
                        <div className="p-3 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
                          <div className="flex items-center gap-2">
                            {q.questionNumber > 0 && (
                              <span className="text-xs font-bold text-slate-400 bg-slate-800 px-2 py-1 rounded-md">Soru {q.questionNumber}</span>
                            )}
                            {q.topic && (
                              <span className="text-xs font-medium text-blue-400 bg-blue-500/10 px-2 py-1 rounded-md truncate max-w-[150px]" title={q.topic}>
                                {q.topic}
                              </span>
                            )}
                            <span className={`text-xs font-bold px-2 py-1 rounded-md ${
                              q.difficulty === 'Kolay' ? 'bg-emerald-500/20 text-emerald-400' :
                              q.difficulty === 'Orta' ? 'bg-amber-500/20 text-amber-400' :
                              'bg-rose-500/20 text-rose-400'
                            }`}>
                              {q.difficulty}
                            </span>
                          </div>
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmModal({
                                isOpen: true,
                                message: 'Bu soruyu silmek istediğinize emin misiniz?',
                                onConfirm: async () => {
                                  const updated = savedQuestions.filter(sq => sq.id !== q.id);
                                  setSavedQuestions(updated);
                                  if (user) {
                                    try {
                                      await api.deleteQuestion(user, q.id);
                                    } catch (error) {
                                      console.error("Error deleting question:", error);
                                    }
                                  } else {
                                    await localforage.setItem('saved_questions', updated);
                                  }
                                }
                              });
                            }}
                            className="text-slate-500 hover:text-rose-400 transition-colors p-1"
                            title="Sil"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <div className="p-4 bg-white flex justify-center items-center min-h-[200px] flex-1 relative">
                          <img src={q.image} alt={`Soru ${q.questionNumber}`} className="max-w-full max-h-64 object-contain mix-blend-multiply" />
                        </div>
                        {(q.correctAnswer || q.notes) && (
                          <div className="p-3 bg-slate-800/50 border-t border-slate-800 text-sm">
                            {q.correctAnswer && (
                              <div className="mb-2">
                                <span className="text-slate-400">Doğru Cevap: </span>
                                <span className="font-bold text-emerald-400">{q.correctAnswer}</span>
                              </div>
                            )}
                            {q.notes && (
                              <div>
                                <span className="text-slate-400 block mb-1">Notlar:</span>
                                <p className="text-slate-300 whitespace-pre-wrap">{q.notes}</p>
                              </div>
                            )}
                          </div>
                        )}
                        <div className="p-3 bg-slate-900/50 text-xs text-slate-500 flex justify-between border-t border-slate-800">
                          <span>{new Date(q.date).toLocaleDateString('tr-TR')}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {showTestBuilderModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
              <div className="p-6 border-b border-slate-800 flex items-center justify-between bg-slate-800/50">
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  <FileText className="text-blue-500" /> Özel Sınav Oluştur
                </h3>
                <button onClick={() => setShowTestBuilderModal(false)} className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-700">
                  <X size={20} />
                </button>
              </div>
              <div className="p-6 overflow-y-auto flex-1 space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Ders Seçimi</label>
                  <select 
                    value={testBuilderSubject} 
                    onChange={(e) => {
                      setTestBuilderSubject(e.target.value);
                      setTestBuilderTopic('');
                    }}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                  >
                    <option value="">Tüm Dersler</option>
                    {Object.keys(KPSS_TOPICS).map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                
                {testBuilderSubject && KPSS_TOPICS[testBuilderSubject] && (
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Konu Seçimi</label>
                    <select 
                      value={testBuilderTopic} 
                      onChange={(e) => setTestBuilderTopic(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                    >
                      <option value="">Tüm Konular</option>
                      {KPSS_TOPICS[testBuilderSubject].map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Soru Sayısı</label>
                  <select 
                    value={testBuilderQuestionCount} 
                    onChange={(e) => setTestBuilderQuestionCount(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                  >
                    <option value={0}>Tümü</option>
                    <option value={10}>10 Soru</option>
                    <option value={20}>20 Soru</option>
                    <option value={30}>30 Soru</option>
                    <option value={40}>40 Soru</option>
                    <option value={50}>50 Soru</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Cevap Anahtarı Konumu</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input 
                        type="radio" 
                        name="answerPosition" 
                        value="end" 
                        checked={testBuilderAnswerPosition === 'end'} 
                        onChange={() => setTestBuilderAnswerPosition('end')}
                        className="w-4 h-4 text-blue-600 bg-slate-900 border-slate-700 focus:ring-blue-500"
                      />
                      <span className="text-sm text-slate-300">Testin Sonunda</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input 
                        type="radio" 
                        name="answerPosition" 
                        value="bottom-right" 
                        checked={testBuilderAnswerPosition === 'bottom-right'} 
                        onChange={() => setTestBuilderAnswerPosition('bottom-right')}
                        className="w-4 h-4 text-blue-600 bg-slate-900 border-slate-700 focus:ring-blue-500"
                      />
                      <span className="text-sm text-slate-300">Sorunun Sağ Altında</span>
                    </label>
                  </div>
                </div>

                {(() => {
                  let filtered = savedQuestions;
                  if (testBuilderSubject) filtered = filtered.filter(q => q.subject === testBuilderSubject);
                  if (testBuilderTopic) filtered = filtered.filter(q => q.topic === testBuilderTopic);
                  const count = testBuilderQuestionCount > 0 ? Math.min(testBuilderQuestionCount, filtered.length) : filtered.length;
                  
                  return (
                    <div className="bg-blue-900/20 border border-blue-800/50 rounded-xl p-4 flex items-center gap-3 text-blue-200">
                      <ListChecks size={24} className="text-blue-400" />
                      <div>
                        <p className="text-sm font-medium">Seçilen Kriterlere Uygun</p>
                        <p className="text-2xl font-bold text-white">{count} Soru <span className="text-sm font-normal text-blue-300">bulundu</span></p>
                      </div>
                    </div>
                  );
                })()}
              </div>
              <div className="p-6 border-t border-slate-800 flex justify-end gap-3 bg-slate-800/30">
                <button 
                  onClick={() => setShowTestBuilderModal(false)}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-slate-300 hover:bg-slate-800 transition-colors"
                >
                  İptal
                </button>
                <button 
                  onClick={() => {
                    let filtered = savedQuestions;
                    if (testBuilderSubject) filtered = filtered.filter(q => q.subject === testBuilderSubject);
                    if (testBuilderTopic) filtered = filtered.filter(q => q.topic === testBuilderTopic);
                    if (testBuilderQuestionCount > 0) filtered = filtered.slice(0, testBuilderQuestionCount);
                    
                    startGameMode(filtered);
                    setShowTestBuilderModal(false);
                  }}
                  className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <Gamepad2 size={16} /> Test Modu
                </button>
                <button 
                  onClick={() => {
                    let filtered = savedQuestions;
                    if (testBuilderSubject) filtered = filtered.filter(q => q.subject === testBuilderSubject);
                    if (testBuilderTopic) filtered = filtered.filter(q => q.topic === testBuilderTopic);
                    if (testBuilderQuestionCount > 0) filtered = filtered.slice(0, testBuilderQuestionCount);
                    
                    generatePdfFromCroppedQuestions(filtered, 'Ozel_Sinav.pdf', 'print', testBuilderAnswerPosition);
                    setShowTestBuilderModal(false);
                  }}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <FileText size={16} /> Yazdır
                </button>
                <button 
                  onClick={() => {
                    let filtered = savedQuestions;
                    if (testBuilderSubject) filtered = filtered.filter(q => q.subject === testBuilderSubject);
                    if (testBuilderTopic) filtered = filtered.filter(q => q.topic === testBuilderTopic);
                    if (testBuilderQuestionCount > 0) filtered = filtered.slice(0, testBuilderQuestionCount);
                    
                    generatePdfFromCroppedQuestions(filtered, 'Ozel_Sinav.pdf', 'save', testBuilderAnswerPosition);
                    setShowTestBuilderModal(false);
                  }}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <FileText size={16} /> PDF İndir
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const continueFromCurrentPosition = () => {
    // Cevapları ve işaretleri SIFIRLAMADAN devam et
    setMode('taking');
    setShowReviewPDF(false);
    setPendingReviewScroll(null);
    // FIX: Mevcut scroll pozisyonundan devam et (en son baktığı sayfa).
    // Önceki sürüm en yüksek mark sayfasına atlıyordu — bu yanlıştı.
    const targetIndex = currentScrollIndexRef.current || lastSavedPage || 0;
    if (targetIndex > 0) {
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: targetIndex, behavior: 'auto' });
      }, 300);
    }
  };

  const renderResults = () => {
    let correct = 0;
    let wrong = 0;
    let blank = 0;
    let evaluatedCount = 0;

    // Sadece cevap anahtarı girilen soruları değerlendir
    const questionsToEvaluate = Object.keys(correctAnswers).map(Number);
    
    if (questionsToEvaluate.length === 0) {
      // Eğer hiç cevap anahtarı girilmediyse, kullanıcının işaretlediklerini sayalım ama net hesaplayamayız.
      const answeredCount = Object.keys(userAnswers).length;
      return (
        <div className="min-h-[100dvh] bg-slate-950 flex flex-col items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="bg-slate-900 p-8 rounded-3xl shadow-xl border border-slate-800 max-w-md w-full text-center">
            <div className="w-16 h-16 bg-amber-900/30 text-amber-400 rounded-full flex items-center justify-center mx-auto mb-4">
              <XCircle size={32} />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Cevap Anahtarı Eksik</h2>
            <p className="text-slate-400 mb-6">Net hesaplaması yapabilmek için önceki adımda cevap anahtarını girmelisiniz.</p>
            <p className="text-sm text-slate-500 mb-8">İşaretlediğiniz soru sayısı: <strong className="text-white">{answeredCount}</strong> / {questionCount}</p>
            
            <div className="flex flex-col gap-3">
              <button onClick={() => setMode('grading')} className="bg-blue-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-blue-700 transition-colors">
                Cevap Anahtarı Gir
              </button>
              <button onClick={continueFromCurrentPosition} className="bg-emerald-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-emerald-700 transition-colors shadow-lg shadow-emerald-900/20">
                Kaldığım Yerden Devam Et
              </button>
              <button onClick={resetApp} className="bg-slate-800 text-slate-300 px-6 py-3 rounded-xl font-medium hover:bg-slate-700 transition-colors border border-slate-700">
                Yeni Sınav Başlat
              </button>
            </div>
          </div>
        </div>
      );
    }

    questionsToEvaluate.forEach((q) => {
      evaluatedCount++;
      const userAns = userAnswers[q];
      const correctAns = correctAnswers[q];

      if (!userAns) blank++;
      else if (userAns === correctAns) correct++;
      else wrong++;
    });

    // KPSS Net Formula: 4 Yanlış 1 Doğruyu Götürür
    const net = correct - (wrong / 4);

    return (
      <div className="min-h-[100dvh] bg-slate-950 flex flex-col animate-in fade-in duration-300">
        <div className="sticky top-0 z-10 bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                setCurrentSessionId(null);
                setPdfUrl(null);
                setMode('setup');
              }}
              className="text-slate-400 hover:text-white p-1.5 rounded-lg transition-colors bg-slate-800 border border-slate-700 hover:bg-slate-700"
              title="Ana Ekrana Dön"
            >
              <Home size={18} />
            </button>
            <h1 className="font-bold text-white flex items-center gap-2">
              <ListChecks className="text-blue-500" size={20} /> Sınav Sonucu
            </h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={continueFromCurrentPosition}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 shadow-sm"
              title="Kaldığım Yerden Devam Et"
            >
              <ArrowRight size={16} className="hidden sm:block" /> Devam Et
            </button>
            <button
              onClick={() => {
                setCurrentSessionId(null);
                setPdfUrl(null);
                setShowReviewPDF(false);
                setPendingReviewScroll(null);
                setMode('setup');
              }}
              className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 shadow-sm border border-slate-700"
            >
              Ana Menü
            </button>
            <button
              onClick={resetApp}
              className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 shadow-sm border border-slate-700"
            >
              Sıfırla <RefreshCw size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-8 max-w-7xl mx-auto w-full">
          
          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
            <div className="bg-slate-900 p-5 rounded-2xl shadow-sm border border-slate-800 flex flex-col items-center justify-center col-span-2 md:col-span-1">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Süre</span>
              <span className="text-2xl font-mono text-white">{formatTime(timeElapsed)}</span>
            </div>
            <div className="bg-emerald-900/20 p-5 rounded-2xl shadow-sm border border-emerald-900/50 flex flex-col items-center justify-center">
              <span className="text-xs font-bold text-emerald-500 uppercase tracking-wider mb-1">Doğru</span>
              <span className="text-3xl font-bold text-emerald-400">{correct}</span>
            </div>
            <div className="bg-rose-900/20 p-5 rounded-2xl shadow-sm border border-rose-900/50 flex flex-col items-center justify-center">
              <span className="text-xs font-bold text-rose-500 uppercase tracking-wider mb-1">Yanlış</span>
              <span className="text-3xl font-bold text-rose-400">{wrong}</span>
            </div>
            <div className="bg-slate-800/50 p-5 rounded-2xl shadow-sm border border-slate-700 flex flex-col items-center justify-center">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Boş</span>
              <span className="text-3xl font-bold text-slate-300">{blank}</span>
            </div>
            <div className="bg-blue-900/20 p-5 rounded-2xl shadow-sm border border-blue-900/50 flex flex-col items-center justify-center col-span-2 md:col-span-1">
              <span className="text-xs font-bold text-blue-500 uppercase tracking-wider mb-1">Net</span>
              <span className="text-4xl font-black text-blue-400">{net.toFixed(2)}</span>
            </div>
          </div>

          <div className="bg-slate-900 p-6 rounded-2xl shadow-sm border border-slate-800">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-2">
              <h2 className="text-lg font-bold text-white">Detaylı Analiz</h2>
              {pdfUrl && (
                <button
                  onClick={() => {
                    setShowReviewPDF(true);
                    // Kaldığı sayfadan devam et — currentScrollIndexRef mevcut pozisyonu tutar
                    setPendingReviewScroll(currentScrollIndexRef.current || 0);
                  }}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 shadow-sm"
                >
                  PDF üzerinde İncele
                </button>
              )}
            </div>
            <p className="text-xs text-slate-400 mb-6">Sadece cevap anahtarı girilen {evaluatedCount} soru üzerinden değerlendirme yapılmıştır.</p>
            {renderGrid(userAnswers, () => {}, correctAnswers)}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="font-sans text-slate-100 bg-slate-950 min-h-[100dvh] selection:bg-blue-900 selection:text-blue-100">
      {mode === 'setup' && renderSetup()}
      {(mode === 'taking' || (mode === 'grading' && gradingViewMode === 'pdf') || (mode === 'results' && showReviewPDF && !!pdfUrl)) && renderPDFInterface(mode === 'grading', mode === 'results' && showReviewPDF)}
      {mode === 'grading' && gradingViewMode !== 'pdf' && renderGrading()}
      {mode === 'results' && (!showReviewPDF || !pdfUrl) && renderResults()}
      {mode === 'saved_questions' && renderSavedQuestions()}
      {(mode as string) === 'saved_notes' && renderSavedNotes()}
      {mode === 'memorize' && renderMemorize()}
      {mode === 'ustasi' && renderUstasi()}
      {mode === 'analiz' && renderAnaliz()}
      {mode === 'calisma' && renderCalisma()}
      {gameModeQuestions && renderGameMode()}
      {renderNoteModal()}
      {renderQuestionCropModal()}
      {renderNoteLayoutBuilder()}
      {renderNoteReview()}
      {renderAddMemorizeModal()}
      {memorizeReviewCards && renderMemorizeReview()}
      {renderUstasiStatsModal()}

      {/* FIX: Fotoğraf/galeri upload için gizli inputlar */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        onChange={handlePhotoFileChange}
        className="hidden"
      />
      <input
        ref={photoCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handlePhotoFileChange}
        className="hidden"
      />

      {confirmModal?.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl shadow-2xl max-w-sm w-full text-center animate-in zoom-in-95 duration-200">
            <h3 className="text-xl font-bold text-white mb-4">Onay</h3>
            <p className="text-slate-400 mb-6">{confirmModal.message}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmModal(null)}
                className="flex-1 py-3 rounded-xl font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors"
              >
                İptal
              </button>
              <button
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                className="flex-1 py-3 rounded-xl font-bold text-white bg-rose-600 hover:bg-rose-700 transition-colors"
              >
                Onayla
              </button>
            </div>
          </div>
        </div>
      )}

      {showFinishModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl shadow-2xl max-w-sm w-full text-center animate-in zoom-in-95 duration-200">
            <div className="w-16 h-16 bg-amber-900/30 text-amber-400 rounded-full flex items-center justify-center mx-auto mb-4">
              <ListChecks size={32} />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Sınavı Bitir</h3>
            <p className="text-slate-400 mb-6 text-sm">
              Henüz cevaplamadığınız sorular var. ({Object.keys(userAnswers).length} / {questionCount} cevaplandı)
              <br /><br />
              Yine de sınavı bitirmek istiyor musunuz?
            </p>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowFinishModal(false)}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-white px-4 py-3 rounded-xl font-medium transition-colors border border-slate-700"
              >
                İptal
              </button>
              <button 
                onClick={confirmFinish}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-xl font-medium transition-colors"
              >
                Bitir
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettingsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl shadow-2xl max-w-sm w-full text-left animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                <Settings size={24} className="text-blue-400" /> Ayarlar
              </h3>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-full transition-colors"
              >
                <XCircle size={24} />
              </button>
            </div>
            
            <div className="space-y-4">
              {user && (
                <div className="bg-slate-800/50 rounded-2xl p-4 border border-slate-700/50">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-slate-200 flex items-center gap-2">💾 Depolama Kullanımı</h4>
                    <button
                      onClick={async () => {
                        if (!user) return;
                        try {
                          const token = await user.getIdToken();
                          const BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/pdftest/api';
                          const r = await fetch(`${BASE}/storage-usage`, { headers: { Authorization: `Bearer ${token}` } });
                          if (r.ok) {
                            const d = await r.json();
                            setStorageDetails({
                              pdfBytes: d.pdfBytes || 0, pdfCount: d.pdfCount || 0,
                              imageBytes: d.imageBytes || 0, imageCount: d.imageCount || 0,
                              noteImageBytes: d.noteImageBytes || 0, noteImageCount: d.noteImageCount || 0,
                              sessionBytes: d.sessionBytes || 0, sessionCount: d.sessionCount || 0,
                              noteBytes: d.noteBytes || 0, noteCount: d.noteCount || 0,
                              questionMetaBytes: d.questionMetaBytes || 0, questionCount: d.questionCount || 0,
                              memorizeBytes: d.memorizeBytes || 0, memorizeCount: d.memorizeCount || 0,
                              drawingCount: d.drawingCount || 0, bookmarkCount: d.bookmarkCount || 0,
                              pdfMarkCount: d.pdfMarkCount || 0, readPageCount: d.readPageCount || 0,
                            });
                            setStorageUsed(d.bytes || 0);
                          }
                        } catch {}
                      }}
                      className="text-[10px] text-slate-400 hover:text-blue-400 transition-colors flex items-center gap-1 px-2 py-1 rounded bg-slate-900/50 border border-slate-700/50"
                      title="Yenile"
                    ><RefreshCw size={10} /> Yenile</button>
                  </div>
                  {(() => {
                    const fmt = (b: number) => b >= 1024*1024 ? `${(b/(1024*1024)).toFixed(1)} MB` : b >= 1024 ? `${(b/1024).toFixed(0)} KB` : `${b} B`;
                    const rows = [
                      { icon: '📄', label: 'PDF Dosyaları', bytes: storageDetails.pdfBytes, count: storageDetails.pdfCount, unit: 'adet', color: 'text-red-300' },
                      { icon: '🖼️', label: 'Kaydedilen Sorular', bytes: storageDetails.imageBytes, count: storageDetails.imageCount, unit: 'soru', color: 'text-blue-300' },
                      { icon: '📝', label: 'Not Resimleri', bytes: storageDetails.noteImageBytes, count: storageDetails.noteImageCount, unit: 'görsel', color: 'text-green-300' },
                      { icon: '📌', label: 'Notlar (metin)', bytes: storageDetails.noteBytes, count: storageDetails.noteCount, unit: 'not', color: 'text-emerald-300' },
                      { icon: '📚', label: 'Sınav Oturumları', bytes: storageDetails.sessionBytes, count: storageDetails.sessionCount, unit: 'oturum', color: 'text-amber-300' },
                      { icon: '🧠', label: 'Ezber Kartları', bytes: storageDetails.memorizeBytes, count: storageDetails.memorizeCount, unit: 'kart', color: 'text-violet-300' },
                      { icon: '📊', label: 'Soru Metadata', bytes: storageDetails.questionMetaBytes, count: storageDetails.questionCount, unit: 'kayıt', color: 'text-cyan-300' },
                    ];
                    return (
                      <div className="space-y-1.5">
                        {rows.map(r => {
                          const pct = storageUsed > 0 ? (r.bytes / storageUsed) * 100 : 0;
                          return (
                            <div key={r.label} className="group">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400 flex items-center gap-1.5">
                                  <span>{r.icon}</span>
                                  <span className={r.color}>{r.label}</span>
                                  <span className="text-slate-600 text-[10px]">· {r.count} {r.unit}</span>
                                </span>
                                <span className="text-white font-mono text-[11px]">{fmt(r.bytes)}</span>
                              </div>
                              {r.bytes > 0 && (
                                <div className="h-0.5 bg-slate-800 rounded-full overflow-hidden mt-0.5 mb-1">
                                  <div className={`h-full ${r.color.replace('text-', 'bg-').replace('-300', '-500')} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {/* Alt satır — detay bilgiler */}
                        <div className="pt-2 mt-2 border-t border-slate-700/50">
                          <div className="text-[10px] text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                            <span>✏️ {storageDetails.drawingCount} çizim</span>
                            <span>⭐ {storageDetails.bookmarkCount} yer işareti</span>
                            <span>🟡 {storageDetails.pdfMarkCount} sayfa işareti</span>
                            <span>✓ {storageDetails.readPageCount} okunmuş sayfa</span>
                          </div>
                        </div>
                        {/* Toplam */}
                        <div className="pt-2 mt-2 border-t border-slate-700">
                          <div className="flex justify-between items-center text-sm font-semibold">
                            <span className="text-slate-200">Toplam</span>
                            <span className={`font-mono ${storageUsed / STORAGE_LIMIT > 0.9 ? 'text-rose-400' : 'text-blue-400'}`}>
                              {fmt(storageUsed)} / {(STORAGE_LIMIT/(1024*1024*1024)).toFixed(0)} GB
                            </span>
                          </div>
                          <div className="h-2 bg-slate-700 rounded-full overflow-hidden mt-2">
                            <div
                              className={`h-full rounded-full transition-all ${storageUsed / STORAGE_LIMIT > 0.9 ? 'bg-rose-500' : storageUsed / STORAGE_LIMIT > 0.7 ? 'bg-amber-500' : 'bg-blue-500'}`}
                              style={{ width: `${Math.min(100, (storageUsed / STORAGE_LIMIT) * 100)}%` }}
                            />
                          </div>
                          <div className="text-[10px] text-slate-500 text-right mt-0.5">
                            %{Math.round((storageUsed / STORAGE_LIMIT) * 100)} dolu
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Otomatik Kaydetme Süresi (Dakika)
                </label>
                <p className="text-xs text-slate-500 mb-3">
                  Sınav oturumunuzun ne sıklıkla otomatik olarak kaydedileceğini belirleyin. Kapatmak için 0 yazın.
                </p>
                <input
                  type="number"
                  min="0"
                  max="60"
                  value={autoSaveInterval}
                  onChange={(e) => setAutoSaveInterval(parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              </div>
            </div>

            <div className="mt-8">
              <button 
                onClick={() => setShowSettingsModal(false)}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-xl font-medium transition-colors"
              >
                Kaydet ve Kapat
              </button>
            </div>
          </div>
        </div>
      )}
      {showTrackingModal && (
        <div className="fixed inset-0 z-[9999] flex flex-col bg-slate-950 overflow-hidden">
          <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <ListChecks size={20} className="text-blue-400" />
              <h2 className="text-lg font-bold text-white">Konu Takibi</h2>
            </div>
            <button onClick={() => setShowTrackingModal(false)} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg">
              <X size={20} />
            </button>
          </div>

          <div className="flex gap-1 p-3 bg-slate-900 border-b border-slate-800 overflow-x-auto shrink-0">
            {Object.keys(KPSS_TOPICS_LIST).map(subject => (
              <button key={subject} onClick={() => setTrackingActiveSubject(subject)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  trackingActiveSubject === subject ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800"
                }`}
              >{subject}</button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {KPSS_TOPICS_LIST[trackingActiveSubject].map(topic => {
              const relevantPdfs = pdfLibrary.filter(p => p.subject === trackingActiveSubject && p.category === 'Soru Bankası');
              return (
                <div key={topic} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                  <div className="bg-slate-800/50 px-4 py-3 border-b border-slate-700 flex justify-between items-center">
                    <span className="text-sm font-bold text-white">{topic}</span>
                    <span className="text-[10px] text-slate-500 font-mono">{relevantPdfs.length} Kitap</span>
                  </div>
                  <div className="divide-y divide-slate-800">
                    {relevantPdfs.length === 0 ? (
                      <div className="text-[10px] text-slate-600 italic px-4 py-3">Soru Bankası bulunamadı.</div>
                    ) : (
                      relevantPdfs.map(pdf => {
                        const existing = trackingData.find(t => t.subject === trackingActiveSubject && t.topic === topic && t.pdf_name === pdf.name) || 
                                         { subject: trackingActiveSubject, topic, pdf_name: pdf.name, pdf_id: pdf.id, status: 'pending' };
                        return (
                          <div key={pdf.id} className="px-4 py-3 flex flex-col gap-3">
                            <p className="text-xs text-slate-300 font-medium">{pdf.name}</p>
                            <div className="flex items-center gap-2 flex-wrap">
                              {['pending', 'ongoing', 'completed', 'review'].map(s => (
                                <button key={s} onClick={() => saveTracking({ ...existing, status: s, pdf_name: pdf.name, pdf_id: pdf.id })}
                                  className={`px-2 py-1 rounded text-[10px] font-bold ${
                                    existing.status === s ? (s==='completed'?'bg-green-600':s==='ongoing'?'bg-blue-600':s==='review'?'bg-orange-600':'bg-slate-600') + ' text-white' : 'bg-slate-800 text-slate-500'
                                  }`}
                                >{s==='pending'?'Bekliyor':s==='ongoing'?'Devam':s==='completed'?'Tamam':'Tekrar'}</button>
                              ))}
                              <div className="flex items-center gap-1 ml-auto">
                                <span className="text-[10px] text-slate-500">S</span>
                                <input type="number" min="0" value={existing.question_count || ''}
                                  onChange={e => saveTracking({ ...existing, question_count: +e.target.value, pdf_name: pdf.name, pdf_id: pdf.id })}
                                  className="w-10 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-xs text-center text-white" />
                                <span className="text-[10px] text-green-500">D</span>
                                <input type="number" min="0" value={existing.correct_count || ''}
                                  onChange={e => saveTracking({ ...existing, correct_count: +e.target.value, pdf_name: pdf.name, pdf_id: pdf.id })}
                                  className="w-10 bg-slate-800 border border-green-900 rounded px-1 py-0.5 text-xs text-center text-green-400" />
                                <span className="text-[10px] text-red-500">Y</span>
                                <input type="number" min="0" value={existing.wrong_count || ''}
                                  onChange={e => saveTracking({ ...existing, wrong_count: +e.target.value, pdf_name: pdf.name, pdf_id: pdf.id })}
                                  className="w-10 bg-slate-800 border border-red-900 rounded px-1 py-0.5 text-xs text-center text-red-400" />
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showLoginModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-8 w-full max-w-sm mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 bg-blue-600/20 rounded-lg">
                <LogIn size={20} className="text-blue-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">Giriş Yap</h2>
                <p className="text-xs text-slate-400">pdftest hesabınız</p>
              </div>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Kullanıcı adı"
                value={loginUsername}
                onChange={e => setLoginUsername(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                className="w-full bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <input
                type="text"
                placeholder="Şifre"
                value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="w-full bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              {loginError && (
                <p className="text-red-400 text-xs bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">{loginError}</p>
              )}
              <button
                onClick={handleLogin}
                disabled={loginLoading || !loginUsername || !loginPassword}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
              >
                {loginLoading ? 'Giriş yapılıyor...' : 'Giriş Yap'}
              </button>
              <button
                onClick={() => { setShowLoginModal(false); setLoginError(''); }}
                className="w-full text-slate-400 hover:text-slate-200 text-sm py-2"
              >
                İptal
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
