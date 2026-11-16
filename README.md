# NoteClaw

給吉他手的六線譜編輯器：打開 Guitar Pro 譜、直接在譜上改、播放練習，還能把你彈的、錄的、AI 寫的東西直接變成可以編輯的譜。所有處理都在你自己的電腦上進行，不上傳任何聲音或譜。

目前版本：**v0.4（開發中）**。功能清單與已知限制見 [STATUS.md](STATUS.md)，規劃見 [ROADMAP.md](ROADMAP.md)。

## 能做什麼

- **開譜**：Guitar Pro 3–8（.gp3 .gp4 .gp5 .gpx .gp）、MusicXML、MIDI、AlphaTex、NoteClaw 專案檔（.noteclaw）
- **改譜**：點譜面放游標、直接打格數；點線外選整拍、⇧ 選一段，複製貼上；時值、附點、三連音、休止；推弦、搥勾、滑弦、揉弦、悶音、泛音等技巧；簡譜數字輸入；鼓組輸入；多軌、換音色
- **顯示**：六線譜、五線譜、簡譜任意搭配；拍數不對的小節標紅
- **練習**：播放游標跟著捲動、變速、A/B 小節循環、節拍器、預備拍
- **彈奏轉譜**：吉他或貝斯接音效卡，單音旋律（含推弦、揉弦、連音）或和弦、鋼琴等多音；「隨時記下」把剛剛彈的寫成譜；也可以匯入錄好的音訊檔
- **MIDI 轉譜**：所有軌道匯入、和弦挑出按得到的指型、自動判斷調性
- **匯出**：Guitar Pro（.gp）、MIDI、AlphaTex、PDF、PNG、去背 PNG

## 在 Mac 上執行

需要 [Node.js](https://nodejs.org/) 20 以上。

```bash
npm install
npm run dev
```

然後用 Chrome 開 <http://127.0.0.1:5173>（錄音功能需要 Chrome 才能選到音效卡）。也可以雙擊 `run.command`，第一次會自動安裝需要的套件。

開發用指令：

```bash
npm test            # 自動測試
npm run typecheck   # TypeScript 型別檢查
npm run build       # 產生正式版到 dist/
node tools/analyze-wav.mjs 錄音.wav --bpm 80   # 離線分析一段錄音，調整轉譜時用
```

## 專案結構

| 位置 | 內容 |
|---|---|
| `src/editor/` | 編輯器：游標、選取、復原重做（`editor.ts`）與所有譜面修改（`ops.ts`） |
| `src/audio/` | 錄音與轉譜：單音分析（`analysis.js`）、錄音（`recorder.js`）、多音模型（`poly.js`） |
| `src/io/` | 存檔、匯出 GP／專案檔（`files.ts`）、PDF 與圖片（`image-export.js`） |
| `src/ui/` | 側欄、錄音頁、圖示、樂器清單 |
| `src/fingering.js`、`src/poly-score.js` | 指法演算法、和弦指型、把音符寫成譜 |
| `src/midi-import.js` | MIDI 匯入與調性判斷 |
| `tests/` | 自動測試（`npm test`） |
| `public/brand/` | Logo 檔案放這裡 |

## 使用的開源專案

- [alphaTab](https://github.com/CoderLine/alphaTab)（MPL-2.0）：譜面讀取、顯示與播放
- [Basic Pitch](https://github.com/spotify/basic-pitch-ts)（Apache-2.0）：多音轉譜模型，透過 TensorFlow.js 在本機執行
- [jsPDF](https://github.com/parallax/jsPDF)（MIT）：PDF 匯出

NoteClaw 與 Guitar Pro / Arobas Music 沒有任何關係；Guitar Pro 是其所有者的商標，這裡只是說明可以讀寫它的檔案格式。
