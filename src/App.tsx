import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { columnLetterToIndex, columnOptions, indexToColumnLetter } from './columns';
import { LANGUAGES } from './languages';
import { translateWithDelay } from './translate';
import './App.css';

type TargetRow = { id: string; columnLetter: string; langCode: string };

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function padRows(data: string[][], minCols: number): string[][] {
  return data.map((row) => {
    const r = [...row];
    while (r.length < minCols) r.push('');
    return r;
  });
}

function maxColIndex(data: string[][]): number {
  let m = 0;
  for (const row of data) {
    m = Math.max(m, row.length);
  }
  return Math.max(m - 1, 0);
}

export default function App() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState<string>('');
  const [data, setData] = useState<string[][]>([]);
  const [sourceColumn, setSourceColumn] = useState('A');
  const [sourceLang, setSourceLang] = useState('tr');
  const [targets, setTargets] = useState<TargetRow[]>([
    { id: uid(), columnLetter: 'B', langCode: 'de' },
    { id: uid(), columnLetter: 'C', langCode: 'it' },
    { id: uid(), columnLetter: 'D', langCode: 'es' },
    { id: uid(), columnLetter: 'E', langCode: 'en' },
  ]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [abortRef, setAbortRef] = useState<AbortController | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-4o-mini');

  const colList = useMemo(() => columnOptions(maxColIndex(data)), [data]);

  useEffect(() => {
    try {
      const k = sessionStorage.getItem('openai_api_key');
      if (k) setApiKey(k);
    } catch {
      /* private mode */
    }
  }, []);

  const persistKey = (value: string) => {
    setApiKey(value);
    try {
      sessionStorage.setItem('openai_api_key', value);
    } catch {
      /* ignore */
    }
  };

  const loadFile = useCallback((file: File) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buf = e.target?.result;
        if (!(buf instanceof ArrayBuffer)) return;
        const wb = XLSX.read(buf, { type: 'array' });
        const name = wb.SheetNames[0] ?? '';
        const sheet = wb.Sheets[name];
        if (!sheet) {
          setError('Dosyada sayfa bulunamadı.');
          return;
        }
        const rows = XLSX.utils.sheet_to_json<string[][]>(sheet, {
          header: 1,
          defval: '',
          raw: false,
        }) as string[][];
        setSheetName(name);
        setData(rows);
        setFileName(file.name);
      } catch {
        setError('Excel dosyası okunamadı. .xlsx veya .xls deneyin.');
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const onFileChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    if (f) loadFile(f);
    ev.target.value = '';
  };

  const addTarget = () => {
    const used = new Set(targets.map((t) => t.columnLetter.toUpperCase()));
    const nextLetter = colList.find((c) => !used.has(c)) ?? 'Z';
    setTargets((t) => [...t, { id: uid(), columnLetter: nextLetter, langCode: 'en' }]);
  };

  const removeTarget = (id: string) => {
    setTargets((t) => t.filter((x) => x.id !== id));
  };

  const updateTarget = (id: string, patch: Partial<TargetRow>) => {
    setTargets((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };

  const previewRows = useMemo(() => data.slice(0, 8), [data]);

  const runTranslate = async () => {
    if (!data.length) {
      setError('Önce bir Excel dosyası yükleyin.');
      return;
    }
    if (!apiKey.trim()) {
      setError('OpenAI API anahtarını girin (platform.openai.com).');
      return;
    }
    const srcIdx = columnLetterToIndex(sourceColumn);
    const targetIndices = targets.map((t) => ({
      ...t,
      idx: columnLetterToIndex(t.columnLetter),
    }));

    const dup = new Map<number, string>();
    for (const t of targetIndices) {
      const k = t.idx;
      if (dup.has(k)) {
        setError(`Aynı hedef sütunu iki kez seçemezsiniz: ${indexToColumnLetter(k)}`);
        return;
      }
      dup.set(k, t.columnLetter);
    }
    if (targetIndices.some((t) => t.idx === srcIdx)) {
      setError('Hedef sütunlardan biri kaynak sütunla aynı olamaz.');
      return;
    }

    let minCols = Math.max(srcIdx + 1, ...targetIndices.map((t) => t.idx + 1));
    let grid = padRows(data.map((r) => r.map((c) => (c == null ? '' : String(c)))), minCols);

    const cells: { row: number; targetIdx: number; lang: string }[] = [];
    for (let r = 0; r < grid.length; r++) {
      const raw = grid[r][srcIdx] ?? '';
      const text = String(raw).trim();
      if (!text) continue;
      for (const t of targetIndices) {
        cells.push({ row: r, targetIdx: t.idx, lang: t.langCode });
      }
    }

    if (!cells.length) {
      setError('Kaynak sütunda çevrilecek dolu hücre yok.');
      return;
    }

    const ac = new AbortController();
    setAbortRef(ac);
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: cells.length });

    try {
      for (let i = 0; i < cells.length; i++) {
        if (ac.signal.aborted) throw new Error('İptal edildi.');
        const { row, targetIdx, lang } = cells[i];
        const text = String(grid[row][srcIdx] ?? '').trim();
        const translated = await translateWithDelay(text, sourceLang, lang, apiKey.trim(), model, ac.signal);
        if (grid[row].length <= targetIdx) {
          grid[row] = padRows([grid[row]], targetIdx + 1)[0];
        }
        grid[row][targetIdx] = translated;
        setProgress({ done: i + 1, total: cells.length });
      }

      const outName = (fileName ?? 'liste').replace(/\.(xlsx|xls|xlsm)$/i, '');
      const newWb = XLSX.utils.book_new();
      const newSheet = XLSX.utils.aoa_to_sheet(grid);
      XLSX.utils.book_append_sheet(newWb, newSheet, sheetName.slice(0, 31) || 'Sayfa1');
      XLSX.writeFile(newWb, `${outName}_cevirilmis.xlsx`);
    } catch (e) {
      if (ac.signal.aborted || (e instanceof Error && e.message === 'İptal edildi.')) {
        setError('İşlem iptal edildi.');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
      setAbortRef(null);
    }
  };

  const cancel = () => {
    abortRef?.abort();
  };

  return (
    <div className="app">
      <h1>Excel sütun çevirisi</h1>
      <p className="lead">
        Bir sütundaki metinleri seçtiğiniz dillere çevirip yeni sütunlara yazar ve dosyayı indirirsiniz.
      </p>

      <div className="card">
        <h2>1. Dosya</h2>
        <div className="drop">
          <span>.xlsx / .xls dosyanızı seçin (ilk sayfa kullanılır)</span>
          <input type="file" accept=".xlsx,.xls,.xlsm" onChange={onFileChange} disabled={busy} />
          {fileName && <div className="file-name">{fileName}</div>}
        </div>
        {previewRows.length > 0 && (
          <div className="preview">
            <table>
              <thead>
                <tr>
                  {previewRows[0]?.map((_, i) => (
                    <th key={i}>{indexToColumnLetter(i)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} title={String(cell)}>
                        {String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>2. Yapay zeka (OpenAI)</h2>
        <div className="field" style={{ marginBottom: '1rem' }}>
          <label htmlFor="api-key">OpenAI API anahtarı</label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => persistKey(e.target.value)}
            disabled={busy}
            style={{
              width: '100%',
              padding: '0.55rem 0.65rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'var(--surface2)',
              color: 'var(--text)',
            }}
          />
        </div>
        <div className="field" style={{ marginBottom: '1rem' }}>
          <label htmlFor="model">Model</label>
          <select
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            style={{
              width: '100%',
              padding: '0.55rem 0.65rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'var(--surface2)',
              color: 'var(--text)',
            }}
          >
            <option value="gpt-4o-mini">gpt-4o-mini (önerilen, uygun maliyet)</option>
            <option value="gpt-4o">gpt-4o</option>
            <option value="gpt-4.1-mini">gpt-4.1-mini</option>
            <option value="gpt-4.1">gpt-4.1</option>
          </select>
        </div>
      </div>

      <div className="card">
        <h2>3. Kaynak</h2>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="src-col">Çevrilecek sütun</label>
            <select
              id="src-col"
              value={sourceColumn}
              onChange={(e) => setSourceColumn(e.target.value)}
              disabled={busy || !data.length}
            >
              {colList.map((c) => (
                <option key={c} value={c}>
                  Sütun {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="src-lang">Kaynak dil</label>
            <select
              id="src-lang"
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
              disabled={busy}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>4. Hedef sütunlar ve diller</h2>
        <div className="targets-header">
          <span>Her satırda: sonuç yazılacak sütun + hedef dil</span>
          <button type="button" className="btn btn-ghost" onClick={addTarget} disabled={busy}>
            + Satır ekle
          </button>
        </div>
        {targets.map((t) => (
          <div className="target-row" key={t.id}>
            <div className="field">
              <label>Sütun</label>
              <select
                value={t.columnLetter}
                onChange={(e) => updateTarget(t.id, { columnLetter: e.target.value })}
                disabled={busy || !data.length}
              >
                {colList.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Dil</label>
              <select
                value={t.langCode}
                onChange={(e) => updateTarget(t.id, { langCode: e.target.value })}
                disabled={busy}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => removeTarget(t.id)}
              disabled={busy || targets.length <= 1}
            >
              Kaldır
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>5. Çevir ve indir</h2>
        <button
          type="button"
          className="btn btn-primary"
          onClick={runTranslate}
          disabled={busy || !data.length}
        >
          {busy ? 'Çevriliyor…' : 'Çevir ve Excel indir'}
        </button>
        {busy && (
          <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.5rem' }} onClick={cancel}>
            İptal
          </button>
        )}
        {busy && progress.total > 0 && (
          <div className="progress-wrap">
            <div className="progress-bar">
              <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
            <div className="progress-text">
              {progress.done} / {progress.total} çeviri
            </div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <p className="note">
          Çeviri OpenAI API ile yapılır; anahtar tarayıcıda (sessionStorage) saklanır, yalnızca sizin
          bilgisayarınızda kalır. Geliştirme: <code>npm run dev</code>. Derlenmiş sürüm:{' '}
          <code>npm run build</code> sonra <code>npm start</code> (port 3000).{' '}
          <code>vite preview</code> OpenAI proxy içermez. İndirilen dosya:{' '}
          <strong>orijinalad_cevirilmis.xlsx</strong>
        </p>
      </div>
    </div>
  );
}
