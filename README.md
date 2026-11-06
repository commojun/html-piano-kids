# html-piano-kids

シンプルなHTMLピアノ (どれみ ぴあの)。小さな こども向けの、ブラウザだけで動く 1 オクターブの ピアノです。

**あそぶ**: https://commojun.github.io/html-piano-kids/

- 鍵盤を さわると その音が 鳴ります (音は Web Audio で その場で 合成)
- 右上の ボタンで モードが 変わります
  - おと: ピアノの 音だけ
  - ことば: 「どんぐり」(ド)「れもん」(レ)… を その鍵盤の 高さで 言います
  - おんめい: 「ど」「れ」「み」… を その鍵盤の 高さで 歌います
- 最初の 画面の ▶ を さわると 始まります (iPad / iPhone で 音を 出すため)
- iPad の ホーム画面に 追加すると アプリのように 使えます

## ファイル

- `index.html` … ピアノ本体
- `common/kit.js` / `common/base.css` … 音の 合成・読み上げ・タップでスタート などの 共通部品
- `sounds/*.mp3` … 「ことば」「おんめい」モードの 声

## クレジット

`sounds/*.mp3` の 声は 音声合成で 作りました。

- 音声合成: [Open JTalk](https://open-jtalk.sourceforge.net/) (Modified BSD License)
- 声: HTS Voice "Mei" — Copyright (c) 2009-2018 Nagoya Institute of Technology, Department of Computer Science.
  Released by MMDAgent Project Team (http://www.mmdagent.jp/).
  Licensed under [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
- 加工: WORLD (pyworld) で 声の 高さを 各音 (ド = C4 〜 C5) に 合わせ、伸ばしました

絵文字は 各端末の 絵文字フォントで 表示されます。
