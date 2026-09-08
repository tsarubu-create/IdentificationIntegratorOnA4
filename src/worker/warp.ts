/**
 * 透視変換による切り出し（仕様書 §5）。
 *
 * 入力は必ず「カード外接矩形だけを原寸で切り出したもの」。ページ全体を渡さない。
 */

import { MAX_WASM_MAT_PX } from '@shared/limits';
import type { Quad } from '@shared/types';
import { quadToArray, warpTargetSize } from '@core/geometry/quad';
import type { RawImage } from '@worker/imageIo';
import { type OpenCv, cvConstant, loadOpenCv, withMats } from '@worker/opencv';

/**
 * 四隅で囲まれた領域を、正面から見た矩形へ変換して取り出す。
 *
 * @param crop 原寸から切り出した領域（RGB）
 * @param quadInCrop `crop` の左上を原点とする座標系での四隅
 * @throws 入力が WASM へ渡せる上限を超える場合
 */
export async function warpQuad(crop: RawImage, quadInCrop: Quad): Promise<RawImage> {
  const inputPixels = crop.width * crop.height;
  if (inputPixels > MAX_WASM_MAT_PX) {
    // 原寸全体を渡してしまう実装ミスを、実行時にも検出できるようにしておく。
    throw new RangeError(
      `透視変換の入力が上限を超えています: ${inputPixels} px > ${MAX_WASM_MAT_PX} px`,
    );
  }

  const cv = await loadOpenCv();
  const target = warpTargetSize(quadInCrop);

  return withMats((track) => {
    const source = track(new cv.Mat(crop.height, crop.width, cv.CV_8UC3));
    source.data.set(crop.data);

    const sourcePoints = track(
      cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        quadToArray(quadInCrop).flatMap((p) => [p.x, p.y]),
      ),
    );
    const targetPoints = track(
      cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        // 出力も 左上 -> 右上 -> 右下 -> 左下 の順に対応させる。
        [0, 0, target.width - 1, 0, target.width - 1, target.height - 1, 0, target.height - 1],
      ),
    );

    const transform = track(cv.getPerspectiveTransform(sourcePoints, targetPoints));
    const destination = track(new cv.Mat());

    cv.warpPerspective(
      source,
      destination,
      transform,
      new cv.Size(target.width, target.height),
      cvConstant(cv.INTER_LINEAR, 'INTER_LINEAR'),
      cvConstant(cv.BORDER_REPLICATE, 'BORDER_REPLICATE'),
      new cv.Scalar(255, 255, 255, 255),
    );

    // Mat のバッファは WASM ヒープ上にあるため、解放前に JS 側へコピーする。
    return {
      data: Buffer.from(destination.data),
      width: destination.cols,
      height: destination.rows,
      channels: 3,
    } satisfies RawImage;
  });
}

/**
 * 画像を 90 度回転する（パスポート見開き用、仕様書 §7.3）。
 *
 * OpenCV の `rotate` は補間を伴わない厳密な転置なので、画質を落とさない。
 */
export async function rotate90(image: RawImage): Promise<RawImage> {
  const cv = await loadOpenCv();

  return withMats((track) => {
    const source = track(new cv.Mat(image.height, image.width, cv.CV_8UC3));
    source.data.set(image.data);

    const destination = track(new cv.Mat());
    cv.rotate(source, destination, cvConstant(cv.ROTATE_90_CLOCKWISE, 'ROTATE_90_CLOCKWISE'));

    return {
      data: Buffer.from(destination.data),
      width: destination.cols,
      height: destination.rows,
      channels: 3,
    } satisfies RawImage;
  });
}

/** `OpenCv` 型を再輸出しておく（テストからモックを差し込みやすくするため）。 */
export type { OpenCv };
