# Excel Çeviri (OpenAI) — Render/Railway Deploy

Excel dosyası yükleyip bir sütundaki metinleri seçtiğiniz dillere çevirir, yeni sütunlara yazar ve tekrar Excel indirmenizi sağlar.

## Lokal

```powershell
cd c:\Users\Bremer\ceviri
npm install
npm run dev
```

## Production (Express)

```powershell
npm run build
npm start
```

Sunucu `PORT` env varsa onu kullanır (yoksa `3000`).

## GitHub’a yükleme

```powershell
cd c:\Users\Bremer\ceviri
git status
git add .
git commit -m "docs: add deploy guide"
git remote add origin <REPO_URL>
git push -u origin master
```

## Render (en hızlı)

- **New → Web Service**
- Repo’yu seç
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`
- Render otomatik `PORT` verir
- Deploy sonrası verilen URL’den aç

## Railway (en hızlı)

- **New Project → Deploy from GitHub Repo**
- İlk deploy için genelde ekstra ayar gerekmez
- Gerekirse:
  - **Build**: `npm run build`
  - **Start**: `npm start`

## Notlar

- Uygulama OpenAI isteğini `/openai` üzerinden **sunucu proxy** ile yapar.
- OpenAI API anahtarı şu an tarayıcıda girilir (sessionStorage). Production için daha güvenli yapı: anahtarı sunucuda env olarak tutup istemciden kaldırmak (istersen ekleyebilirim).

