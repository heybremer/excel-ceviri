import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { columnLetterToIndex, columnOptions, indexToColumnLetter } from './columns';
import { LANGUAGES } from './languages';
import { translateWithOpenAI } from './translate';
import './App.css';

// ─── Types ───────────────────────────────────────────────────────────────────
type TargetRow = { id: string; columnLetter: string; langCode: string };
type CellStatus = 'pending' | 'translating' | 'done' | 'failed';
type CellResult = { status: CellStatus; text?: string; error?: string };
type CellInfo = { row: number; targetIdx: number; langCode: string; key: string };
type TranslationConfig = {
  srcIdx: number; sourceLang: string; apiKey: string; model: string; concurrency: number;
};
interface SavedSession {
  version: number;
  fileName: string;
  configHash: string;
  completedResults: Record<string, string>;
  timestamp: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function padRow(row: string[], len: number): string[] {
  const r = [...row];
  while (r.length < len) r.push('');
  return r;
}
function maxCols(data: string[][]): number {
  return data.reduce((m, r) => Math.max(m, r.length), 0);
}
function configHash(src: string, sl: string, tgts: TargetRow[]): string {
  return JSON.stringify({ src, sl, tgts: tgts.map(t => `${t.columnLetter}:${t.langCode}`).sort() });
}

// ─── Session ─────────────────────────────────────────────────────────────────
const SK = 'xceviri_v1';
function sessionLoad(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SK);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedSession;
    if (s.version !== 1) return null;
    if (Date.now() - s.timestamp > 86_400_000) { localStorage.removeItem(SK); return null; }
    return s;
  } catch { return null; }
}
function sessionSave(s: SavedSession) { try { localStorage.setItem(SK, JSON.stringify(s)); } catch {} }
function sessionClear() { try { localStorage.removeItem(SK); } catch {} }

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  // File
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [data, setData] = useState<string[][]>([]);
  const [skipHeader, setSkipHeader] = useState(true);

  // Config
  const [sourceColumn, setSourceColumn] = useState('A');
  const [sourceLang, setSourceLang] = useState('tr');
  const [targets, setTargets] = useState<TargetRow[]>([
    { id: uid(), columnLetter: 'B', langCode: 'de' },
    { id: uid(), columnLetter: 'C', langCode: 'it' },
    { id: uid(), columnLetter: 'D', langCode: 'es' },
    { id: uid(), columnLetter: 'E', langCode: 'en' },
  ]);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-4o-mini');
  const [concurrency, setConcurrency] = useState(3);

  // Translation state
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const resultsRef = useRef<Map<string, CellResult>>(new Map());
  const [tick, setTick] = useState(0);
  const [stats, setStats] = useState({ done: 0, failed: 0, total: 0, startMs: 0 });
  const gridRef = useRef<string[][]>([]);
  const [finalGrid, setFinalGrid] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<SavedSession | null>(null);
  const [hasServerKey, setHasServerKey] = useState(false);

  // Refs
  const pauseRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastSaveRef = useRef(0);

  const srcIdx = useMemo(() => columnLetterToIndex(sourceColumn), [sourceColumn]);
  const colList = useMemo(() => columnOptions(maxCols(data) - 1), [data]);

  // Ticker for live ETA
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick(t => t + 1), 1500);
    return () => clearInterval(id);
  }, [busy]);

  // Persist API key
  useEffect(() => {
    try {
      const k = sessionStorage.getItem('oai_k');
      if (k) setApiKey(k);

      // Check server config
      fetch('/api/config')
        .then(r => r.json())
        .then(d => setHasServerKey(!!d.hasServerKey))
        .catch(() => {});
    } catch {}
  }, []);
  const persistKey = (v: string) => { setApiKey(v); try { sessionStorage.setItem('oai_k', v); } catch {} };

  const bump = useCallback(() => setTick(t => t + 1), []);

  // File load
  const loadFile = useCallback((file: File) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const buf = e.target?.result as ArrayBuffer;
        const wb = XLSX.read(buf, { type: 'array' });
        const name = wb.SheetNames[0] ?? '';
        const ws = wb.Sheets[name];
        if (!ws) { setError('Dosyada sayfa bulunamadı.'); return; }
        const rows = XLSX.utils.sheet_to_json<string[][]>(ws, { header: 1, defval: '', raw: false }) as string[][];
        setSheetName(name); setData(rows); setFileName(file.name);
        setFinalGrid(null); setStats({ done: 0, failed: 0, total: 0, startMs: 0 });
        resultsRef.current = new Map();
        const s = sessionLoad();
        setResumable(s && s.fileName === file.name ? s : null);
      } catch { setError('Dosya okunamadı. .xlsx veya .xls deneyin.'); }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  // Drag & drop
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && /\.(xlsx?|xlsm)$/i.test(f.name)) loadFile(f);
    else setError('Lütfen .xlsx veya .xls dosyası bırakın.');
  };
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = '';
  };

  // Target management
  const addTarget = () => {
    const used = new Set(targets.map(t => t.columnLetter));
    setTargets(t => [...t, { id: uid(), columnLetter: colList.find(c => !used.has(c)) ?? 'Z', langCode: 'fr' }]);
  };
  const removeTarget = (id: string) => setTargets(t => t.filter(x => x.id !== id));
  const patchTarget = (id: string, p: Partial<TargetRow>) => setTargets(t => t.map(x => x.id === id ? { ...x, ...p } : x));

  // Validation
  const validate = (): string | null => {
    if (!data.length) return 'Önce bir Excel dosyası yükleyin.';
    if (!apiKey.trim() && !hasServerKey) return 'OpenAI API anahtarını girin.';
    const idxs = targets.map(t => columnLetterToIndex(t.columnLetter));
    if (new Set(idxs).size !== idxs.length) return 'Aynı hedef sütunu iki kez seçemezsiniz.';
    if (idxs.includes(srcIdx)) return 'Hedef sütun, kaynak sütunla aynı olamaz.';
    return null;
  };

  // Core parallel worker pool
  const runWorkers = async (
    cells: CellInfo[], cfg: TranslationConfig, signal: AbortSignal,
    prevDone: number, totalCells: number,
  ) => {
    const queue = [...cells];
    let doneCount = prevDone;

    const worker = async () => {
      while (queue.length > 0) {
        if (signal.aborted) return;
        while (pauseRef.current && !signal.aborted) await sleep(150);
        if (signal.aborted) return;

        const cell = queue.shift();
        if (!cell) return;

        const text = String(gridRef.current[cell.row]?.[cfg.srcIdx] ?? '').trim();
        if (!text) { doneCount++; setStats(s => ({ ...s, done: doneCount })); continue; }

        resultsRef.current.set(cell.key, { status: 'translating' });
        bump();

        try {
          const out = await translateWithOpenAI(text, cfg.sourceLang, cell.langCode, cfg.apiKey, cfg.model, signal);
          if (signal.aborted) return;
          gridRef.current[cell.row][cell.targetIdx] = out;
          resultsRef.current.set(cell.key, { status: 'done', text: out });
          doneCount++;
          setStats(s => ({ ...s, done: doneCount }));

          // Throttled session autosave
          const now = Date.now();
          if (now - lastSaveRef.current > 1200) {
            lastSaveRef.current = now;
            const cr: Record<string, string> = {};
            resultsRef.current.forEach((v, k) => { if (v.status === 'done' && v.text) cr[k] = v.text; });
            sessionSave({ version: 1, fileName: fileName!, configHash: configHash(sourceColumn, cfg.sourceLang, targets), completedResults: cr, timestamp: Date.now() });
          }
        } catch (err) {
          if (signal.aborted) return;
          resultsRef.current.set(cell.key, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
          setStats(s => ({ ...s, failed: s.failed + 1 }));
        }
        bump();
      }
    };

    setStats(s => ({ ...s, total: totalCells }));
    await Promise.all(Array.from({ length: cfg.concurrency }, () => worker()));
  };

  // Start / Resume translation
  const startTranslation = async (session?: SavedSession) => {
    const err = validate();
    if (err) { setError(err); return; }

    const tgts = targets.map(t => ({ ...t, idx: columnLetterToIndex(t.columnLetter) }));
    const rowStart = skipHeader ? 1 : 0;
    const minCols = Math.max(srcIdx + 1, ...tgts.map(t => t.idx + 1));
    const hash = configHash(sourceColumn, sourceLang, targets);

    // Build grid
    const grid = data.map(r => padRow(r.map(c => String(c ?? '')), minCols));
    gridRef.current = grid;

    // Apply resumed results
    const prevDone: Record<string, string> = {};
    resultsRef.current = new Map();

    if (session && session.configHash === hash) {
      Object.entries(session.completedResults).forEach(([k, v]) => {
        prevDone[k] = v;
        const [rs, cs] = k.split(':');
        const r = Number(rs), c = Number(cs);
        if (!isNaN(r) && !isNaN(c) && r < grid.length) grid[r][c] = v;
        resultsRef.current.set(k, { status: 'done', text: v });
      });
    }

    // Build cell queue (skip already done)
    const cells: CellInfo[] = [];
    for (let r = rowStart; r < data.length; r++) {
      if (!String(data[r]?.[srcIdx] ?? '').trim()) continue;
      for (const t of tgts) {
        const key = `${r}:${t.idx}`;
        if (prevDone[key]) continue;
        cells.push({ row: r, targetIdx: t.idx, langCode: t.langCode, key });
        resultsRef.current.set(key, { status: 'pending' });
      }
    }

    const alreadyDone = Object.keys(prevDone).length;
    const total = alreadyDone + cells.length;
    if (total === 0) { setError('Kaynak sütunda çevrilecek dolu hücre yok.'); return; }

    setStats({ done: alreadyDone, failed: 0, total, startMs: Date.now() });
    setError(null); setFinalGrid(null); setBusy(true); setPaused(false);
    pauseRef.current = false; setResumable(null); bump();

    const ac = new AbortController();
    abortRef.current = ac;
    const cfg: TranslationConfig = { srcIdx, sourceLang, apiKey: apiKey.trim(), model, concurrency };

    try {
      await runWorkers(cells, cfg, ac.signal, alreadyDone, total);
    } finally {
      setBusy(false); setPaused(false); pauseRef.current = false;
      setFinalGrid(gridRef.current.map(r => [...r]));
      if (!ac.signal.aborted) sessionClear();
    }
  };

  const handlePause = () => { pauseRef.current = true; setPaused(true); };
  const handleResume = () => { pauseRef.current = false; setPaused(false); };
  const handleCancel = () => { abortRef.current?.abort(); };

  const handleRetry = async () => {
    const failed: CellInfo[] = [];
    resultsRef.current.forEach((v, k) => {
      if (v.status !== 'failed') return;
      const [rs, cs] = k.split(':');
      const r = Number(rs), c = Number(cs);
      const t = targets.find(x => columnLetterToIndex(x.columnLetter) === c);
      if (t) { failed.push({ row: r, targetIdx: c, langCode: t.langCode, key: k }); resultsRef.current.set(k, { status: 'pending' }); }
    });
    if (!failed.length) return;

    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true); setPaused(false); pauseRef.current = false; setError(null);
    setStats(s => ({ ...s, failed: 0, startMs: Date.now() }));
    bump();

    const cfg: TranslationConfig = { srcIdx, sourceLang, apiKey: apiKey.trim(), model, concurrency };
    try {
      await runWorkers(failed, cfg, ac.signal, stats.done, stats.total);
    } finally {
      setBusy(false); setPaused(false); pauseRef.current = false;
      setFinalGrid(gridRef.current.map(r => [...r]));
    }
  };

  const downloadExcel = () => {
    if (!finalGrid) return;
    const out = (fileName ?? 'liste').replace(/\.(xlsx?|xlsm)$/i, '');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(finalGrid), sheetName.slice(0, 31) || 'Sayfa1');
    XLSX.writeFile(wb, `${out}_cevirilmis.xlsx`);
  };

  // Computed
  const failedCount = useMemo(() => {
    let n = 0; resultsRef.current.forEach(v => { if (v.status === 'failed') n++; }); return n;
  }, [tick]);

  const pct = stats.total > 0 ? (stats.done / stats.total) * 100 : 0;

  const eta = useMemo(() => {
    if (!busy || !stats.startMs || stats.done < 3) return null;
    const elapsed = Date.now() - stats.startMs;
    const rem = (stats.total - stats.done) / (stats.done / elapsed);
    if (rem < 60_000) return `~${Math.ceil(rem / 1000)}s`;
    return `~${Math.ceil(rem / 60_000)} dk`;
  }, [tick, busy, stats]);

  const speed = useMemo(() => {
    if (!busy || !stats.startMs || stats.done < 2) return null;
    const elapsed = (Date.now() - stats.startMs) / 1000;
    return `${(stats.done / elapsed).toFixed(1)}/s`;
  }, [tick, busy, stats]);

  // Live preview
  const previewData = useMemo(() => {
    if (!data.length) return [];
    const start = skipHeader ? 1 : 0;
    return data.slice(start, start + 8).map((row, ri) => {
      const rowIdx = start + ri;
      return {
        rowIdx,
        src: String(row[srcIdx] ?? ''),
        cols: targets.map(t => {
          const key = `${rowIdx}:${columnLetterToIndex(t.columnLetter)}`;
          return { letter: t.columnLetter, langCode: t.langCode, result: resultsRef.current.get(key) };
        }),
      };
    });
  }, [data, targets, srcIdx, skipHeader, tick]);

  const hasResults = resultsRef.current.size > 0;
  const isComplete = !busy && stats.total > 0 && stats.done >= stats.total - failedCount;

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-inner">
          <h1 className="hdr-title">Excel Çeviri</h1>
          <p className="hdr-sub">Sütunları OpenAI ile istediğiniz dillere çevirin, kaydetsin, indirebilirsiniz</p>
        </div>
      </header>

      <div className="main">

        {/* ── 1. Dosya ── */}
        <section className="card">
          <h2 className="card-hd"><span className="badge">1</span>Dosya</h2>

          <div
            className={`dz ${isDragging ? 'dz-hover' : ''} ${fileName ? 'dz-filled' : ''}`}
            onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
          >
            {fileName ? (
              <div className="dz-file">
                <span className="dz-file-icon">📊</span>
                <span className="dz-file-name">{fileName}</span>
                <label className="btn btn-ghost btn-sm">
                  Değiştir
                  <input type="file" accept=".xlsx,.xls,.xlsm" onChange={onFileInput} hidden disabled={busy} />
                </label>
              </div>
            ) : (
              <div className="dz-empty">
                <svg className="dz-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <p className="dz-hint-main">Dosyayı buraya sürükleyin</p>
                <p className="dz-hint-sub">veya</p>
                <label className="btn btn-primary">
                  Dosya Seç
                  <input type="file" accept=".xlsx,.xls,.xlsm" onChange={onFileInput} hidden />
                </label>
                <p className="dz-hint-ext">.xlsx · .xls · .xlsm</p>
              </div>
            )}
          </div>

          {data.length > 0 && (
            <div className="file-meta">
              <label className="chk-label">
                <input type="checkbox" checked={skipHeader} onChange={e => setSkipHeader(e.target.checked)} />
                İlk satırı başlık olarak atla
              </label>
              <span className="muted">{data.length} satır · {maxCols(data)} sütun</span>
            </div>
          )}

          {data.slice(0, 5).length > 0 && (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>{(data[0] ?? []).map((_, i) => <th key={i}>{indexToColumnLetter(i)}</th>)}</tr>
                </thead>
                <tbody>
                  {data.slice(0, 5).map((row, ri) => (
                    <tr key={ri} className={ri === 0 && skipHeader ? 'tbl-hdr-row' : ''}>
                      {row.map((c, ci) => <td key={ci} title={String(c)}>{String(c)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── 2. Yapay Zeka ── */}
        <section className="card">
          <h2 className="card-hd"><span className="badge">2</span>Yapay Zeka (OpenAI)</h2>
          <div className="row gap">
            <div className="field grow">
              <label>API Anahtarı {hasServerKey && <span className="badge-sm">Sunucu Hazır</span>}</label>
              <input type="password" className="input" placeholder={hasServerKey ? "Sunucu anahtarı aktif (veya kendinizinkini girin)" : "sk-..."} value={apiKey} onChange={e => persistKey(e.target.value)} disabled={busy} autoComplete="off" />
            </div>
            <div className="field w160">
              <label>Model</label>
              <select className="select" value={model} onChange={e => setModel(e.target.value)} disabled={busy}>
                <option value="gpt-4o-mini">gpt-4o-mini (Hızlı & Ucuz) ⚡</option>
                <option value="gpt-4o">gpt-4o (En İyi)</option>
                <option value="gpt-4-turbo">gpt-4-turbo</option>
                <option value="o1-mini">o1-mini (Mantıksal)</option>
                <option value="gpt-3.5-turbo">gpt-3.5-turbo</option>
              </select>
            </div>
            <div className="field w140">
              <label>Eş zamanlı istek</label>
              <select className="select" value={concurrency} onChange={e => setConcurrency(+e.target.value)} disabled={busy}>
                <option value={1}>1 (yavaş)</option>
                <option value={3}>3 (önerilen)</option>
                <option value={5}>5 (hızlı)</option>
                <option value={10}>10 (çok hızlı)</option>
              </select>
            </div>
          </div>
          <p className="note">
            {hasServerKey
              ? "Sistem anahtarı tanımlı. İsterseniz kendi anahtarınızı girerek onu kullanabilirsiniz."
              : "Anahtar yalnızca tarayıcınızda (sessionStorage) tutulur, hiçbir sunucuya gönderilmez."}
          </p>
        </section>

        {/* ── 3. Kaynak ── */}
        <section className="card">
          <h2 className="card-hd"><span className="badge">3</span>Kaynak</h2>
          <div className="row gap">
            <div className="field w160">
              <label>Çevrilecek sütun</label>
              <select className="select" value={sourceColumn} onChange={e => setSourceColumn(e.target.value)} disabled={busy || !data.length}>
                {colList.map(c => <option key={c} value={c}>Sütun {c}</option>)}
              </select>
            </div>
            <div className="field w220">
              <label>Kaynak dil</label>
              <select className="select" value={sourceLang} onChange={e => setSourceLang(e.target.value)} disabled={busy}>
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
          </div>
        </section>

        {/* ── 4. Hedefler ── */}
        <section className="card">
          <h2 className="card-hd">
            <span className="badge">4</span>Hedef Sütunlar
            <button className="btn btn-ghost btn-sm ml-auto" onClick={addTarget} disabled={busy}>+ Ekle</button>
          </h2>
          <div className="targets">
            {targets.map(t => (
              <div className="tgt-row" key={t.id}>
                <div className="tgt-col-badge">{t.columnLetter}</div>
                <div className="field w100">
                  <label>Sütun</label>
                  <select className="select" value={t.columnLetter} onChange={e => patchTarget(t.id, { columnLetter: e.target.value })} disabled={busy || !data.length}>
                    {colList.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field grow">
                  <label>Hedef dil</label>
                  <select className="select" value={t.langCode} onChange={e => patchTarget(t.id, { langCode: e.target.value })} disabled={busy}>
                    {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                  </select>
                </div>
                <button className="btn btn-icon" onClick={() => removeTarget(t.id)} disabled={busy || targets.length <= 1} title="Kaldır">✕</button>
              </div>
            ))}
          </div>
        </section>

        {/* ── 5. Çevir ── */}
        <section className="card">
          <h2 className="card-hd"><span className="badge">5</span>Çevir ve İndir</h2>

          {/* Resume banner */}
          {resumable && !busy && (
            <div className="resume-box">
              <div className="resume-left">
                <span className="resume-ico">⏸</span>
                <div>
                  <strong>Yarım kalan çeviri bulundu</strong>
                  <p>{Object.keys(resumable.completedResults).length} hücre tamamlanmıştı · {new Date(resumable.timestamp).toLocaleTimeString('tr-TR')}</p>
                </div>
              </div>
              <div className="row gap-sm">
                <button className="btn btn-primary" onClick={() => startTranslation(resumable)}>
                  ▶ Kaldığı Yerden Devam Et
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => { sessionClear(); setResumable(null); }}>
                  Yeni Başlat
                </button>
              </div>
            </div>
          )}

          {/* Action bar */}
          <div className="action-bar">
            {!busy && !resumable && (
              <button className="btn btn-primary btn-lg" onClick={() => startTranslation()} disabled={!data.length || (!apiKey.trim() && !hasServerKey)}>
                ▶ Çeviriye Başla
              </button>
            )}
            {busy && !paused && <button className="btn btn-warn" onClick={handlePause}>⏸ Duraklat</button>}
            {busy && paused && <button className="btn btn-primary" onClick={handleResume}>▶ Devam Et</button>}
            {busy && <button className="btn btn-ghost" onClick={handleCancel}>✕ İptal</button>}
            {!busy && failedCount > 0 && (
              <button className="btn btn-warn" onClick={handleRetry}>↻ Hatalıları Tekrar Dene ({failedCount})</button>
            )}
            {finalGrid && (
              <button className={`btn btn-success btn-lg ${isComplete ? 'btn-pulse' : ''}`} onClick={downloadExcel}>
                ⬇ Excel İndir
              </button>
            )}
          </div>

          {/* Progress */}
          {stats.total > 0 && (
            <div className="prog-wrap">
              <div className="prog-meta">
                <span className={`prog-label ${paused ? 'c-warn' : busy ? 'c-accent' : 'c-green'}`}>
                  {paused ? '⏸ Duraklatıldı' : busy ? '⚡ Çevriliyor' : '✓ Tamamlandı'}
                </span>
                <span className="prog-right">
                  <span className="prog-count">{stats.done}/{stats.total}</span>
                  {failedCount > 0 && <span className="pill-red">{failedCount} hata</span>}
                  {speed && <span className="muted"> · {speed}</span>}
                  {eta && <span className="muted"> · {eta} kaldı</span>}
                </span>
              </div>
              <div className="prog-track">
                <div className="prog-fill" style={{ width: `${pct}%` }} />
              </div>
              {failedCount > 0 && (
                <div className="prog-err-bar" style={{ width: `${(failedCount / stats.total) * 100}%` }} />
              )}
            </div>
          )}

          {error && <div className="alert-err">{error}</div>}
        </section>

        {/* ── Canlı Önizleme ── */}
        {hasResults && previewData.length > 0 && (
          <section className="card">
            <h2 className="card-hd">
              Canlı Önizleme
              <span className="muted text-sm" style={{ marginLeft: '0.5rem', fontWeight: 400 }}>ilk 8 satır</span>
            </h2>
            <div className="tbl-wrap">
              <table className="tbl preview-tbl">
                <thead>
                  <tr>
                    <th className="src-th">
                      {sourceColumn} · {LANGUAGES.find(l => l.code === sourceLang)?.label}
                    </th>
                    {targets.map(t => (
                      <th key={t.id}>{t.columnLetter} · {LANGUAGES.find(l => l.code === t.langCode)?.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.map(({ rowIdx, src, cols }) => (
                    <tr key={rowIdx}>
                      <td className="src-cell">{src || <span className="muted">—</span>}</td>
                      {cols.map(({ letter, result }) => {
                        const s = result?.status;
                        return (
                          <td key={letter} className={`c-${s ?? 'idle'}`} title={result?.error}>
                            {s === 'translating' && <span className="spinner">⟳ </span>}
                            {s === 'done' && result?.text}
                            {s === 'failed' && <span className="err-txt" title={result?.error}>✕ Hata</span>}
                            {(!s || s === 'pending') && <span className="idle-dot">·</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

      </div>
    </div>
  );
}
