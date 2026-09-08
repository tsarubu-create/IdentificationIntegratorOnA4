/** 実スキャン画像の解析結果を数値のみで報告する（画像内容は出力しない）。 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { analyzeImage } from '@worker/analyze';

const dir = process.env.SCAN_DIR!;
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|tiff?)$/i.test(f)).sort();

for (const [i, name] of files.entries()) {
  const label = `画像${i + 1}`;
  const a = await analyzeImage({ id: label, filePath: path.join(dir, name), relativePath: label });
  const img = a.image;
  console.log(`${label}: ${img.status} conf=${img.confidence?.toFixed(3)} 除外=${img.exclusion ?? 'なし'} 警告=${img.warnings.join(',') || 'なし'}`);
  if (img.cardSizeMm) {
    console.log(`  券面 ${img.cardSizeMm.widthMm} x ${img.cardSizeMm.heightMm} mm / 配置枠 ${img.physicalSize!.widthMm.toFixed(1)} x ${img.physicalSize!.heightMm.toFixed(1)} mm`);
  }
}
