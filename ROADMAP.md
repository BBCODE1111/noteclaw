# NoteClaw 分階段規格與驗收

## 產品定位

Mac-first Guitar Pro 相容譜面編輯器，重點是 TAB、快讀、快改、錄製/練習，不複製 Guitar Pro 的品牌或原有 UI。

## Phase 1（本次 0.1 版）

- alphaTab 多版本匯入與視覺化（**需 Mac 實機確認**）
- 導入 / 試聽 / 簡單修改 / GP 保存、MIDI 保存
- 使用 AlphaTex 建立多小節新曲譜
- 單音 DI 追蹤 + 錄後量化 + 自動指法
- 單元測試 / Mac 雙擊啟動腳本

## Phase 2 — 真正完整編輯器

- 具 Undo stack、measure validator 的 Note / Beat / Bar / Track CRUD
- 支援 Copy Paste、切分/合併時值、連音與休止符、自動補齊小節
- 專屬節奏輸入欄（1/4、1/8、1/16、Triplet、Dot）
- 奏法：Bend、Vibrato、Slide、Hammer/Pull、Palm Mute、Harmonics
- 同音高多指法選項、整段左手轉位 cost function 調整
- 連續譜面修正與資料模型完整 revalidation
- 針對 GP3/5/6/8 匯入再匯出的回歸檔案測試

## Phase 3 — 樂器演奏記譜

- Record take waveform + BPM 自動估計、onset detection / beat-grid
- Basic Pitch 離線模型、輸入吉他 DI 的多音辨識
- 跨弦、和弦 voicing、技巧標記、錄製信心度
- 顯示 AI 提議的候選 TAB，人工確認後才寫譜
- RME TotalMix / Apollo 多通道選擇、Loopback 管理

## Phase 4 — macOS App

- Tauri 或 Electron 包裝、簽署/公證 .app
- Finder `.gp` 關聯、原生選檔與最近開啟列表
- 音訊設備設定、硬體輸入／延遲校正、Auto-save
- 連 Logic 的 Audio Unit helper（不直接取代 Piano Roll）

## 定義成功

- 譜檔拖入 < 3 秒顯示（小型譜，Mac M2 Pro 測）
- GP 導入→改一音→匯出→重讀，音高/格數/節奏符合預期
- 單音 DI 錄 8 小節，記譜正確率與人工修改量可記錄，未達品質門檻不宣稱全自動準確
- 整曲 32 小節可流暢播放與變速
- 不需上傳錄音／第三方 API 即可操作核心功能
