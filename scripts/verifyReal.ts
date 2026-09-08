/** 実スキャン画像の解析と切り出し領域を数値のみで報告する（画像内容は出力しない）。 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { analyzeImage } from '@worker/analyze';
import { createDetectionProxy, readHeader } from '@worker/imageIo';
import { detectCard } from '@worker/detector';
import { cropQuad } from '@core/standards/officialCrop';
import { resolvePlacement } from '@core/layout/placement';
import { quadToArray, warpTargetSize } from '@core/geometry/quad';
import { normalizeDpi } from '@core/dpi/dpi';

const dir = process.env.SCAN_DIR!;
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|tiff?)$/i.test(f)).sort();

for (const [i, name] of files.entries()) {
  const label = `画像${i + 1}`;
  const file = path.join(dir, name);
  const a = await analyzeImage({ id: label, filePath: file, relativePath: label });
  const img = a.image;
  console.log(
    `\n${label}: ${img.status} conf=${img.confidence?.toFixed(3)} 除外=${img.exclusion ?? 'なし'} 警告=${img.warnings.join(',') || 'なし'}`,
  );
  if (!img.cardSizeMm || !a.quad) continue;

  const header = await readHeader(file);
  const dpi = normalizeDpi(header.density).effectiveDpi;
  const placement = resolvePlacement(img.cardSizeMm, 'idCard');
  const quad = cropQuad(a.quad, placement.cropSizeMm, dpi);
  const pts = quadToArray(quad);
  const x0 = Math.min(...pts.map((p) => p.x)),
    x1 = Math.max(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y)),
    y1 = Math.max(...pts.map((p) => p.y));

  // 検出された券面の範囲（縁検出そのままの実測）
  const proxy = await createDetectionProxy(file);
  const det = await detectCard(proxy, proxy.scaleToOriginal);
  const dp = quadToArray(det.quad!);
  const dx0 = Math.min(...dp.map((p) => p.x)),
    dx1 = Math.max(...dp.map((p) => p.x));
  const dy0 = Math.min(...dp.map((p) => p.y)),
    dy1 = Math.max(...dp.map((p) => p.y));
  const measured = warpTargetSize(det.quad!);

  const mm = (px: number) => (px / dpi) * 25.4;
  const f = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
  console.log(
    `  券面(規格値) ${img.cardSizeMm.widthMm} x ${img.cardSizeMm.heightMm} mm / 縁検出の実測 ${mm(measured.width).toFixed(1)} x ${mm(measured.height).toFixed(1)} mm`,
  );
  console.log(
    `  タイル(=セル) ${placement.sizeMm.widthMm.toFixed(1)} x ${placement.sizeMm.heightMm.toFixed(1)} mm`,
  );
  console.log(`  切り出し範囲 ${mm(x1 - x0).toFixed(1)} x ${mm(y1 - y0).toFixed(1)} mm`);
  console.log(
    `  縁検出の券面に対する余裕: 上=${f(mm(dy0 - y0))} 下=${f(mm(y1 - dy1))} 左=${f(mm(dx0 - x0))} 右=${f(mm(x1 - dx1))} mm`,
  );
  const worst = Math.min(mm(dy0 - y0), mm(y1 - dy1), mm(dx0 - x0), mm(x1 - dx1));
  console.log(
    worst < 0
      ? `  >>> 見切れあり (${worst.toFixed(1)}mm)`
      : `  >>> 見切れなし（最小余裕 ${worst.toFixed(1)}mm）`,
  );
  console.log(
    `  画像外へのはみ出し: ${x0 < 0 || y0 < 0 || x1 > header.width || y1 > header.height ? 'あり（白で補完）' : 'なし'}`,
  );
}
