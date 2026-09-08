/** 手動確認用の入力画像を生成する（合成画像のみ）。 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { syntheticBlank, syntheticScan, corruptImageBytes } from '../tests/fixtures/synthetic';

const dir = process.env.FIXTURE_DIR ?? path.resolve('fixture-input');
await rm(dir, { recursive: true, force: true });
await mkdir(path.join(dir, 'sub'), { recursive: true });

const colors = ['#2f6fb2', '#b25f2f', '#3f8f5f', '#8f3f7f', '#2f8f8f'];
for (let i = 0; i < 5; i += 1) {
  await writeFile(
    path.join(dir, `card_${String(i + 1).padStart(2, '0')}.png`),
    await syntheticScan({
      canvasWidth: 1600,
      canvasHeight: 1200,
      cardWidth: 1011,
      cardHeight: 638,
      cardColor: colors[i] ?? '#2f6fb2',
      rotationDeg: i * 2,
      density: 300,
    }),
  );
}
// DPI 情報なし（300dpi として配置される）
await writeFile(
  path.join(dir, 'sub', 'no_dpi.png'),
  await syntheticScan({
    canvasWidth: 1600,
    canvasHeight: 1200,
    cardWidth: 1011,
    cardHeight: 638,
    density: null,
  }),
);
// 150dpi -> 実寸が大きすぎてセル超過で除外
await writeFile(
  path.join(dir, 'sub', 'too_big.png'),
  await syntheticScan({
    canvasWidth: 1600,
    canvasHeight: 1200,
    cardWidth: 1011,
    cardHeight: 638,
    density: 150,
  }),
);
// パスポート見開き相当
await writeFile(
  path.join(dir, 'passport.png'),
  await syntheticScan({
    canvasWidth: 2400,
    canvasHeight: 1800,
    cardWidth: 2079,
    cardHeight: 1476,
    cardColor: '#1f4f7f',
    density: 300,
  }),
);
// 検出不能
await writeFile(path.join(dir, 'blank.png'), await syntheticBlank());
// 破損ファイル
await writeFile(path.join(dir, 'broken.png'), corruptImageBytes());
// 対象外拡張子
await writeFile(path.join(dir, 'notes.txt'), 'not an image');

console.log('fixtures created at', dir);
